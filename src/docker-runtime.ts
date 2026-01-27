/**
 * Docker runtime utilities for ccbox.
 *
 * Container execution, path transformation, and environment setup.
 * Separated from generator.ts to reduce file size and improve modularity.
 */

import { existsSync, readFileSync, readlinkSync } from "node:fs";
import { platform } from "node:os";
import { join, resolve } from "node:path";
import { env } from "node:process";

import type { Config } from "./config.js";
import { getClaudeConfigDir, getContainerName, getImageName, LanguageStack } from "./config.js";
import { DEFAULT_PIDS_LIMIT } from "./constants.js";
import type { DepsInfo } from "./deps.js";
import { resolveForDocker } from "./paths.js";

// Container constraints (SSOT - used for both docker run and prompt generation)
const CONTAINER_CONSTRAINTS = {
  pidsLimit: DEFAULT_PIDS_LIMIT,         // from constants.ts
  capDrop: "ALL",                        // Linux capabilities
  ephemeralPaths: ["/tmp", "/var/tmp", "~/.cache"],
} as const;

/** Generate container awareness prompt with current constraints. */
export function buildContainerAwarenessPrompt(persistentPaths: string): string {
  const { pidsLimit } = CONTAINER_CONSTRAINTS;

  // Detect host OS for better guidance
  const hostOS = platform() === "win32" ? "Windows" : platform() === "darwin" ? "macOS" : "Linux";

  return `
[CCBOX CONTAINER ENVIRONMENT]

You are in an isolated Linux container (Debian). The host is ${hostOS}.

CRITICAL RULES:
1. This is LINUX - use bash syntax, forward slashes, no Windows commands
2. Only ${persistentPaths} persist - everything else is deleted on exit
3. No Docker/systemd/GUI available - container has limited capabilities

COMMAND PATTERNS (use these, they work correctly):
  git -C /path status              # NOT: cd /path && git status
  npm --prefix /path install       # NOT: cd /path && npm install
  python3 /path/script.py          # absolute paths always work
  rg "pattern" /path               # ripgrep for fast search

${hostOS === "Windows" ? `WINDOWS HOST: Paths are auto-translated (D:\\\\GitHub\\\\x → /d/GitHub/x)
  NEVER use: cd /d, backslashes, cmd.exe syntax, PowerShell commands
` : ""}
FILESYSTEM:
  PERSISTENT: ${persistentPaths}
    → project files, node_modules/, venv/, target/, .git/ all saved
  EPHEMERAL: /tmp, /root, /etc, /usr, apt packages, global installs
    → lost on exit, use project-local alternatives

AVAILABLE TOOLS:
  git, gh (GitHub CLI), curl, wget, ssh, jq, yq, rg (ripgrep), fd
  python3, pip3, gcc, make + stack-specific tools (node, cargo, go, etc.)

LIMITATIONS:
  ✗ docker, docker-compose, podman (no Docker-in-Docker)
  ✗ systemctl, service (no init system)
  ✗ npm -g, pip install --user (use local: npm install, pip install -t)
  ✗ apt install (lost on exit - most tools pre-installed)
  △ /tmp has noexec - use $TMPDIR for executable temp files
  △ Max ${pidsLimit} processes - avoid excessive parallelism

WHEN SOMETHING FAILS:
  - Path error? Use absolute Linux paths, check translation
  - Command not found? Try: which <cmd>, or use npx/pipx
  - Permission denied? You're 'node' user, not root
  - Can't install? Check if pre-installed or use project-local install
`.trim();
}

/**
 * Fix MSYS path translation for slash commands on Windows Git Bash.
 *
 * Git Bash (MSYS2) translates Unix paths like /command to C:/Program Files/Git/command.
 * This function reverses that translation for slash commands.
 *
 * All slash commands are passed directly to Claude Code - it handles both
 * built-in commands (/compact, /doctor, etc.) and custom commands.
 */
export function transformSlashCommand(prompt: string | undefined): string | undefined {
  if (!prompt) {
    return prompt;
  }

  // Fix MSYS path translation: /command -> C:/Program Files/Git/command
  // This happens when running ccbox from Git Bash on Windows
  const msysPrefix = "C:/Program Files/Git/";
  if (prompt.startsWith(msysPrefix)) {
    prompt = "/" + prompt.slice(msysPrefix.length);
  }

  return prompt;
}

