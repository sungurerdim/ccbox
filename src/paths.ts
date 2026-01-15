/**
 * Cross-platform path utilities for Docker mount compatibility.
 *
 * Handles path conversion between Windows, WSL, and Docker formats.
 * Docker Desktop on Windows expects Windows paths with forward slashes: C:/Users/...
 *
 * Dependency direction:
 *   This module has minimal internal dependencies (near-leaf module).
 *   It may be imported by: generator.ts, cli.ts, docker.ts
 *   It should NOT import from: cli, generator
 */

import { existsSync, statSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { platform, env } from "node:process";

import { PathError } from "./errors.js";

/** Cached WSL detection result */
let wslCached: boolean | null = null;

/**
 * Check if path is a Windows-style path (e.g., D:\\GitHub or D:/GitHub).
 *
 * @param path - Path to check.
 * @returns True if path looks like a Windows path (has drive letter).
 */
export function isWindowsPath(path: string): boolean {
  return /^[A-Za-z]:[/\\]/.test(path);
}

/**
 * Check if running inside WSL.
 *
 * Result is cached for performance.
 *
 * @returns True if running in WSL environment.
 */
export function isWsl(): boolean {
  if (wslCached !== null) {
    return wslCached;
  }

  // Check for WSL-specific kernel
  try {
    const procVersion = readFileSync("/proc/version", "utf-8");
    if (procVersion.toLowerCase().includes("microsoft")) {
      wslCached = true;
      return true;
    }
  } catch {
    // Not WSL or can't read /proc/version
  }

  // Fallback: check WSL env vars
  wslCached = Boolean(env.WSL_DISTRO_NAME ?? env.WSLENV);
  return wslCached;
}

/**
 * Normalize path separators to forward slashes and remove duplicates.
 *
 * @param pathStr - Path string to normalize.
 * @returns Normalized path with single forward slashes.
 */
function normalizePathSeparators(pathStr: string): string {
  // Convert backslashes to forward slashes
  let normalized = pathStr.replace(/\\/g, "/");

  // Remove all duplicate slashes
  while (normalized.includes("//")) {
    normalized = normalized.replace(/\/\//g, "/");
  }

  // Remove trailing slash (unless it's root)
  if (normalized.length > 1) {
    normalized = normalized.replace(/\/$/, "");
  }

  return normalized;
}

/**
 * Convert Windows path to Docker Desktop compatible format.
 *
 * Docker Desktop on Windows expects Windows paths with forward slashes.
 * The /c/... format only works in Git Bash (MSYS path translation).
 *
 * @param path - Windows path to convert.
 * @returns Docker-compatible path (Windows format with forward slashes).
 *
 * @example
 * windowsToDockerPath("D:\\GitHub\\Project") // => "D:/GitHub/Project"
 * windowsToDockerPath("C:/Users/name/project") // => "C:/Users/name/project"
 * windowsToDockerPath("C:\\") // => "C:/"
 */
export function windowsToDockerPath(path: string): string {
  const pathStr = String(path);

  // Extract drive letter and rest of path
  const match = pathStr.match(/^([A-Za-z]):[/\\]*(.*)$/);
  if (!match) {
    return pathStr; // Not a Windows path, return as-is
  }

  const drive = match[1]!.toUpperCase();
  const rest = match[2] ?? "";

  // Normalize separators (handles backslashes, duplicates, trailing)
  const normalizedRest = normalizePathSeparators(rest);

  // Handle root drive case (C:\ or C:)
  if (!normalizedRest) {
    return `${drive}:/`;
  }

  return `${drive}:/${normalizedRest}`;
}

/**
 * Convert WSL path to Docker Desktop compatible format.
 *
 * WSL paths like /mnt/d/GitHub/Project need to be converted to
 * Docker Desktop format: /d/GitHub/Project
 *
 * @param path - WSL path to convert.
 * @returns Docker-compatible POSIX path.
 *
 * @example
 * wslToDockerPath("/mnt/c/Users/name/project") // => "/c/Users/name/project"
 * wslToDockerPath("/mnt/d/") // => "/d"
 */
export function wslToDockerPath(path: string): string {
  const pathStr = String(path);

  // WSL mount pattern: /mnt/[drive]/...
  const match = pathStr.match(/^\/mnt\/([a-z])(?:\/(.*))?$/);
  if (match) {
    const drive = match[1]!;
    const rest = match[2] ?? "";
    const normalizedRest = normalizePathSeparators(rest);

    if (!normalizedRest) {
      return `/${drive}`;
    }
    return `/${drive}/${normalizedRest}`;
  }

  return pathStr;
}

/**
 * Validate that resolved path is within expected boundaries.
 *
 * @param path - Original path string.
 * @param resolvedStr - Resolved Docker path string.
 * @throws PathError if path validation fails.
 */
function validateDockerPath(path: string, resolvedStr: string): void {
  // Check for path traversal attempts
  if (resolvedStr.includes("..")) {
    throw new PathError(`Path traversal not allowed: ${path}`);
  }

  // Check for null bytes (security)
  if (resolvedStr.includes("\x00")) {
    throw new PathError(`Null bytes not allowed in path: ${path}`);
  }
}

/**
 * Resolve path to Docker-compatible format.
 *
 * This is the main function to use for Docker volume mounts.
 * Handles all platform variations automatically.
 *
 * Handles:
 * - Windows paths (D:\\GitHub\\...) -> D:/GitHub/...
 * - WSL paths (/mnt/d/...) -> /d/... (for WSL Docker integration)
 * - Native Linux/macOS paths -> unchanged
 *
 * @param path - Path to resolve (should already be absolute/resolved).
 * @returns Docker-compatible path string for volume mounts.
 * @throws PathError if path validation fails.
 *
 * @example
 * resolveForDocker("D:/GitHub/Project") // => "D:/GitHub/Project"
 * resolveForDocker("/mnt/c/Users/name") // => "/c/Users/name"
 * resolveForDocker("/home/user/project") // => "/home/user/project"
 */
export function resolveForDocker(path: string): string {
  // Normalize backslashes for consistent pattern matching
  const pathStr = path.replace(/\\/g, "/");

  // Case 1: Windows-style path
  if (isWindowsPath(pathStr)) {
    const result = windowsToDockerPath(pathStr);
    validateDockerPath(path, result);
    return result;
  }

  // Case 2: WSL mount path (/mnt/[a-z] or /mnt/[a-z]/...)
  if (
    pathStr.startsWith("/mnt/") &&
    pathStr.length >= 6 &&
    /[a-z]/.test(pathStr[5]!) &&
    (pathStr.length === 6 || pathStr[6] === "/")
  ) {
    const result = wslToDockerPath(pathStr);
    validateDockerPath(path, result);
    return result;
  }

  // Case 3: Native Linux/macOS path - use as-is
  validateDockerPath(path, pathStr);
  return pathStr;
}

/**
 * Format container path to prevent MSYS path translation on Windows.
 *
 * Git Bash (MSYS2) translates Unix-style paths like /home/node to
 * C:/Program Files/Git/home/node. Double slashes prevent this.
 *
 * @param path - Container path (must start with /).
 * @returns Path with // prefix on Windows, unchanged on other platforms.
 *
 * @example
 * containerPath("/home/node/.claude") // Windows: "//home/node/.claude"
 * containerPath("/home/node/.claude") // Linux/macOS: "/home/node/.claude"
 */
export function containerPath(path: string): string {
  if (platform === "win32" && path.startsWith("/")) {
    return "/" + path; // Double slash prevents MSYS translation
  }
  return path;
}

/**
 * Get environment dict for running Docker commands on Windows.
 *
 * On Windows with Git Bash (MSYS2), path translation must be disabled
 * to prevent /home/node/.claude from becoming C:/Program Files/Git/home/node/.claude.
 *
 * @returns Environment dict with MSYS_NO_PATHCONV=1 on Windows, copy of process.env otherwise.
 */
export function getDockerEnv(): NodeJS.ProcessEnv {
  const envCopy = { ...process.env };

  if (platform === "win32") {
    // Disable MSYS path conversion for Docker volume mounts
    envCopy.MSYS_NO_PATHCONV = "1";
    envCopy.MSYS2_ARG_CONV_EXCL = "*"; // Also disable for MSYS2
  }

  return envCopy;
}

/**
 * Validate and resolve a project path.
 *
 * @param path - Path to validate.
 * @returns Resolved absolute path.
 * @throws PathError if path doesn't exist or is not a directory.
 */
export function validateProjectPath(path: string): string {
  const projectPath = resolve(path);

  if (!existsSync(projectPath)) {
    throw new PathError(`Project path does not exist: ${projectPath}`);
  }

  const stats = statSync(projectPath);
  if (!stats.isDirectory()) {
    throw new PathError(`Project path must be a directory: ${projectPath}`);
  }

  return projectPath;
}

/**
 * Validate and resolve a file path.
 *
 * @param path - Path to validate.
 * @param mustExist - If true, path must exist.
 * @returns Resolved absolute path.
 * @throws PathError if path validation fails.
 */
export function validateFilePath(path: string, mustExist = true): string {
  const filePath = resolve(path);

  if (mustExist && !existsSync(filePath)) {
    throw new PathError(`File does not exist: ${filePath}`);
  }

  if (existsSync(filePath)) {
    const stats = statSync(filePath);
    if (!stats.isFile()) {
      throw new PathError(`Path is not a file: ${filePath}`);
    }
  }

  return filePath;
}
