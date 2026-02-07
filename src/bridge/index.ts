/**
 * Bridge mode for ccbox.
 *
 * Provides a control interface on the host while Claude Code runs in
 * Docker containers. Features:
 * - Multi-container discovery and navigation
 * - Session listing per container
 * - Voice input and clipboard paste to sessions
 * - Container stop/new/quit shortcuts
 * - Differential rendering (no flicker)
 * - Periodic refresh (5s)
 *
 * Input files are written to .claude/input/ via bind mount.
 *
 * Dependency direction:
 *   This module imports from: docker-utils, paths, exec, logger, platform, constants
 *   It should NOT import from: cli, generator
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

import { exec } from "../exec.js";
import { log, style } from "../logger.js";
import { resolveForDocker, getDockerEnv } from "../paths.js";
import { DOCKER_COMMAND_TIMEOUT } from "../constants.js";
import {
  findRunningContainers,
  stopContainer,
  extractProjectName,
} from "../docker-utils.js";
import { openContainerTerminal } from "./terminal.js";

// ─── Types ───────────────────────────────────────────────────────────────────

/** Session information (RAM-based, no file writes). */
export interface SessionInfo {
  id: string;
  startedAt: Date;
  projectDir: string;
}

/** Container with its sessions. */
interface ContainerInfo {
  name: string;
  status: string;
  projectName: string;
  sessions: SessionInfo[];
}

/** Flat navigation item - either a container header or a session row. */
type FlatNavItem =
  | { type: "container"; container: ContainerInfo }
  | { type: "session"; session: SessionInfo; container: ContainerInfo };

/** Bridge state (all in memory). */
interface BridgeState {
  projectPath: string;
  projectName: string;
  inputDir: string;
  containers: ContainerInfo[];
  flatItems: FlatNavItem[];
  currentIndex: number;
  isRunning: boolean;
  isPrompting: boolean;
  refreshTimer: ReturnType<typeof setInterval> | null;
  lastRender: string;
  statusMessage: string;
}

/** Bridge options. */
export interface BridgeOptions {
  path?: string;
  containerName?: string;
  skipContainerLaunch?: boolean;
  ccboxArgs?: string[];
}

// ─── Constants ───────────────────────────────────────────────────────────────

const REFRESH_INTERVAL_MS = 5000;

// ─── State Management ────────────────────────────────────────────────────────

function createBridgeState(projectPath: string): BridgeState {
  const absPath = resolve(projectPath);
  const projectName = basename(absPath);
  const inputDir = join(absPath, ".claude", "input");

  return {
    projectPath: absPath,
    projectName,
    inputDir,
    containers: [],
    flatItems: [],
    currentIndex: 0,
    isRunning: false,
    isPrompting: false,
    refreshTimer: null,
    lastRender: "",
    statusMessage: "",
  };
}

/** Build flat navigation list from containers and their sessions. */
function buildFlatItems(containers: ContainerInfo[]): FlatNavItem[] {
  const items: FlatNavItem[] = [];
  for (const container of containers) {
    items.push({ type: "container", container });
    for (const session of container.sessions) {
      items.push({ type: "session", session, container });
    }
  }
  return items;
}

/** Ensure input directory and .processed subdirectory exist. */
function ensureInputDir(state: BridgeState): void {
  if (!existsSync(state.inputDir)) {
    mkdirSync(state.inputDir, { recursive: true });
  }
  const processedDir = join(state.inputDir, ".processed");
  if (!existsSync(processedDir)) {
    mkdirSync(processedDir, { recursive: true });
  }
}

// ─── Session Discovery ───────────────────────────────────────────────────────

/**
 * Discover active sessions for this project from a container.
 *
 * Sessions are stored in ~/.claude/projects/<encoded-path>/*.jsonl
 * Uses batched stat for efficiency (single docker exec call).
 */