/**
 * Get host UID and GID for container user mapping (cross-platform).
 *
 * Platform behavior:
 * - **Windows**: Docker Desktop uses a Linux VM. Files created in bind mounts
 *   appear as the container user (ccbox/1000:1000). Windows doesn't have Unix
 *   UID/GID concepts, so we use the container's default user ID.
 * - **macOS**: Docker Desktop uses a Linux VM with osxfs/gRPC FUSE for file
 *   sharing. It automatically maps the host user to container UID via
 *   user namespace remapping. We use actual host UID for consistency.
 * - **Linux**: Native Docker uses the host kernel. UID/GID directly affect
 *   file ownership on bind mounts. We use actual host UID/GID to ensure
 *   created files are owned by the host user.
 *
 * @returns Tuple of [uid, gid] to use for container processes.
 */
export function getHostUserIds(): [number, number] {
  if (platform() === "win32") {
    // Windows: No native UID/GID. Docker Desktop maps to container's default user.
    // Use 1000:1000 (ccbox user created in Dockerfile)
    return [1000, 1000];
  }

  // Linux/macOS: Use actual host UID/GID for proper file ownership
  // Fallback to 1000 if process.getuid() is unavailable (shouldn't happen on Unix)
  return [process.getuid?.() ?? 1000, process.getgid?.() ?? 1000];
}

/**
 * Get host timezone in IANA format (cross-platform).
 */
export function getHostTimezone(): string {
  // 1. Check TZ environment variable
  const tzEnv = env.TZ;
  if (tzEnv && tzEnv.includes("/")) {
    return tzEnv;
  }

  // 2. Use JavaScript Intl API (works on all platforms including Windows)
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (tz && tz.includes("/")) {
      return tz;
    }
  } catch {
    // Ignore
  }

  // 3. Try /etc/timezone (Debian/Ubuntu) - Linux only
  if (platform() !== "win32") {
    try {
      const tzFile = "/etc/timezone";
      if (existsSync(tzFile)) {
        const tz = readFileSync(tzFile, "utf-8").trim();
        if (tz && tz.includes("/")) {
          return tz;
        }
      }
    } catch {
      // Ignore
    }

    // 4. Try /etc/localtime symlink (Linux/macOS)
    try {
      const localtime = "/etc/localtime";
      const target = readlinkSync(localtime);
      if (target.includes("zoneinfo/")) {
        const tz = target.split("zoneinfo/")[1];
        if (tz && tz.includes("/")) {
          return tz;
        }
      }
    } catch {
      // Ignore
    }
  }

  // 5. Fallback to UTC
  return "UTC";
}

/**
 * Get terminal size (cross-platform).
 */
export function getTerminalSize(): { columns: number; lines: number } {
  // Use process.stdout if available, otherwise fallback
  const columns = process.stdout.columns ?? 120;
  const lines = process.stdout.rows ?? 40;
  return { columns, lines };
}

/** Build Claude CLI arguments list. */
export function buildClaudeArgs(options: {
  model?: string;
  debug?: number;
  prompt?: string;
  quiet?: boolean;
  appendSystemPrompt?: string;
  persistentPaths?: string;
}): string[] {
  const args: string[] = ["--dangerously-skip-permissions"];

  if (options.model) {
    args.push("--model", options.model);
  }

  const stream = (options.debug ?? 0) >= 2;
  const verbose = stream || (Boolean(options.prompt) && !options.quiet);

  if (verbose) {
    args.push("--verbose");
  }

  // Build system prompt: always include container awareness, optionally append user's prompt
  const containerPrompt = buildContainerAwarenessPrompt(
    options.persistentPaths ?? "/ccbox/project, /ccbox/.claude"
  );
  const systemPrompt = options.appendSystemPrompt
    ? `${containerPrompt}\n\n${options.appendSystemPrompt}`
    : containerPrompt;
  args.push("--append-system-prompt", systemPrompt);

  if (options.quiet || options.prompt) {
    args.push("--print");
    if (stream) {
      args.push("--output-format", "stream-json");
    }
  }

  if (options.prompt) {
    args.push(options.prompt);
  }

  return args;
}

// Helper functions for docker run command building

/**
 * Add minimal mounts for vanilla Claude Code experience.
 * Used for base image and --fresh mode.
 * Only mounts auth + settings files - no plugins/rules/commands.
 */
