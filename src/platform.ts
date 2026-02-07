/**
 * Cross-platform detection and abstraction for ccbox.
 *
 * Provides a unified interface for platform-specific behaviors:
 * - Host platform detection (windows-wsl, windows-native, macos, linux)
 * - Docker socket paths
 * - Clipboard commands
 * - FUSE requirement detection
 *
 * Dependency direction:
 *   This module has minimal internal dependencies (near-leaf module).
 *   It may be imported by: docker-runtime.ts, paths.ts, clipboard.ts, voice.ts
 *   It should NOT import from: cli, generator, docker-runtime
 */

import { readFileSync } from "node:fs";
import { platform } from "node:os";
import { env } from "node:process";

/** Supported host platform types. */
export type HostPlatform = "windows-wsl" | "windows-native" | "macos" | "linux";

/** Cached platform detection result. */
let cachedPlatform: HostPlatform | null = null;

/**
 * Detect the host platform.
 *
 * Detection order:
 * 1. Windows native (process.platform === "win32")
 * 2. WSL (Linux kernel with "microsoft" in /proc/version)
 * 3. macOS (process.platform === "darwin")
 * 4. Linux (fallback)
 *
 * Result is cached for performance.
 */
export function detectHostPlatform(): HostPlatform {
  if (cachedPlatform !== null) {
    return cachedPlatform;
  }

  const os = platform();

  if (os === "win32") {
    cachedPlatform = "windows-native";
    return cachedPlatform;
  }

  if (os === "darwin") {
    cachedPlatform = "macos";
    return cachedPlatform;
  }

  // Linux — check if WSL
  if (os === "linux") {
    try {
      const procVersion = readFileSync("/proc/version", "utf-8");
      if (procVersion.toLowerCase().includes("microsoft")) {
        cachedPlatform = "windows-wsl";
        return cachedPlatform;
      }
    } catch {
      // Can't read /proc/version — not WSL
    }

    // Fallback: check WSL env vars
    if (env.WSL_DISTRO_NAME ?? env.WSLENV) {
      cachedPlatform = "windows-wsl";
      return cachedPlatform;
    }
  }

  cachedPlatform = "linux";
  return cachedPlatform;
}

/**
 * Whether the host platform requires FUSE for path translation.
 *
 * FUSE is needed on Windows (WSL and native) where host paths differ
 * from container POSIX paths. macOS and Linux don't need path translation
 * since paths are already POSIX-compatible.
 */
export function needsFuse(): boolean {
  const p = detectHostPlatform();
  return p === "windows-wsl" || p === "windows-native";
}

/**
 * Whether the host platform needs --privileged for FUSE /dev/fuse access.
 *
 * Windows Docker Desktop requires --privileged because /dev/fuse is not
 * directly passable via --device. Linux/macOS use --device /dev/fuse.
 */
export function needsPrivilegedForFuse(): boolean {
  const p = detectHostPlatform();
  return p === "windows-native";
}

/**
 * Get the Docker socket path for the current platform.
 */
export function getDockerSocketPath(): string {
  const p = detectHostPlatform();
  switch (p) {
    case "windows-native":
      return "//./pipe/docker_engine";
    case "windows-wsl":
    case "linux":
    case "macos":
      return "/var/run/docker.sock";
  }
}

/**
 * Get the clipboard read command for the current platform.
 *
 * Returns the command and arguments to read image data from clipboard.
 * Returns null if no clipboard command is available.
 */
export function getClipboardImageCommand(): { cmd: string; args: string[] } | null {
  const p = detectHostPlatform();
  switch (p) {
    case "windows-native":
    case "windows-wsl":
      return {
        cmd: "powershell.exe",
        args: ["-NoProfile", "-Command", "Get-Clipboard -Format Image | ForEach-Object { $_.Save([Console]::OpenStandardOutput(), [System.Drawing.Imaging.ImageFormat]::Png) }"],
      };
    case "macos":
      return {
        cmd: "osascript",
        args: ["-e", "set png to (the clipboard as «class PNGf»)"],
      };
    case "linux": {
      // Prefer wl-paste for Wayland, fall back to xclip for X11
      if (env.WAYLAND_DISPLAY) {
        return { cmd: "wl-paste", args: ["--type", "image/png"] };
      }
      if (env.DISPLAY) {
        return { cmd: "xclip", args: ["-selection", "clipboard", "-t", "image/png", "-o"] };
      }
      return null;
    }
  }
}

/**
 * Get the clipboard text read command for the current platform.
 */
export function getClipboardTextCommand(): { cmd: string; args: string[] } | null {
  const p = detectHostPlatform();
  switch (p) {
    case "windows-native":
    case "windows-wsl":
      return { cmd: "powershell.exe", args: ["-NoProfile", "-Command", "Get-Clipboard"] };
    case "macos":
      return { cmd: "pbpaste", args: [] };
    case "linux": {
      if (env.WAYLAND_DISPLAY) {
        return { cmd: "wl-paste", args: [] };
      }
      if (env.DISPLAY) {
        return { cmd: "xclip", args: ["-selection", "clipboard", "-o"] };
      }
      return null;
    }
  }
}

/**
 * Whether path translation is needed between host and container.
 *
 * On Windows (both WSL and native), host paths use different formats
 * than container POSIX paths. macOS and Linux use POSIX paths natively.
 */
export function needsPathTranslation(): boolean {
  const p = detectHostPlatform();
  return p === "windows-wsl" || p === "windows-native";
}

/**
 * Get human-readable host OS name for display.
 */
export function getHostOSName(): string {
  const p = detectHostPlatform();
  switch (p) {
    case "windows-native":
    case "windows-wsl":
      return "Windows";
    case "macos":
      return "macOS";
    case "linux":
      return "Linux";
  }
}

/**
 * Check if a command exists on the host system.
 */
export function commandExists(command: string): boolean {
  try {
    const { execSync } = require("node:child_process");
    execSync(`which ${command}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Reset cached platform (for testing). */
export function _resetPlatformCache(): void {
  cachedPlatform = null;
}