async function discoverSessions(containerName: string, projectPath: string): Promise<SessionInfo[]> {
  if (!containerName) {return [];}

  try {
    const dockerPath = resolveForDocker(resolve(projectPath));
    const hostPath = dockerPath.replace(/^([A-Za-z]):/, (_, d: string) => `/${d.toLowerCase()}`);
    const encodedPath = hostPath.replace(/[:/\\. ]/g, "-");

    // List session files
    const result = await exec("docker", [
      "exec", containerName,
      "bash", "-c",
      `ls -t /ccbox/.claude/projects/${encodedPath}/*.jsonl 2>/dev/null | head -5`,
    ], { timeout: DOCKER_COMMAND_TIMEOUT, env: getDockerEnv() });

    if (result.exitCode !== 0 || !result.stdout.trim()) {return [];}

    const files = result.stdout.trim().split("\n").filter(Boolean);
    if (files.length === 0) {return [];}

    // Batch stat call - single docker exec for all files
    const statCmd = files.map(f => `stat -c '%Y' '${f}' 2>/dev/null || echo 0`).join("; ");
    const statResult = await exec("docker", [
      "exec", containerName,
      "bash", "-c", statCmd,
    ], { timeout: DOCKER_COMMAND_TIMEOUT, env: getDockerEnv() });

    const timestamps = statResult.stdout.trim().split("\n");
    const sessions: SessionInfo[] = [];

    for (let i = 0; i < files.length; i++) {
      const file = files[i]!;
      const filename = basename(file, ".jsonl");
      const id = filename.slice(0, 6);
      const ts = parseInt(timestamps[i] ?? "0", 10) * 1000;
      const startedAt = new Date(isNaN(ts) || ts === 0 ? Date.now() : ts);

      sessions.push({ id, startedAt, projectDir: hostPath });
    }

    return sessions;
  } catch {
    return [];
  }
}

// ─── Rendering ───────────────────────────────────────────────────────────────

/** Format time as HH:MM. */
function formatTime(date: Date): string {
  return date.toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" });
}

/**
 * Render the bridge UI with differential rendering.
 *
 * Uses cursor-home + write + clear-rest instead of full-clear
 * to eliminate flicker. Skips render if output is unchanged.
 */
function renderUI(state: BridgeState): void {
  const lines: string[] = [];

  // Header
  const hasContainers = state.containers.length > 0;
  const statusIcon = hasContainers ? style.green("\u25CF") : style.yellow("\u25CB");
  lines.push(` ${statusIcon} ${style.bold("ccbox")} ${style.dim("\u2014")} ${state.projectName}`);

  if (!hasContainers) {
    lines.push(`   ${style.dim("No containers running")}`);
  } else {
    lines.push(""); // blank line after header

    // Flat list rendering
    for (let i = 0; i < state.flatItems.length; i++) {
      const item = state.flatItems[i]!;
      const isCurrent = i === state.currentIndex;

      if (item.type === "container") {
        const c = item.container;
        const marker = isCurrent ? style.cyan("\u25B8") : " ";
        lines.push(`   ${marker} ${style.bold(c.name)}  ${style.dim(c.status)}`);
      } else {
        const s = item.session;
        const marker = isCurrent ? style.cyan("\u25B8") : " ";
        const time = style.dim(formatTime(s.startedAt));
        lines.push(`     ${marker} ${s.id}  ${time}`);
      }
    }
  }

  // Status message line
  if (state.statusMessage) {
    lines.push("");
    lines.push(` ${style.dim(">")} ${state.statusMessage}`);
  }

  // Controls
  lines.push("");
  if (hasContainers) {
    lines.push(
      ` ${style.dim("v")} voice  ${style.dim("p")} paste  ` +
      `${style.dim("n")} new  ${style.dim("s")} stop  ${style.dim("q")} quit`
    );
  } else {
    lines.push(` ${style.dim("n")} new  ${style.dim("q")} quit`);
  }
  lines.push(""); // trailing newline for clean display

  const output = lines.join("\n");

  // Differential rendering: skip if unchanged
  if (output === state.lastRender) {return;}
  state.lastRender = output;

  // Cursor home + write + clear rest (no full-screen clear)
  process.stdout.write("\x1B[H" + output + "\x1B[J");
}

// ─── Data Refresh ────────────────────────────────────────────────────────────

/** Refresh container and session data. Returns true if data changed. */
async function refreshData(state: BridgeState): Promise<boolean> {
  const dockerContainers = await findRunningContainers();

  const containers: ContainerInfo[] = [];
  for (const dc of dockerContainers) {
    const sessions = await discoverSessions(dc.name, state.projectPath);
    containers.push({
      name: dc.name,
      status: dc.status,
      projectName: extractProjectName(dc.name),
      sessions,
    });
  }

  // Check if data changed (simple JSON comparison)
  const newJson = JSON.stringify(containers.map(c => ({
    name: c.name,
    status: c.status,
    sessions: c.sessions.map(s => s.id),
  })));
  const oldJson = JSON.stringify(state.containers.map(c => ({
    name: c.name,
    status: c.status,
    sessions: c.sessions.map(s => s.id),
  })));

  if (newJson === oldJson) {return false;}

  state.containers = containers;
  state.flatItems = buildFlatItems(containers);

  // Clamp currentIndex if list shrank
  if (state.flatItems.length === 0) {
    state.currentIndex = 0;
  } else if (state.currentIndex >= state.flatItems.length) {
    state.currentIndex = state.flatItems.length - 1;
  }

  return true;
}