function addMinimalMounts(cmd: string[], claudeConfig: string): void {
  const [uid, gid] = getHostUserIds();

  // Ephemeral .claude directory (tmpfs, lost on container exit)
  cmd.push("--tmpfs", `/ccbox/.claude:rw,size=64m,uid=${uid},gid=${gid},mode=0755`);

  // Mount only essential files for auth and preferences
  const essentialFiles = [".credentials.json", "settings.json", "settings.local.json"];
  for (const f of essentialFiles) {
    const hostFile = join(claudeConfig, f);
    if (existsSync(hostFile)) {
      const dockerPath = resolveForDocker(hostFile);
      cmd.push("-v", `${dockerPath}:/ccbox/.claude/${f}:rw`);
    }
  }

  // Signal minimal mount mode
  cmd.push("-e", "CCBOX_MINIMAL_MOUNT=1");
}

function addGitEnv(cmd: string[], config: Config): void {
  if (config.gitName) {
    cmd.push("-e", `GIT_AUTHOR_NAME=${config.gitName}`);
    cmd.push("-e", `GIT_COMMITTER_NAME=${config.gitName}`);
  }
  if (config.gitEmail) {
    cmd.push("-e", `GIT_AUTHOR_EMAIL=${config.gitEmail}`);
    cmd.push("-e", `GIT_COMMITTER_EMAIL=${config.gitEmail}`);
  }
}

function addTerminalEnv(cmd: string[]): void {
  const term = env.TERM ?? "xterm-256color";
  const colorterm = env.COLORTERM ?? "truecolor";
  cmd.push("-e", `TERM=${term}`);
  cmd.push("-e", `COLORTERM=${colorterm}`);

  const size = getTerminalSize();
  cmd.push("-e", `COLUMNS=${size.columns}`);
  cmd.push("-e", `LINES=${size.lines}`);

  // Passthrough terminal-specific variables
  const passthroughVars = [
    "TERM_PROGRAM",
    "TERM_PROGRAM_VERSION",
    "ITERM_SESSION_ID",
    "ITERM_PROFILE",
    "KITTY_WINDOW_ID",
    "KITTY_PID",
    "WEZTERM_PANE",
    "WEZTERM_UNIX_SOCKET",
    "GHOSTTY_RESOURCES_DIR",
    "ALACRITTY_SOCKET",
    "ALACRITTY_LOG",
    "VSCODE_GIT_IPC_HANDLE",
    "VSCODE_INJECTION",
    "WT_SESSION",
    "WT_PROFILE_ID",
    "KONSOLE_VERSION",
    "KONSOLE_DBUS_SESSION",
    "TMUX",
    "TMUX_PANE",
    "STY",
  ];

  for (const varName of passthroughVars) {
    const value = env[varName];
    if (value) {
      cmd.push("-e", `${varName}=${value}`);
    }
  }
}

function addUserMapping(cmd: string[]): void {
  const [uid, gid] = getHostUserIds();
  // Pass UID/GID as environment variables instead of --user flag
  // Container starts as root for setup, then drops to non-root user via gosu
  cmd.push("-e", `CCBOX_UID=${uid}`);
  cmd.push("-e", `CCBOX_GID=${gid}`);
}

function addSecurityOptions(cmd: string[]): void {
  const { capDrop, pidsLimit } = CONTAINER_CONSTRAINTS;
  cmd.push(
    `--cap-drop=${capDrop}`,
    // Minimal capabilities for user switching, file ownership, and FUSE
    "--cap-add=SETUID",     // gosu: change user ID
    "--cap-add=SETGID",     // gosu: change group ID
    "--cap-add=CHOWN",      // entrypoint: change file ownership
    "--cap-add=SYS_ADMIN",  // FUSE: mount filesystem in userspace
    `--pids-limit=${pidsLimit}`,
    "--init",
    "--shm-size=256m",
    "--ulimit",
    "nofile=65535:65535",
    "--memory-swappiness=0"
  );
}


/**
 * Add tmpfs mounts for transient data to reduce disk I/O.
 * All temp files go to RAM - zero SSD wear, 15-20x faster.
 */
function addTmpfsMounts(cmd: string[]): void {
  cmd.push(
    // General temp files (512MB, no exec for security)
    "--tmpfs", "/tmp:rw,size=512m,mode=1777,noexec,nosuid,nodev",
    // Secondary temp (256MB)
    "--tmpfs", "/var/tmp:rw,size=256m,mode=1777,noexec,nosuid,nodev",
    // Runtime files - PID files, sockets (exec required)
    "--tmpfs", "/run:rw,size=64m,mode=755"
  );
}


/**
 * Add log rotation options to limit disk usage.
 * Prevents unbounded log growth and enables compression.
 */
