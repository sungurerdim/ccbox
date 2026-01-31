/**
 * Docker resource cleanup operations.
 *
 * Remove images and containers with consistent error handling.
 */

import { log } from "../logger.js";
import { safeDockerRun } from "./executor.js";

/**
 * Remove a Docker image.
 *
 * @param imageId - Image ID or name to remove.
 * @param force - Force removal if true.
 * @returns True if image was removed, false otherwise.
 */
export async function removeImage(imageId: string, force = true): Promise<boolean> {
  try {
    const args = ["rmi"];
    if (force) {args.push("-f");}
    args.push(imageId);

    const result = await safeDockerRun(args);
    return result.exitCode === 0;
  } catch (error) {
    log.debug(`removeImage failed for '${imageId}': ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

/**
 * Remove a Docker container.
 *
 * @param containerName - Container name or ID to remove.
 * @param force - Force removal if true.
 * @returns True if container was removed, false otherwise.
 */
export async function removeContainer(containerName: string, force = true): Promise<boolean> {
  try {
    const args = ["rm"];
    if (force) {args.push("-f");}
    args.push(containerName);

    const result = await safeDockerRun(args);
    return result.exitCode === 0;
  } catch {
    return false;
  }
}
