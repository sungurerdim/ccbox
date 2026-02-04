/**
 * Bridge mode for ccbox.
 *
 * Bridge mode provides a control interface that runs on the host while
 * Claude Code runs in a separate terminal. Features:
 * - Session discovery and switching (arrow keys)
 * - Clipboard paste (P key)
 * - Voice input (V key)
 * - Graceful shutdown (Q key)
 *
 * Input files are written to .claude/input/ via bind mount - no docker cp needed.
 *
 * Dependency direction:
 *   This module imports from: platform.ts, exec.ts, logger.ts, paths.ts
 *   It should NOT import from: cli, generator
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

import { exec } from "./exec.js";
import { log, style } from "./logger.js";
import { detectHostPlatform, commandExists } from "./platform.js";
import { getDockerEnv, resolveForDocker } from "./paths.js";
import { DOCKER_COMMAND_TIMEOUT } from "./constants.js";
import { findRunningContainer } from "./docker-utils.js";

/** Session information (RAM-based, no file writes). */
export interface SessionInfo {
  id: string;
  startedAt: Date;
  projectDir: string;
}

/** Bridge state (all in memory). */
export interface BridgeState {
  projectPath: string;
  projectName: string;
  containerName: string;
  containerPid: number | null;
  inputDir: string;
  sessions: SessionInfo[];
  currentSessionIndex: number;
  isRunning: boolean;
  isSelectingSession: boolean;
}

/** Bridge options. */
export interface BridgeOptions {
  /** Project path */
  path?: string;
  /** Container name (auto-detect if not specified) */
  containerName?: string;
  /** Skip opening new terminal for container */
  skipContainerLaunch?: boolean;
  /** All ccbox options to pass through */
  ccboxArgs?: string[];
}

/** Create initial bridge state. */
function createBridgeState(projectPath: string): BridgeState {
  const absPath = resolve(projectPath);
  const projectName = basename(absPath);
  const inputDir = join(absPath, ".claude", "input");

  return {
    projectPath: absPath,
    projectName,
    containerName: "",
    containerPid: null,
    inputDir,
    sessions: [],
    currentSessionIndex: 0,
    isRunning: false,
    isSelectingSession: false,
  };
}

/** Ensure input directory exists. */
function ensureInputDir(state: BridgeState): void {
  if (!existsSync(state.inputDir)) {
    mkdirSync(state.inputDir, { recursive: true });
  }

  // Also ensure .processed subdirectory
  const processedDir = join(state.inputDir, ".processed");
  if (!existsSync(processedDir)) {
    mkdirSync(processedDir, { recursive: true });
  }
}

/**
 * Discover active sessions for this project from container.
 *
 * Sessions are stored in ~/.claude/projects/<encoded-path>/*.jsonl
 * We discover them by listing the directory inside the container.
 */
export async function discoverSessions(containerName: string, projectPath: string): Promise<SessionInfo[]> {
  if (!containerName) {
    return [];
  }

  try {
    // Get the encoded project path for session directory name
    const dockerPath = resolveForDocker(resolve(projectPath));
    const hostPath = dockerPath.replace(/^([A-Za-z]):/, (_, d: string) => `/${d.toLowerCase()}`);
    const encodedPath = hostPath.replace(/[:/\\. ]/g, "-");

    // List session files in container
    const result = await exec("docker", [
      "exec", containerName,
      "bash", "-c",
      `ls -t /ccbox/.claude/projects/${encodedPath}/*.jsonl 2>/dev/null | head -5`,
    ], { timeout: DOCKER_COMMAND_TIMEOUT, env: getDockerEnv() });

    if (result.exitCode !== 0 || !result.stdout.trim()) {
      return [];
    }

    const sessions: SessionInfo[] = [];
    const files = result.stdout.trim().split("\n").filter(Boolean);

    for (const file of files) {
      // Extract session ID from filename (e.g., abc123.jsonl -> abc123)
      const filename = basename(file, ".jsonl");
      const id = filename.slice(0, 6); // First 6 chars

      // Get file modification time
      const statResult = await exec("docker", [
        "exec", containerName,
        "stat", "-c", "%Y", file,
      ], { timeout: 5000, env: getDockerEnv() });

      const timestamp = parseInt(statResult.stdout.trim(), 10) * 1000;
      const startedAt = new Date(isNaN(timestamp) ? Date.now() : timestamp);

      sessions.push({
        id,
        startedAt,
        projectDir: hostPath,
      });
    }

    return sessions;
  } catch {
    return [];
  }
}