/** Start periodic refresh timer. */
function startRefreshTimer(state: BridgeState): void {
  if (state.refreshTimer) {return;}

  state.refreshTimer = setInterval(async () => {
    if (state.isPrompting || !state.isRunning) {return;}

    const changed = await refreshData(state);
    if (changed) {renderUI(state);}
  }, REFRESH_INTERVAL_MS);
}

/** Stop periodic refresh timer. */
function stopRefreshTimer(state: BridgeState): void {
  if (state.refreshTimer) {
    clearInterval(state.refreshTimer);
    state.refreshTimer = null;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Get the container that owns the currently selected flat item. */
function getSelectedContainer(state: BridgeState): ContainerInfo | null {
  const item = state.flatItems[state.currentIndex];
  if (!item) {return null;}
  return item.type === "container" ? item.container : item.container;
}

/** Get the session for the currently selected flat item. Falls back to first session of container. */
function getSelectedSession(state: BridgeState): { session: SessionInfo; container: ContainerInfo } | null {
  const item = state.flatItems[state.currentIndex];
  if (!item) {return null;}

  if (item.type === "session") {
    return { session: item.session, container: item.container };
  }

  // On container header - use first session if available
  if (item.container.sessions.length > 0) {
    return { session: item.container.sessions[0]!, container: item.container };
  }

  return null;
}

/** Write input file to .claude/input/ directory. */
function writeInputFile(state: BridgeState, content: string | Buffer, type: "paste" | "voice", ext: string): string {
  ensureInputDir(state);
  const timestamp = Date.now();
  const filename = `${type}-${timestamp}.${ext}`;
  const filepath = join(state.inputDir, filename);
  writeFileSync(filepath, content);
  return filename;
}

/** Build ccbox command for launching container. */
function buildCcboxCommand(projectPath: string, extraArgs: string[]): string {
  const args = ["ccbox", "--attach-mode", `--path "${projectPath}"`];
  if (extraArgs.length > 0) {
    args.push(...extraArgs);
  }
  return args.join(" ");
}

/** Set status message and re-render. */
function setStatus(state: BridgeState, message: string): void {
  const time = formatTime(new Date());
  state.statusMessage = `${style.dim(time)} ${message}`;
  renderUI(state);
}

// ─── Action Handlers ─────────────────────────────────────────────────────────

/** Handle 'n' - open new session in new terminal. */
async function handleNewSession(state: BridgeState, ccboxArgs: string[]): Promise<void> {
  const cmd = buildCcboxCommand(state.projectPath, ccboxArgs);
  setStatus(state, "Opening new session...");
  await openContainerTerminal(cmd);
  setStatus(state, "New session launched");
}

/** Handle 's' - stop the container of the selected item. */
async function handleStopContainer(state: BridgeState): Promise<void> {
  const container = getSelectedContainer(state);
  if (!container) {
    setStatus(state, style.yellow("No container selected"));
    return;
  }

  setStatus(state, `Stopping ${container.name}...`);
  const ok = await stopContainer(container.name);

  if (ok) {
    // Remove from state immediately
    state.containers = state.containers.filter(c => c.name !== container.name);
    state.flatItems = buildFlatItems(state.containers);
    if (state.flatItems.length === 0) {
      state.currentIndex = 0;
    } else if (state.currentIndex >= state.flatItems.length) {
      state.currentIndex = state.flatItems.length - 1;
    }
    setStatus(state, `Stopped ${container.name}`);
  } else {
    setStatus(state, style.red(`Failed to stop ${container.name}`));
  }
}

/** Handle 'v' - voice input to selected session. */
async function handleVoice(state: BridgeState): Promise<void> {
  const target = getSelectedSession(state);
  if (!target) {
    setStatus(state, style.yellow("No session available"));
    return;
  }

  const { voicePipelineBridge } = await import("../voice.js");

  setStatus(state, "Recording... (Enter to stop)");

  const text = await voicePipelineBridge();
  if (!text) {
    setStatus(state, style.yellow("No audio captured"));
    return;
  }

  const filename = writeInputFile(state, text, "voice", "txt");
  setStatus(state, `Voice \u2192 ${target.session.id}: ${filename}`);
}

/** Handle 'p' - paste clipboard to selected session. */
async function handlePaste(state: BridgeState): Promise<void> {
  const target = getSelectedSession(state);
  if (!target) {
    setStatus(state, style.yellow("No session available"));
    return;
  }

  const { readClipboardForBridge } = await import("../clipboard.js");

  setStatus(state, "Reading clipboard...");

  const result = await readClipboardForBridge();
  if (!result) {
    setStatus(state, style.yellow("Clipboard empty or unsupported format"));
    return;
  }

  const ext = result.type === "image" ? "png" : "txt";
  const filename = writeInputFile(state, result.content, "paste", ext);
  setStatus(state, `Paste (${result.type}) \u2192 ${target.session.id}: ${filename}`);
}

/** Handle 'q' - quit bridge with optional container stop. */
async function handleQuit(state: BridgeState): Promise<void> {
  state.isPrompting = true;

  // Exit raw mode for readline prompt
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(false);
  }

  try {
    if (state.containers.length > 0) {
      const readline = require("readline");
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      const answer = await new Promise<string>((resolve) => {
        rl.question("Container'lar\u0131 da kapatmak ister misiniz? [y/N]: ", (ans: string) => {
          rl.close();
          resolve(ans);
        });
      });

      if (answer.toLowerCase() === "y") {
        log.dim("Stopping containers...");
        await Promise.all(state.containers.map(c => stopContainer(c.name)));
        log.dim("Containers stopped.");
      } else {
        log.dim("Bridge closing, containers continue running.");
      }
    }
  } finally {
    state.isRunning = false;
    stopRefreshTimer(state);
    process.exit(0);
  }
}

// ─── Keyboard Setup ──────────────────────────────────────────────────────────

/** Setup raw mode keyboard input with safety handlers. */
function setupKeyboard(state: BridgeState, onKey: (key: string) => void): void {
  const readline = require("readline");
  readline.emitKeypressEvents(process.stdin);

  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }

  // Safety: restore raw mode on exit
  const restoreTerminal = () => {
    if (process.stdin.isTTY) {
      try { process.stdin.setRawMode(false); } catch { /* ignore */ }
    }
  };

  process.on("exit", restoreTerminal);
  process.on("SIGINT", () => { restoreTerminal(); process.exit(0); });
  process.on("SIGTERM", () => { restoreTerminal(); process.exit(0); });

  process.stdin.on("keypress", (_str: string, key: { name?: string; ctrl?: boolean }) => {
    if (!state.isRunning) {return;}

    // Ctrl+C - force quit (always allowed)
    if (key.ctrl && key.name === "c") {
      restoreTerminal();
      stopRefreshTimer(state);
      state.isRunning = false;
      process.exit(0);
    }

    // Suppress while prompting or for ctrl/unknown keys
    if (state.isPrompting || key.ctrl || !key.name) {return;}

    onKey(key.name);
  });

  process.stdin.resume();
}

