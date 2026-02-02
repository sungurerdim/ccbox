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
import { tmpdir } from "node:os";
import { join } from "node:path";

import { exec } from "./exec.js";
import { log } from "./logger.js";
import { detectHostPlatform } from "./platform.js";
import { getDockerEnv } from "./paths.js";
import { DOCKER_COMMAND_TIMEOUT } from "./constants.js";

/**
 * Find a running ccbox container.
 *
 * @returns Container name or null if none found.
 */
async function findRunningContainer(): Promise<string | null> {
  try {
    const result = await exec("docker", [
      "ps", "--format", "{{.Names}}",
      "--filter", "name=ccbox",
    ], { timeout: DOCKER_COMMAND_TIMEOUT, env: getDockerEnv() });

    const containers = result.stdout.trim().split("\n").filter(Boolean);
    return containers[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * Read image from clipboard and save to temp file.
 *
 * @returns Path to temp PNG file, or null if no image in clipboard.
 */
async function readClipboardImage(): Promise<string | null> {
  const platform = detectHostPlatform();
  const tmpDir = join(tmpdir(), "ccbox", "clipboard");
  mkdirSync(tmpDir, { recursive: true });
  const tmpFile = join(tmpDir, `paste-${Date.now()}.png`);

  try {
    let result;

    switch (platform) {
      case "windows-native":
      case "windows-wsl":
        result = await exec("powershell.exe", [
          "-NoProfile", "-Command",
          `$img = Get-Clipboard -Format Image; if ($img) { $img.Save('${tmpFile.replace(/\//g, "\\")}', [System.Drawing.Imaging.ImageFormat]::Png) } else { exit 1 }`,
        ], { timeout: 10_000 });
        break;

      case "macos":
        result = await exec("bash", [
          "-c",
          `osascript -e 'set png to (the clipboard as «class PNGf»)' -e 'set f to open for access POSIX file "${tmpFile}" with write permission' -e 'write png to f' -e 'close access f' 2>/dev/null`,
        ], { timeout: 10_000 });
        break;

      case "linux": {
        const { env: procEnv } = await import("node:process");
        if (procEnv.WAYLAND_DISPLAY) {
          result = await exec("bash", ["-c", `wl-paste --type image/png > "${tmpFile}"`], { timeout: 10_000 });
        } else if (procEnv.DISPLAY) {
          result = await exec("bash", ["-c", `xclip -selection clipboard -t image/png -o > "${tmpFile}"`], { timeout: 10_000 });
        } else {
          log.warn("No display server detected (X11/Wayland). Cannot access clipboard.");
          return null;
        }
        break;
      }
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
  try {
    const result = await exec("docker", [
      "cp", imagePath, `${container}:/tmp/clipboard/${filename}`,
    ], { timeout: DOCKER_COMMAND_TIMEOUT, env: getDockerEnv() });

    if (result.exitCode === 0) {
      log.success(`Image pasted to container: /tmp/clipboard/${filename}`);
      return true;
    }
  } catch (e) {
    log.error(`Failed to copy image to container: ${String(e)}`);
  }

  return false;
}