function addLogOptions(cmd: string[]): void {
  cmd.push(
    "--log-driver", "json-file",
    "--log-opt", "max-size=10m",
    "--log-opt", "max-file=3",
    "--log-opt", "compress=true"
  );
}


function addDnsOptions(cmd: string[]): void {
  cmd.push("--dns-opt", "ndots:1", "--dns-opt", "timeout:1", "--dns-opt", "attempts:1");
}


function addClaudeEnv(cmd: string[]): void {
  const tz = getHostTimezone();
  cmd.push("-e", `TZ=${tz}`);

  cmd.push(
    "-e",
    "FORCE_COLOR=1",
    // Claude Code configuration (CLAUDE_CONFIG_DIR set in generateRunCommand)
    "-e",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1",
    "-e",
    "CLAUDE_CODE_HIDE_ACCOUNT_INFO=1",
    "-e",
    "CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL=1",
    "-e",
    "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=85",
    "-e",
    "CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR=1",
    "-e",
    "FORCE_AUTOUPDATE_PLUGINS=true",
    "-e",
    "DISABLE_AUTOUPDATER=0",
    // Runtime configuration
    "-e",
    "PYTHONUNBUFFERED=1",
    // Bun runtime settings (Claude Code uses Bun)
    "-e",
    "DO_NOT_TRACK=1",  // Disable Bun telemetry/crash reports
    "-e",
    "BUN_RUNTIME_TRANSPILER_CACHE_PATH=0"  // Disable cache (Docker ephemeral filesystem)
  );
}

/**
 * Generate docker run command with full cleanup on exit.
 * Two mount modes:
 * - Normal: full ~/.claude mount
 * - Fresh (--fresh): only credentials, clean slate for customizations
 */
