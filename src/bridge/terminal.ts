/**
 * Terminal detection and opening for ccbox bridge mode.
 *
 * Detects the current terminal emulator and opens new windows/tabs
 * for container sessions. Supports all major terminals on Windows,
 * macOS, and Linux.
 *
 * Dependency direction:
 *   This module imports from: platform.ts, exec.ts, logger.ts
 *   It should NOT import from: cli, generator, bridge/index
 */

import { exec } from "../exec.js";
import { log } from "../logger.js";
import { detectHostPlatform, commandExists } from "../platform.js";

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