/** Detected terminal info. */
interface DetectedTerminal {
  /** Terminal executable name (e.g., "kitty", "alacritty", "ghostty") */
  executable: string | null;
  /** How it was detected */
  source: "TERM_PROGRAM" | "env-hint" | "parent-process" | "unknown";
  /** Special handling needed (e.g., Windows Terminal needs wt.exe) */
  special?: "windows-terminal" | "vscode" | "macos-app";
}

/**
 * Detect which terminal the current process is running in.
 *
 * Detection methods (in order of reliability):
 * 1. Parent process - ALWAYS exists, most reliable
 * 2. TERM_PROGRAM env var - set by most modern terminals
 * 3. Terminal-specific env vars (WT_SESSION, KITTY_WINDOW_ID, etc.)
 *
 * This approach works with any terminal without hardcoding names.
 */
function detectCurrentTerminal(): DetectedTerminal {
  const env = process.env;

  // 1. Parent process detection - most reliable, always available
  const parentTerminal = detectParentTerminal();
  if (parentTerminal) {
    // Check for special cases based on parent name
    if (parentTerminal === "windowsterminal" || parentTerminal === "wt") {
      return { executable: "wt", source: "parent-process", special: "windows-terminal" };
    }
    if (parentTerminal === "code" || parentTerminal === "code-insiders") {
      return { executable: parentTerminal, source: "parent-process", special: "vscode" };
    }
    if (parentTerminal === "terminal" && detectHostPlatform() === "macos") {
      return { executable: "Terminal", source: "parent-process", special: "macos-app" };
    }
    if (parentTerminal === "iterm2" || parentTerminal === "iterm") {
      return { executable: "iTerm", source: "parent-process", special: "macos-app" };
    }
    return { executable: parentTerminal, source: "parent-process" };
  }

  // 2. TERM_PROGRAM fallback - works for most terminals
  if (env.TERM_PROGRAM) {
    const program = env.TERM_PROGRAM;

    // Special cases
    if (program === "vscode" || env.VSCODE_INJECTION) {
      return { executable: "code", source: "TERM_PROGRAM", special: "vscode" };
    }
    if (program === "Apple_Terminal") {
      return { executable: "Terminal", source: "TERM_PROGRAM", special: "macos-app" };
    }
    if (program === "iTerm.app") {
      return { executable: "iTerm", source: "TERM_PROGRAM", special: "macos-app" };
    }

    const executable = program.toLowerCase().replace(/\.app$/, "");
    return { executable, source: "TERM_PROGRAM" };
  }

  // 3. Terminal-specific env vars as last resort
  if (env.WT_SESSION || env.WT_PROFILE_ID) {
    return { executable: "wt", source: "env-hint", special: "windows-terminal" };
  }
  if (env.KITTY_WINDOW_ID || env.KITTY_PID) {
    return { executable: "kitty", source: "env-hint" };
  }
  if (env.ALACRITTY_SOCKET || env.ALACRITTY_LOG) {
    return { executable: "alacritty", source: "env-hint" };
  }
  if (env.WEZTERM_PANE || env.WEZTERM_UNIX_SOCKET) {
    return { executable: "wezterm", source: "env-hint" };
  }
  if (env.GHOSTTY_RESOURCES_DIR) {
    return { executable: "ghostty", source: "env-hint" };
  }
  if (env.KONSOLE_VERSION || env.KONSOLE_DBUS_SESSION) {
    return { executable: "konsole", source: "env-hint" };
  }
  if (env.GNOME_TERMINAL_SCREEN) {
    return { executable: "gnome-terminal", source: "env-hint" };
  }
  if (env.TILIX_ID) {
    return { executable: "tilix", source: "env-hint" };
  }
  if (env.TERMINATOR_UUID) {
    return { executable: "terminator", source: "env-hint" };
  }

  return { executable: null, source: "unknown" };
}