export function getDockerRunCmd(
  config: Config,
  projectPath: string,
  projectName: string,
  stack: LanguageStack,
  options: {
    fresh?: boolean;
    ephemeralLogs?: boolean;
    debug?: number;
    prompt?: string;
    model?: string;
    quiet?: boolean;
    appendSystemPrompt?: string;
    projectImage?: string;
    depsList?: DepsInfo[];
    unrestricted?: boolean;
    envVars?: string[];
  } = {}
): string[] {
  const imageName = options.projectImage ?? getImageName(stack);
  const claudeConfig = getClaudeConfigDir(config);
  const prompt = transformSlashCommand(options.prompt);
  const containerName = getContainerName(projectName);
  const dockerProjectPath = resolveForDocker(resolve(projectPath));

  const cmd = ["docker", "run", "--rm"];

  // TTY allocation logic (cross-platform)
  // Interactive mode requires TTY for Claude Code's input handling
  const isInteractive = !prompt && !options.quiet;
  const isTTY = process.stdin.isTTY ?? false;

  if (isInteractive && isTTY) {
    // Use -it for interactive mode (requires proper TTY)
    // On Windows: use Windows Terminal (wt.exe) for best compatibility
    cmd.push("-it");
  } else if (isInteractive) {
    // Interactive but no TTY detected - still try with -it
    // This handles edge cases where TTY detection fails
    cmd.push("-it");
  } else {
    // Non-interactive (prompt mode) - stdin only
    cmd.push("-i");
  }

  cmd.push("--name", containerName);

  // Host project path for session compatibility
  // Claude Code uses pwd to determine project path for sessions
  // Mount directly to host-like path so sessions match across environments
  // Dockerfile creates /{a..z} directories for Windows drive letter support
  const hostProjectPath = dockerProjectPath.replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`);

  // Project mount (always) - mount to host-like path for session compatibility
  cmd.push("-v", `${dockerProjectPath}:${hostProjectPath}:rw`);

  // WSL session compatibility: detect WSL paths and pass for symlink bridge
  // WSL uses /mnt/d/... which encodes differently than /d/...
  // Entrypoint will create symlinks between encodings for session sharing
  const originalPath = resolve(projectPath);
  const wslMatch = originalPath.match(/^\/mnt\/([a-z])(\/.*)?$/i);
  if (wslMatch) {
    // Pass original WSL path for encoding bridge in entrypoint
    cmd.push("-e", `CCBOX_WSL_ORIGINAL_PATH=${originalPath}`);
  }

  // Claude config mount
  // - Base image: minimal mount (only credentials + settings for vanilla experience)
  // - Fresh mode: same as base (explicit --fresh flag)
  // - Other images: full .claude mount with FUSE in-place overlay for path transformation
  const dockerClaudeConfig = resolveForDocker(claudeConfig);
  const isBaseImage = stack === "base";
  const useMinimalMount = options.fresh || isBaseImage;

  if (useMinimalMount) {
    addMinimalMounts(cmd, claudeConfig);
  } else {
    // Mount global .claude directly - FUSE does in-place overlay in entrypoint
    // No .claude-source needed - FUSE uses bind mount trick inside container
    cmd.push("-v", `${dockerClaudeConfig}:/ccbox/.claude:rw`);

    // FUSE device access for kernel-level path transformation
    // Windows Docker Desktop requires --privileged for /dev/fuse access
    // Linux/macOS can use --device /dev/fuse with SYS_ADMIN capability
    if (platform() === "win32") {
      cmd.push("--privileged");
    } else {
      cmd.push("--device", "/dev/fuse");
    }
  }

  // Working directory - use host path for session compatibility
  cmd.push("-w", hostProjectPath);

  // User mapping
  addUserMapping(cmd);

  // Security options (skip if already privileged)
  if (platform() !== "win32" || useMinimalMount) {
    addSecurityOptions(cmd);
  }
  addTmpfsMounts(cmd);
  addLogOptions(cmd);
  addDnsOptions(cmd);

  // Resource limits
  if (!options.unrestricted) {
    cmd.push("--cpu-shares=512");
  }

  // Environment variables
  // HOME = host project path (direct mount), CLAUDE_CONFIG_DIR = global config
  cmd.push("-e", `HOME=${hostProjectPath}`);
  cmd.push("-e", "CLAUDE_CONFIG_DIR=/ccbox/.claude");
  addTerminalEnv(cmd);
  addClaudeEnv(cmd);

  if ((options.debug ?? 0) > 0) {
    cmd.push("-e", `CCBOX_DEBUG=${options.debug}`);
  }

  if (options.unrestricted) {
    cmd.push("-e", "CCBOX_UNRESTRICTED=1");
  }

  // Debug logs: ephemeral if requested, otherwise normal (persisted to host)
  if (options.ephemeralLogs) {
    cmd.push("--tmpfs", "/ccbox/.claude/debug:rw,size=512m,mode=0777");
  }

  // Persistent paths for container awareness
  // Base image and fresh mode: only project dir persists (.claude is ephemeral)
  // Other images: both project and .claude persist
  // Use host path for user-facing messages (matches pwd output)
  const persistentPaths = (options.fresh || isBaseImage)
    ? hostProjectPath
    : `${hostProjectPath}, /ccbox/.claude`;
  cmd.push("-e", `CCBOX_PERSISTENT_PATHS=${persistentPaths}`);

  // FUSE path mapping: host paths -> container paths (for JSON config transformation)
  // Maps Windows paths (D:/...) to POSIX paths (/d/...) in session files
  // This ensures sessions created in container are visible on host and vice versa
  const pathMappings: string[] = [];

  // Map project directory (Windows D:/... -> POSIX /d/...)
  // Only needed on Windows where path format differs
  if (dockerProjectPath !== hostProjectPath) {
    pathMappings.push(`${dockerProjectPath}:${hostProjectPath}`);
  }

  // Map WSL path if detected (/mnt/d/... -> /d/...)
  // This allows FUSE to transform WSL paths in session files
  if (wslMatch) {
    pathMappings.push(`${originalPath}:${hostProjectPath}`);
  }

  // Map .claude config (unless fresh/base image mode)
  if (!options.fresh && !isBaseImage) {
    const normalizedClaudePath = claudeConfig.replace(/\\/g, "/");
    pathMappings.push(`${normalizedClaudePath}:/ccbox/.claude`);
  }

  if (pathMappings.length > 0) {
    cmd.push("-e", `CCBOX_PATH_MAP=${pathMappings.join(";")}`);
  }

  addGitEnv(cmd, config);

  // User-provided environment variables (added last to allow overrides)
  if (options.envVars && options.envVars.length > 0) {
    for (const envVar of options.envVars) {
      if (envVar.includes("=")) {
        cmd.push("-e", envVar);
      }
    }
  }

  cmd.push(imageName);

  // Claude CLI arguments
  const claudeArgs = buildClaudeArgs({
    model: options.model,
    debug: options.debug,
    prompt,
    quiet: options.quiet,
    appendSystemPrompt: options.appendSystemPrompt,
    persistentPaths,
  });
  cmd.push(...claudeArgs);

  return cmd;
}
