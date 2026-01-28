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

import { existsSync, lstatSync, statSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
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
 * Check if path is a Windows UNC path (e.g., \\\\server\\share or //server/share).
 *
 * UNC (Universal Naming Convention) paths are used for network shares on Windows.
 *
 * @param path - Path to check.
 * @returns True if path looks like a UNC path.
 */
export function isUncPath(path: string): boolean {
  // Match \\server\share or //server/share patterns
  return /^(?:\\\\|\/\/)[^/\\]+[/\\][^/\\]+/.test(path);
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
  // Convert backslashes to forward slashes and collapse duplicate slashes
  let normalized = pathStr.replace(/\\/g, "/").replace(/\/{2,}/g, "/");

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
    throw new PathError(
      `Path traversal not allowed: "${path}" resolved to "${resolvedStr}" which contains ".." (expected absolute path without parent references)`
    );
  }

  // Check for null bytes (security)
  if (resolvedStr.includes("\x00")) {
    const nullPosition = resolvedStr.indexOf("\x00");
    throw new PathError(
      `Null bytes not allowed in path: "${path}" contains null byte at position ${nullPosition} (expected printable characters only)`
    );
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

  // Case 1: Windows UNC path (//server/share/...)
  // Docker Desktop on Windows supports UNC paths directly
  if (isUncPath(pathStr)) {
    validateDockerPath(path, pathStr);
    return pathStr;
  }

  // Case 2: Windows-style path (C:/...)
  if (isWindowsPath(pathStr)) {
    const result = windowsToDockerPath(pathStr);
    validateDockerPath(path, result);
    return result;
  }

  // Case 3: WSL mount path (/mnt/[a-z] or /mnt/[a-z]/...)
  if (
    pathStr.startsWith("/mnt/") &&
    pathStr.length >= 6 &&
    /[a-z]/i.test(pathStr[5]!) &&
    (pathStr.length === 6 || pathStr[6] === "/")
  ) {
    const result = wslToDockerPath(pathStr);
    validateDockerPath(path, result);
    return result;
  }

  // Case 4: Native Linux/macOS path - use as-is
  validateDockerPath(path, pathStr);
  return pathStr;
}

/**
 * Format container path to prevent MSYS path translation on Windows.
 *
 * Git Bash (MSYS2) translates Unix-style paths like /ccbox to
 * C:/Program Files/Git/ccbox. Double slashes prevent this.
 *
 * @param path - Container path (must start with /).
 * @returns Path with // prefix on Windows, unchanged on other platforms.
 *
 * @example
 * containerPath("/ccbox/.claude") // Windows: "//ccbox/.claude"
 * containerPath("/ccbox/.claude") // Linux/macOS: "/ccbox/.claude"
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
 * to prevent /ccbox/.claude from becoming C:/Program Files/Git/ccbox/.claude.
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

  const stats = lstatSync(projectPath);

  // Security: reject symlinks to prevent symlink-based path traversal
  if (stats.isSymbolicLink()) {
    throw new PathError(`Project path cannot be a symlink: ${projectPath}`);
  }

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

/**
 * Get the Claude config directory path.
 *
 * @returns Absolute path to ~/.claude directory.
 */
export function getClaudeConfigDir(): string {
  return join(homedir(), ".claude");
}

// ═══════════════════════════════════════════════════════════════════════════
// Project Directory Name Handling
// ═══════════════════════════════════════════════════════════════════════════

/** Maximum bytes for a directory name (ext4/NTFS filesystem limit) */
const MAX_DIR_NAME_BYTES = 255;

/** Reserved names on Windows that cannot be used as directory names */
const WINDOWS_RESERVED_NAMES = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  "com1",
  "com2",
  "com3",
  "com4",
  "com5",
  "com6",
  "com7",
  "com8",
  "com9",
  "lpt1",
  "lpt2",
  "lpt3",
  "lpt4",
  "lpt5",
  "lpt6",
  "lpt7",
  "lpt8",
  "lpt9",
]);

/**
 * Normalize a project directory name for cross-platform compatibility.
 *
 * Strategy: Preserve the original name as much as possible, only applying
 * minimal transformations when absolutely necessary for compatibility.
 *
 * Transformations applied:
 * 1. Unicode NFC normalization (canonical composition)
 * 2. Remove null bytes (security)
 * 3. Remove control characters (U+0000-U+001F, U+007F-U+009F)
 * 4. Trim leading/trailing whitespace
 * 5. Replace Windows-reserved trailing chars (space, dot)
 * 6. Truncate if exceeds filesystem byte limit
 *
 * @param dirName - Raw directory name from filesystem.
 * @returns Normalized directory name safe for container paths.
 */