/**
 * Detect terminal from parent process chain.
 * Walks up the process tree to find the terminal emulator.
 */
function detectParentTerminal(): string | null {
  const platform = detectHostPlatform();

  // Shells and interpreters to skip when walking up process tree
  const skipProcesses = new Set([
    "bash", "sh", "zsh", "fish", "dash", "ksh", "csh", "tcsh",
    "node", "bun", "deno", "python", "python3", "ruby", "perl",
    "sudo", "su", "env", "nice", "nohup", "setsid",
    "powershell", "pwsh", "cmd", "conhost",
  ]);

  if (platform === "windows-native") {
    // Windows: use WMIC or PowerShell to walk process tree
    try {
      // Try WMIC first (faster, no PS overhead)
      const { execSync } = require("child_process");
      let ppid = process.ppid;

      // Walk up to 5 levels
      for (let i = 0; i < 5 && ppid > 1; i++) {
        const result = execSync(
          `wmic process where ProcessId=${ppid} get ParentProcessId,Name /format:csv 2>nul`,
          { encoding: "utf8", timeout: 2000 }
        );

        const lines = result.trim().split("\n").filter(Boolean);
        if (lines.length < 2) {
          break;
        }

        // CSV format: Node,Name,ParentProcessId
        const parts = lines[1]!.split(",");
        if (parts.length < 3) {
          break;
        }

        const name = parts[1]!.toLowerCase().replace(/\.exe$/, "");
        ppid = parseInt(parts[2]!, 10);

        if (!skipProcesses.has(name) && name !== "wmic") {
          return name;
        }
      }
    } catch {
      // PowerShell fallback is unreliable, skip it
    }
    return null;
  }

  // Linux/macOS: use ps to walk process tree
  try {
    const { execSync } = require("child_process");
    let ppid = process.ppid;

    // Walk up to 10 levels to find terminal
    for (let i = 0; i < 10 && ppid > 1; i++) {
      const result = execSync(
        `ps -o ppid=,comm= -p ${ppid} 2>/dev/null`,
        { encoding: "utf8", timeout: 1000 }
      );

      const line = result.trim();
      if (!line) {
        break;
      }

      const parts = line.split(/\s+/);
      if (parts.length < 2) {
        break;
      }

      ppid = parseInt(parts[0]!, 10);
      const cmd = parts[1]!.toLowerCase().replace(/^-/, ""); // Remove leading dash from login shells

      // Found a terminal (not a shell/interpreter)
      if (!skipProcesses.has(cmd)) {
        return cmd;
      }
    }
  } catch {
    // Ignore
  }

  return null;
}

/**
 * Try to open a new window in the same terminal we're running in.
 * Returns true if successful, false if we should fall back to defaults.
 */
