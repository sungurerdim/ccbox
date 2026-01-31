/**
 * Platform detection utilities for ccbox.
 *
 * Detects Windows paths, WSL environment, and other platform-specific traits.
 */

import { readFileSync } from "node:fs";
import { env } from "node:process";

/** Cached WSL detection result */
let wslCached: boolean | null = null;

/**
 * Check if path is a Windows-style path (e.g., D:\\GitHub or D:/GitHub).
 */
export function isWindowsPath(path: string): boolean {
  return /^[A-Za-z]:[/\\]/.test(path);
}

/**
 * Check if path is a Windows UNC path (e.g., \\\\server\\share or //server/share).
 */
export function isUncPath(path: string): boolean {
  return /^(?:\\\\|\/\/)[^/\\]+[/\\][^/\\]+/.test(path);
}

/**
 * Check if running inside WSL. Result is cached for performance.
 */
export function isWsl(): boolean {
  if (wslCached !== null) {
    return wslCached;
  }

  try {
    const procVersion = readFileSync("/proc/version", "utf-8");
    if (procVersion.toLowerCase().includes("microsoft")) {
      wslCached = true;
      return true;
    }
  } catch {
    // Not WSL or can't read /proc/version
  }

  wslCached = Boolean(env.WSL_DISTRO_NAME ?? env.WSLENV);
  return wslCached;
}
