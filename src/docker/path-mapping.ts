/**
 * Docker path mapping utilities for ccbox.
 *
 * Handles path conversion between Windows, WSL, and Docker formats.
 * Docker Desktop on Windows expects Windows paths with forward slashes: C:/Users/...
 */

import { platform } from "node:process";

import { PathError } from "../errors.js";
import { isUncPath, isWindowsPath } from "../platform/detection.js";

/**
 * Normalize path separators to forward slashes and remove duplicates.
 */
function normalizePathSeparators(pathStr: string): string {
  let normalized = pathStr.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  if (normalized.length > 1) {
    normalized = normalized.replace(/\/$/, "");
  }
  return normalized;
}

/**
 * Convert Windows path to Docker Desktop compatible format.
 */
export function windowsToDockerPath(path: string): string {
  const pathStr = String(path);
  const match = pathStr.match(/^([A-Za-z]):[/\\]*(.*)$/);
  if (!match) {
    return pathStr;
  }
  const drive = match[1]!.toUpperCase();
  const rest = match[2] ?? "";
  const normalizedRest = normalizePathSeparators(rest);
  if (!normalizedRest) {
    return `${drive}:/`;
  }
  return `${drive}:/${normalizedRest}`;
}

/**
 * Convert WSL path to Docker Desktop compatible format.
 */
export function wslToDockerPath(path: string): string {
  const pathStr = String(path);
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
 */
function validateDockerPath(path: string, resolvedStr: string): void {
  if (resolvedStr.includes("..")) {
    throw new PathError(
      `Path traversal not allowed: "${path}" resolved to "${resolvedStr}" which contains ".." (expected absolute path without parent references)`
    );
  }
  if (resolvedStr.includes("\x00")) {
    const nullPosition = resolvedStr.indexOf("\x00");
    throw new PathError(
      `Null bytes not allowed in path: "${path}" contains null byte at position ${nullPosition} (expected printable characters only)`
    );
  }
}

/**
 * Resolve path to Docker-compatible format.
 * Main function for Docker volume mounts.
 */
export function resolveForDocker(path: string): string {
  const pathStr = path.replace(/\\/g, "/");

  if (isUncPath(pathStr)) {
    validateDockerPath(path, pathStr);
    return pathStr;
  }

  if (isWindowsPath(pathStr)) {
    const result = windowsToDockerPath(pathStr);
    validateDockerPath(path, result);
    return result;
  }

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

  validateDockerPath(path, pathStr);
  return pathStr;
}

/**
 * Format container path to prevent MSYS path translation on Windows.
 */
export function containerPath(path: string): string {
  if (platform === "win32" && path.startsWith("/")) {
    return "/" + path;
  }
  return path;
}

/**
 * Get environment dict for running Docker commands on Windows.
 */
export function getDockerMountEnv(): NodeJS.ProcessEnv {
  const envCopy = { ...process.env };
  if (platform === "win32") {
    envCopy.MSYS_NO_PATHCONV = "1";
    envCopy.MSYS2_ARG_CONV_EXCL = "*";
  }
  return envCopy;
}