async function tryOpenSameTerminal(
  terminal: DetectedTerminal,
  command: string,
  platform: ReturnType<typeof detectHostPlatform>
): Promise<boolean> {
  if (!terminal.executable) {
    return false;
  }

  const exe = terminal.executable;

  try {
    // Special handling for known terminal types
    if (terminal.special === "windows-terminal") {
      await exec("wt", ["-w", "0", "new-tab", "cmd", "/c", command], { timeout: 10000 });
      return true;
    }

    if (terminal.special === "vscode") {
      // VS Code integrated terminal - can't easily open new window
      // Fall back to system default
      return false;
    }

    if (terminal.special === "macos-app") {
      const script = exe === "iTerm"
        ? `tell application "iTerm" to create window with default profile command "${command.replace(/"/g, '\\"')}"`
        : `tell app "Terminal" to do script "${command.replace(/"/g, '\\"')}"`;
      await exec("osascript", ["-e", script], { timeout: 10000 });
      return true;
    }

    // Generic terminal opening based on platform
    if (platform === "windows-native" || platform === "windows-wsl") {
      // Try to run the terminal with the command
      if (commandExists(exe)) {
        await exec("cmd", ["/c", "start", exe, command], { timeout: 10000 });
        return true;
      }
    } else if (platform === "macos") {
      // macOS: try to open as app or command
      if (commandExists(exe)) {
        // Try common argument patterns
        const patterns = [
          ["-e", "bash", "-c", command],           // kitty, alacritty
          ["--", "bash", "-c", command],           // gnome-terminal style
          ["-e", `bash -c '${command}'`],          // xfce4-terminal, tilix
          ["start", "--", "bash", "-c", command],  // wezterm
          ["bash", "-c", command],                 // kitty alternate
        ];

        for (const args of patterns) {
          const result = await exec(exe, args, { timeout: 10000 });
          if (result.exitCode === 0) {
            return true;
          }
        }
      }
    } else {
      // Linux: most terminals follow similar patterns
      if (commandExists(exe)) {
        const patterns = [
          ["-e", "bash", "-c", command],
          ["--", "bash", "-c", command],
          ["-e", `bash -c '${command}'`],
          ["start", "--", "bash", "-c", command],
          ["bash", "-c", command],
        ];

        for (const args of patterns) {
          const result = await exec(exe, args, { timeout: 10000 });
          if (result.exitCode === 0) {
            return true;
          }
        }
      }
    }
  } catch (e) {
    log.debug(`Failed to open ${exe}: ${String(e)}`);
  }

  return false;
}

/**
 * Open container in a new terminal window.
 *
 * First tries to detect and use the same terminal as the current process.
 * Falls back to platform defaults if detection fails.
 *
 * Supports multiple terminal emulators on each platform:
 * - Windows: Windows Terminal (wt), PowerShell, cmd
 * - macOS: iTerm2, Terminal.app
 * - Linux: x-terminal-emulator (wrapper), gnome-terminal, konsole, tilix,
 *          xfce4-terminal, alacritty, kitty, xterm
 */
export async function openContainerTerminal(command: string): Promise<void> {
  const platform = detectHostPlatform();
  const currentTerminal = detectCurrentTerminal();

  try {
    // First, try to use the same terminal as we're running in
    const sameTerminalOpened = await tryOpenSameTerminal(currentTerminal, command, platform);
    if (sameTerminalOpened) {
      return;
    }

    // Fallback to platform defaults
    switch (platform) {
      case "windows-native": {
        // Windows: try Windows Terminal, then PowerShell, then cmd
        if (commandExists("wt")) {
          await exec("cmd", ["/c", "start", "wt", "-w", "0", "new-tab", "cmd", "/c", command], { timeout: 10000 });
        } else if (commandExists("pwsh")) {
          await exec("cmd", ["/c", "start", "pwsh", "-NoExit", "-Command", command], { timeout: 10000 });
        } else if (commandExists("powershell")) {
          await exec("cmd", ["/c", "start", "powershell", "-NoExit", "-Command", command], { timeout: 10000 });
        } else {
          await exec("cmd", ["/c", "start", "cmd", "/k", command], { timeout: 10000 });
        }
        break;
      }

      case "windows-wsl": {
        if (commandExists("wt.exe")) {
          await exec("wt.exe", ["-w", "0", "new-tab", "wsl", "-e", "bash", "-c", command], { timeout: 10000 });
        } else {
          await exec("cmd.exe", ["/c", "start", "wsl", "-e", "bash", "-c", command], { timeout: 10000 });
        }
        break;
      }

      case "macos": {
        const terminalScript = `tell app "Terminal" to do script "${command.replace(/"/g, '\\"')}"`;
        await exec("osascript", ["-e", terminalScript], { timeout: 10000 });
        break;
      }

      case "linux": {
        const terminals = [
          { cmd: "x-terminal-emulator", args: ["-e", "bash", "-c", command] },
          { cmd: "gnome-terminal", args: ["--", "bash", "-c", command] },
          { cmd: "konsole", args: ["-e", "bash", "-c", command] },
          { cmd: "xfce4-terminal", args: ["-e", `bash -c '${command}'`] },
          { cmd: "xterm", args: ["-e", "bash", "-c", command] },
        ];

        let launched = false;
        for (const { cmd, args } of terminals) {
          if (commandExists(cmd)) {
            await exec(cmd, args, { timeout: 10000 });
            launched = true;
            break;
          }
        }

        if (!launched) {
          log.warn("No supported terminal emulator found");
        }
        break;
      }
    }
  } catch (e) {
    log.warn(`Failed to open terminal: ${String(e)}`);
  }
}