// ─── Interactive Loop ────────────────────────────────────────────────────────

/** Run the interactive keyboard loop. */
async function runInteractiveLoop(state: BridgeState, ccboxArgs: string[]): Promise<void> {
  setupKeyboard(state, (keyName: string) => {
    switch (keyName) {
      case "up":
        if (state.flatItems.length > 0) {
          state.currentIndex = (state.currentIndex - 1 + state.flatItems.length) % state.flatItems.length;
          renderUI(state);
        }
        break;

      case "down":
        if (state.flatItems.length > 0) {
          state.currentIndex = (state.currentIndex + 1) % state.flatItems.length;
          renderUI(state);
        }
        break;

      case "n":
        handleNewSession(state, ccboxArgs);
        break;

      case "s":
        handleStopContainer(state);
        break;

      case "v":
        handleVoice(state);
        break;

      case "p":
        handlePaste(state);
        break;

      case "q":
        handleQuit(state);
        break;

      // Unrecognized keys silently ignored
    }
  });

  // Initial render
  renderUI(state);

  // Start periodic refresh
  startRefreshTimer(state);

  // Keep process alive until quit
  await new Promise<void>((resolve) => {
    const check = setInterval(() => {
      if (!state.isRunning) {
        clearInterval(check);
        resolve();
      }
    }, 100);
  });

  // Cleanup
  stopRefreshTimer(state);
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(false);
  }
}

// ─── Entry Point ─────────────────────────────────────────────────────────────

/**
 * Main bridge mode entry point.
 */
export async function runBridgeMode(options: BridgeOptions = {}): Promise<void> {
  const projectPath = options.path ?? ".";
  const state = createBridgeState(projectPath);
  const ccboxArgs = options.ccboxArgs ?? [];

  // Ensure input directory exists
  ensureInputDir(state);

  // Clear screen once at startup
  process.stdout.write("\x1B[2J\x1B[H");

  // Initial render (no containers yet)
  renderUI(state);

  // Find existing containers
  await refreshData(state);
  renderUI(state);

  // Launch container in new terminal if none running
  if (!options.skipContainerLaunch && state.containers.length === 0) {
    const cmd = buildCcboxCommand(state.projectPath, ccboxArgs);
    await openContainerTerminal(cmd);

    // Poll for container to appear
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 1000));
      const changed = await refreshData(state);
      if (changed && state.containers.length > 0) {
        renderUI(state);
        break;
      }
    }
  }

  // Start the interactive loop
  state.isRunning = true;
  await runInteractiveLoop(state, ccboxArgs);
}