export function normalizeProjectDirName(dirName: string): string {
  if (!dirName) {
    return "project";
  }

  let normalized = dirName;

  // 1. Unicode NFC normalization (canonical composition)
  // This ensures é (e + combining acute) becomes é (precomposed)
  // Prevents duplicate-looking filenames due to different encodings
  normalized = normalized.normalize("NFC");

  // 2. Remove null bytes (security - prevents path truncation attacks)
  // eslint-disable-next-line no-control-regex
  normalized = normalized.replace(/\x00/g, "");

  // 3. Remove control characters (invisible, cause display issues)
  // U+0000-U+001F (C0 controls) and U+007F-U+009F (DEL + C1 controls)
  // eslint-disable-next-line no-control-regex
  normalized = normalized.replace(/[\x00-\x1F\x7F-\x9F]/g, "");

  // 4. Trim leading/trailing whitespace
  normalized = normalized.trim();

  // 5. Windows compatibility: remove trailing spaces and dots
  // Windows filesystems silently strip these, causing path mismatches
  normalized = normalized.replace(/[. ]+$/, "");

  // 6. Truncate if exceeds filesystem byte limit (255 bytes for ext4/NTFS)
  // Use Buffer to count actual UTF-8 bytes, not JS string length
  if (Buffer.byteLength(normalized, "utf8") > MAX_DIR_NAME_BYTES) {
    // Truncate character by character until within limit
    while (
      Buffer.byteLength(normalized, "utf8") > MAX_DIR_NAME_BYTES &&
      normalized.length > 0
    ) {
      normalized = normalized.slice(0, -1);
    }
    // Re-trim in case truncation left trailing whitespace
    normalized = normalized.trim();
  }

  // Fallback if everything was stripped
  if (!normalized) {
    return "project";
  }

  return normalized;
}

/**
 * Validation result for project directory names.
 */
export interface DirNameValidation {
  /** Whether the name is valid (no blocking issues) */
  valid: boolean;
  /** Normalized name (use this for container paths) */
  normalized: string;
  /** Blocking errors that prevent usage */
  errors: string[];
  /** Non-blocking warnings (name will still work) */
  warnings: string[];
}

/**
 * Validate a project directory name for Docker container compatibility.
 *
 * Returns both errors (blocking) and warnings (informational).
 * The normalized name is always provided and safe to use.
 *
 * @param dirName - Raw directory name to validate.
 * @returns Validation result with normalized name, errors, and warnings.
 */
export function validateProjectDirName(dirName: string): DirNameValidation {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Normalize first
  const normalized = normalizeProjectDirName(dirName);

  // Check for empty/whitespace-only names
  if (!dirName || !dirName.trim()) {
    errors.push("Directory name is empty");
    return { valid: false, normalized: "project", errors, warnings };
  }

  // Check byte length of original (before truncation)
  const originalBytes = Buffer.byteLength(dirName, "utf8");
  if (originalBytes > MAX_DIR_NAME_BYTES) {
    warnings.push(
      `Name exceeds ${MAX_DIR_NAME_BYTES} bytes (${originalBytes} bytes), will be truncated`
    );
  }

  // Check for Windows reserved names
  const lowerName = normalized.toLowerCase().replace(/\.[^.]*$/, ""); // Remove extension
  if (WINDOWS_RESERVED_NAMES.has(lowerName)) {
    warnings.push(
      `"${normalized}" is a reserved name on Windows, may cause issues`
    );
  }

  // Check for problematic patterns (warnings only - name still works)
  if (normalized !== dirName) {
    if (dirName !== dirName.normalize("NFC")) {
      warnings.push("Name contains non-normalized Unicode characters (NFD)");
    }
    // eslint-disable-next-line no-control-regex
    if (/[\x00-\x1F\x7F-\x9F]/.test(dirName)) {
      warnings.push("Name contains control characters (removed)");
    }
    if (dirName !== dirName.trim()) {
      warnings.push("Name has leading/trailing whitespace (trimmed)");
    }
    if (/[. ]+$/.test(dirName.trim())) {
      warnings.push("Name has trailing dots/spaces (removed for Windows)");
    }
  }

  // Informational warnings for non-ASCII (not errors, just heads-up)
  if (/[^\x20-\x7E]/.test(normalized)) {
    // Has characters outside printable ASCII
    if (/\p{Emoji}/u.test(normalized)) {
      warnings.push("Name contains emoji characters");
    } else if (/[\u4E00-\u9FFF\u3400-\u4DBF]/.test(normalized)) {
      warnings.push("Name contains CJK (Chinese/Japanese/Korean) characters");
    } else if (/[\u0600-\u06FF]/.test(normalized)) {
      warnings.push("Name contains Arabic characters");
    } else if (/[\u0590-\u05FF]/.test(normalized)) {
      warnings.push("Name contains Hebrew characters");
    // eslint-disable-next-line no-control-regex
    } else if (/[^\x00-\x7F]/.test(normalized)) {
      warnings.push("Name contains non-ASCII characters");
    }
  }

  // Check for shell-sensitive characters (informational - execa handles these)
  if (/[$`'"\\!&|;*?[\]{}()<>]/.test(normalized)) {
    warnings.push(
      "Name contains shell special characters (safe with current implementation)"
    );
  }

  return {
    valid: errors.length === 0,
    normalized,
    errors,
    warnings,
  };
}

/**
 * Sanitize a project name for Docker identifiers (container names, image tags).
 *
 * Docker requires: lowercase, alphanumeric, hyphens, underscores, dots.
 * Max length for container names is 64 characters.
 *
 * @param name - Project name to sanitize.
 * @param maxLength - Maximum length (default: 50 to leave room for prefixes/suffixes).
 * @returns Docker-safe identifier string.
 */
export function sanitizeForDocker(name: string, maxLength = 50): string {
  if (!name) {
    return "project";
  }

  let safe = name
    // Lowercase (Docker convention)
    .toLowerCase()
    // Replace any non-allowed character with hyphen
    .replace(/[^a-z0-9._-]/g, "-")
    // Collapse multiple hyphens
    .replace(/-{2,}/g, "-")
    // Remove leading/trailing hyphens and dots
    .replace(/^[-_.]+|[-_.]+$/g, "");

  // Apply max length
  if (safe.length > maxLength) {
    safe = safe.slice(0, maxLength).replace(/[-_.]+$/, "");
  }

  return safe || "project";
}