/** Format time as HH:MM. */
function formatTime(date: Date): string {
  return date.toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" });
}

/** Clear terminal and move cursor to top. */
function clearScreen(): void {
  process.stdout.write("\x1B[2J\x1B[H");
}

/** Render the bridge UI. */
export function renderUI(state: BridgeState): void {
  clearScreen();

  // Header with status indicator
  const statusIcon = state.containerName ? style.green("●") : style.yellow("○");
  const statusText = state.containerName
    ? style.dim(state.containerName)
    : style.dim("connecting...");

  log.raw(`${statusIcon} ${style.bold("ccbox")} ${style.dim("—")} ${state.projectName}`);
  log.raw(`  ${statusText}`);
  log.newline();

  // Sessions
  if (state.sessions.length > 0) {
    log.raw(style.dim("Sessions:"));
    for (let i = 0; i < state.sessions.length; i++) {
      const session = state.sessions[i]!;
      const isCurrent = i === state.currentSessionIndex;
      const marker = isCurrent ? style.cyan("▸") : " ";
      const time = style.dim(formatTime(session.startedAt));

      log.raw(`  ${marker} ${session.id} ${time}`);
    }
  } else {
    log.raw(style.dim("  No active sessions"));
  }

  log.newline();

  // Controls - compact single line
  log.raw(style.dim("  v") + " voice  " + style.dim("p") + " paste  " + style.dim("q") + " quit  " + style.dim("↑↓") + " switch");
  log.newline();
}

/** Render session picker for input targeting. */
export function renderSessionPicker(sessions: SessionInfo[], selectedIndex: number): void {
  // Move cursor up to overwrite previous picker
  const lines = sessions.length + 2;
  process.stdout.write(`\x1B[${lines}A`);

  log.raw(style.yellow("Select target session:"));
  for (let i = 0; i < sessions.length; i++) {
    const session = sessions[i]!;
    const isSelected = i === selectedIndex;
    const marker = isSelected ? style.cyan("▸") : " ";
    const time = style.dim(formatTime(session.startedAt));

    log.raw(`  ${marker} ${session.id} ${time}`);
  }
  log.raw(style.dim("  esc cancel • enter select"));
}

/** Write input file to .claude/input/ directory. */
export function writeInputFile(state: BridgeState, content: string | Buffer, type: "paste" | "voice", ext: string): string {
  ensureInputDir(state);

  const timestamp = Date.now();
  const filename = `${type}-${timestamp}.${ext}`;
  const filepath = join(state.inputDir, filename);

  writeFileSync(filepath, content);

  return filename;
}

/** Get current session ID. */
export function getCurrentSessionId(state: BridgeState): string {
  const session = state.sessions[state.currentSessionIndex];
  return session?.id ?? "unknown";
}

/** Log activity to bridge UI. */
export function logActivity(message: string): void {
  const time = formatTime(new Date());
  log.raw(`${style.dim(`> ${time}`)} ${message}`);
}

/**
 * Main bridge mode entry point.
 */
