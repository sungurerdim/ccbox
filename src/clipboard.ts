/**
 * Clipboard bridge for ccbox.
 *
 * Transfers clipboard images from host to running ccbox container.
 * Uses platform-specific clipboard commands to read image data,
 * then docker cp to transfer into the container.
 *
 * Dependency direction:
 *   This module imports from: platform.ts, exec.ts, logger.ts
 *   It should NOT import from: cli, generator, docker-runtime
 */

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { exec } from "./exec.js";
import { log } from "./logger.js";
import { detectHostPlatform } from "./platform.js";
import { getDockerEnv } from "./paths.js";
import { DOCKER_COMMAND_TIMEOUT, getCcboxTempClipboard } from "./constants.js";
import { findRunningContainer } from "./docker-utils.js";

/** Clipboard read timeout in milliseconds. */
const CLIPBOARD_TIMEOUT = 10_000;

/** Read clipboard image on Windows (native or WSL). */
async function readClipboardWindows(tmpFile: string): Promise<{ exitCode: number } | null> {
  const winPath = tmpFile.replace(/\//g, "\\");
  return exec("powershell.exe", [
    "-NoProfile", "-Command",
    `$img = Get-Clipboard -Format Image; if ($img) { $img.Save('${winPath}', [System.Drawing.Imaging.ImageFormat]::Png) } else { exit 1 }`,
  ], { timeout: CLIPBOARD_TIMEOUT });
}

/** Read clipboard image on macOS. */
async function readClipboardMacOS(tmpFile: string): Promise<{ exitCode: number } | null> {
  return exec("bash", [
    "-c",
    `osascript -e 'set png to (the clipboard as «class PNGf»)' -e 'set f to open for access POSIX file "${tmpFile}" with write permission' -e 'write png to f' -e 'close access f' 2>/dev/null`,
  ], { timeout: CLIPBOARD_TIMEOUT });
}

/** Read clipboard image on Linux (X11 or Wayland). */
async function readClipboardLinux(tmpFile: string): Promise<{ exitCode: number } | null> {
  const { env: procEnv } = await import("node:process");

  if (procEnv.WAYLAND_DISPLAY) {
    return exec("bash", ["-c", `wl-paste --type image/png > "${tmpFile}"`], { timeout: CLIPBOARD_TIMEOUT });
  }
  if (procEnv.DISPLAY) {
    return exec("bash", ["-c", `xclip -selection clipboard -t image/png -o > "${tmpFile}"`], { timeout: CLIPBOARD_TIMEOUT });
  }

  log.warn("No display server detected (X11/Wayland). Cannot access clipboard.");
  return null;
}

/**
 * Read image from clipboard and save to temp file.
 *
 * @returns Path to temp PNG file, or null if no image in clipboard.
 */
async function readClipboardImage(): Promise<string | null> {
  const platform = detectHostPlatform();
  const tmpDir = getCcboxTempClipboard();
  mkdirSync(tmpDir, { recursive: true });
  const tmpFile = join(tmpDir, `paste-${Date.now()}.png`);

  try {
    let result: { exitCode: number } | null = null;

    switch (platform) {
      case "windows-native":
      case "windows-wsl":
        result = await readClipboardWindows(tmpFile);
        break;
      case "macos":
        result = await readClipboardMacOS(tmpFile);
        break;
      case "linux":
        result = await readClipboardLinux(tmpFile);
        break;
    }

    if (result && result.exitCode === 0 && existsSync(tmpFile)) {
      return tmpFile;
    }
  } catch (e) {
    log.debug(`Clipboard read failed: ${String(e)}`);
  }

  return null;
}

/**
 * Paste clipboard image into a running ccbox container.
 *
 * Reads image from host clipboard and transfers it into the container
 * at /tmp/clipboard/ for Claude Code to access.
 *
 * @param containerName - Optional specific container name. Auto-detects if not provided.
 * @returns True if image was transferred successfully.
 */
export async function pasteToContainer(containerName?: string): Promise<boolean> {
  const container = containerName ?? await findRunningContainer();
  if (!container) {
    log.error("No running ccbox container found.");
    log.dim("Start a session with 'ccbox' first, then use 'ccbox paste' in another terminal.");
    return false;
  }

  log.dim("Reading clipboard...");
  const imagePath = await readClipboardImage();
  if (!imagePath) {
    log.warn("No image found in clipboard.");
    return false;
  }

  // Ensure target directory exists in container
  try {
    await exec("docker", [
      "exec", container, "mkdir", "-p", "/tmp/clipboard",
    ], { timeout: DOCKER_COMMAND_TIMEOUT, env: getDockerEnv() });
  } catch {
    log.warn("Failed to create clipboard directory in container.");
    return false;
  }

  // Copy image to container
  const filename = `clipboard-${Date.now()}.png`;
  const containerPath = `/tmp/clipboard/${filename}`;

  try {
    const copyResult = await exec("docker", [
      "cp", imagePath, `${container}:${containerPath}`,
    ], { timeout: DOCKER_COMMAND_TIMEOUT, env: getDockerEnv() });

    if (copyResult.exitCode !== 0) {
      log.error("Failed to copy image to container");
      return false;
    }

    // Inject path reference into active session
    const injectResult = await exec("docker", [
      "exec", container, "/usr/local/bin/ccbox-inject",
      `Look at this image I just pasted: ${containerPath}`,
    ], { timeout: 10_000, env: getDockerEnv() });

    if (injectResult.exitCode === 0) {
      log.success("Image pasted and sent to active session");
    } else {
      log.warn(`Image copied but injection failed: ${containerPath}`);
    }
    return true;
  } catch (e) {
    log.error(`Failed to paste to container: ${String(e)}`);
  }

  return false;
}
