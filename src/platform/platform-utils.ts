/**
 * Platform utility functions for ccbox.
 *
 * Cross-platform detection of UID/GID, timezone, terminal size.
 * Extracted from docker-runtime.ts for reusability.
 */

import { existsSync, readFileSync, readlinkSync } from "node:fs";
import { platform } from "node:os";
import { env } from "node:process";

import { log } from "../logger.js";

/**
 * Get host UID and GID for container user mapping (cross-platform).
 *
 * - Windows: Returns [1000, 1000] (no native UID/GID)
 * - Linux/macOS: Returns actual host UID/GID
 */
export function getHostUserIds(): [number, number] {
  if (platform() === "win32") {
    return [1000, 1000];
  }
  return [process.getuid?.() ?? 1000, process.getgid?.() ?? 1000];
}

/**
 * Get host timezone in IANA format (cross-platform).
 */
export function getHostTimezone(): string {
  const tzEnv = env.TZ;
  if (tzEnv && tzEnv.includes("/")) {
    return tzEnv;
  }

  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (tz && tz.includes("/")) {
      return tz;
    }
  } catch (e) {
    log.debug(`Intl timezone detection error: ${String(e)}`);
  }

  if (platform() !== "win32") {
    try {
      const tzFile = "/etc/timezone";
      if (existsSync(tzFile)) {
        const tz = readFileSync(tzFile, "utf-8").trim();
        if (tz && tz.includes("/")) {
          return tz;
        }
      }
    } catch (e) {
      log.debug(`/etc/timezone read error: ${String(e)}`);
    }

    try {
      const localtime = "/etc/localtime";
      const target = readlinkSync(localtime);
      if (target.includes("zoneinfo/")) {
        const tz = target.split("zoneinfo/")[1];
        if (tz && tz.includes("/")) {
          return tz;
        }
      }
    } catch (e) {
      log.debug(`/etc/localtime read error: ${String(e)}`);
    }
  }

  return "UTC";
}

/**
 * Get terminal size (cross-platform).
 */
export function getTerminalSize(): { columns: number; lines: number } {
  const columns = process.stdout.columns ?? 120;
  const lines = process.stdout.rows ?? 40;
  return { columns, lines };
}

/**
 * Detect platform string for download URLs.
 */
export function detectPlatform(): string {
  const os = process.platform === "win32" ? "windows"
    : process.platform === "darwin" ? "darwin"
    : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  return `${os}-${arch}`;
}