export async function runBridgeMode(options: BridgeOptions = {}): Promise<void> {
  const projectPath = options.path ?? ".";
  const state = createBridgeState(projectPath);

  // Ensure input directory exists
  ensureInputDir(state);

  // Initial UI render
  renderUI(state);

  // Find or launch container
  if (options.containerName) {
    state.containerName = options.containerName;
  } else {
    const running = await findRunningContainer();
    if (running) {
      state.containerName = running;
    }
  }

  // Launch container in new terminal if needed
  if (!options.skipContainerLaunch && !state.containerName) {
    const ccboxCmd = buildCcboxCommand(projectPath, options.ccboxArgs ?? []);
    await openContainerTerminal(ccboxCmd);

    // Wait for container to appear (silent polling)
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const running = await findRunningContainer();
      if (running) {
        state.containerName = running;
        renderUI(state); // Update UI with container name
        break;
      }
    }
  }

  // Discover sessions
  if (state.containerName) {
    state.sessions = await discoverSessions(state.containerName, state.projectPath);
  }

  // Start the interactive loop
  state.isRunning = true;
  await runInteractiveLoop(state);
}

/** Build ccbox command for launching container. */
function buildCcboxCommand(projectPath: string, extraArgs: string[]): string {
  const args = ["ccbox", "--attach-mode", `--path "${projectPath}"`];

  if (extraArgs.length > 0) {
    args.push(...extraArgs);
  }

  return args.join(" ");
}

/** Setup keyboard input handling. */
function setupKeyboard(state: BridgeState, handlers: {
  onUp: () => void;
  onDown: () => void;
  onEnter: () => void;
  onEscape: () => void;
  onV: () => void;
  onP: () => void;
  onQ: () => void;
}): void {
  const readline = require("readline");
  readline.emitKeypressEvents(process.stdin);

  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }

  process.stdin.on("keypress", (_str: string, key: { name?: string; ctrl?: boolean }) => {
    if (!state.isRunning) {
      return;
    }

    // Ctrl+C - force quit
    if (key.ctrl && key.name === "c") {
      state.isRunning = false;
      process.exit(0);
    }

    // Arrow keys
    if (key.name === "up") {
      handlers.onUp();
    } else if (key.name === "down") {
      handlers.onDown();
    } else if (key.name === "return") {
      handlers.onEnter();
    } else if (key.name === "escape") {
      handlers.onEscape();
    } else if (key.name === "v") {
      handlers.onV();
    } else if (key.name === "p") {
      handlers.onP();
    } else if (key.name === "q") {
      handlers.onQ();
    }
  });

  process.stdin.resume();
}

/** Run the interactive keyboard loop. */
async function runInteractiveLoop(state: BridgeState): Promise<void> {
  let sessionPickerResolve: ((index: number | null) => void) | null = null;
  let sessionPickerIndex = 0;

  const handlers = {
    onUp: () => {
      if (state.isSelectingSession) {
        sessionPickerIndex = (sessionPickerIndex - 1 + state.sessions.length) % state.sessions.length;
        renderSessionPicker(state.sessions, sessionPickerIndex);
      } else {
        state.currentSessionIndex = (state.currentSessionIndex - 1 + Math.max(1, state.sessions.length)) % Math.max(1, state.sessions.length);
        renderUI(state);
      }
    },

    onDown: () => {
      if (state.isSelectingSession) {
        sessionPickerIndex = (sessionPickerIndex + 1) % state.sessions.length;
        renderSessionPicker(state.sessions, sessionPickerIndex);
      } else {
        state.currentSessionIndex = (state.currentSessionIndex + 1) % Math.max(1, state.sessions.length);
        renderUI(state);
      }
    },

    onEnter: () => {
      if (state.isSelectingSession && sessionPickerResolve) {
        state.isSelectingSession = false;
        sessionPickerResolve(sessionPickerIndex);
        sessionPickerResolve = null;
      }
    },

    onEscape: () => {
      if (state.isSelectingSession && sessionPickerResolve) {
        state.isSelectingSession = false;
        sessionPickerResolve(null);
        sessionPickerResolve = null;
        renderUI(state);
      }
    },

    onV: async () => {
      if (state.isSelectingSession) {
        return;
      }
      await handleVoice(state, promptSessionSelection);
      renderUI(state);
    },

    onP: async () => {
      if (state.isSelectingSession) {
        return;
      }
      await handlePaste(state, promptSessionSelection);
      renderUI(state);
    },

    onQ: async () => {
      if (state.isSelectingSession) {
        return;
      }
      await handleQuit(state);
    },
  };

  // Session selection prompt helper
  async function promptSessionSelection(): Promise<number | null> {
    if (state.sessions.length === 0) {
      log.warn("No active sessions");
      return null;
    }

    if (state.sessions.length === 1) {
      return 0;
    }

    // Multiple sessions - prompt for selection
    state.isSelectingSession = true;
    sessionPickerIndex = state.currentSessionIndex;

    log.newline();
    renderSessionPicker(state.sessions, sessionPickerIndex);

    return new Promise((resolve) => {
      sessionPickerResolve = resolve;
    });
  }

  setupKeyboard(state, handlers);

  // Render initial UI
  renderUI(state);

  // Keep the process alive
  await new Promise<void>((resolve) => {
    const checkRunning = setInterval(() => {
      if (!state.isRunning) {
        clearInterval(checkRunning);
        resolve();
      }
    }, 100);
  });

  // Cleanup
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(false);
  }
}

/** Handle voice input. */
async function handleVoice(
  state: BridgeState,
  promptSession: () => Promise<number | null>
): Promise<void> {
  const { voicePipelineBridge } = await import("./voice.js");

  // Refresh sessions
  if (state.containerName) {
    state.sessions = await discoverSessions(state.containerName, state.projectPath);
  }

  const sessionIndex = await promptSession();
  if (sessionIndex === null) {
    return;
  }

  log.dim("🎤 Recording... (Enter to stop)");

  const text = await voicePipelineBridge();
  if (!text) {
    log.warn("No audio captured");
    return;
  }

  const filename = writeInputFile(state, text, "voice", "txt");
  const sessionId = state.sessions[sessionIndex]?.id ?? "unknown";
  logActivity(`Voice → ${sessionId}: ${filename}`);
}

/** Handle clipboard paste. */
async function handlePaste(
  state: BridgeState,
  promptSession: () => Promise<number | null>
): Promise<void> {
  const { readClipboardForBridge } = await import("./clipboard.js");

  // Refresh sessions
  if (state.containerName) {
    state.sessions = await discoverSessions(state.containerName, state.projectPath);
  }

  const sessionIndex = await promptSession();
  if (sessionIndex === null) {
    return;
  }

  log.dim("Reading clipboard...");

  const result = await readClipboardForBridge();
  if (!result) {
    log.warn("Clipboard empty or unsupported format");
    return;
  }

  const ext = result.type === "image" ? "png" : "txt";
  const filename = writeInputFile(state, result.content, "paste", ext);
  const sessionId = state.sessions[sessionIndex]?.id ?? "unknown";
  logActivity(`Paste (${result.type}) → ${sessionId}: ${filename}`);
}

/** Handle quit command. */
async function handleQuit(state: BridgeState): Promise<void> {
  // Exit raw mode temporarily for prompt
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(false);
  }

  const readline = require("readline");
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const answer = await new Promise<string>((resolve) => {
    rl.question("Container'ı da kapatmak ister misiniz? [y/N]: ", (ans: string) => {
      rl.close();
      resolve(ans);
    });
  });

  if (answer.toLowerCase() === "y" && state.containerName) {
    log.dim("Stopping container...");
    await exec("docker", ["stop", state.containerName], {
      timeout: DOCKER_COMMAND_TIMEOUT,
      env: getDockerEnv(),
    });
    log.dim("Container stopped.");
  } else {
    log.dim("Bridge closing, container continues running.");
  }

  state.isRunning = false;
  process.exit(0);
}
