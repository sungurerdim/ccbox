/**
 * Docker inspection and listing operations.
 *
 * Read-only queries against Docker daemon for images and containers.
 */

import { log } from "../logger.js";
import { safeDockerRun } from "./executor.js";

/**
 * Get Docker image IDs matching a filter.
 *
 * @param imageFilter - Image name/tag filter.
 * @returns Set of image IDs, or empty set on failure.
 */
export async function getImageIds(imageFilter: string): Promise<Set<string>> {
  try {
    const result = await safeDockerRun(["images", "--format", "{{.ID}}", imageFilter]);
    if (result.exitCode !== 0) {return new Set();}

    const ids = new Set(result.stdout.trim().split("\n").filter(Boolean));
    return ids;
  } catch (error) {
    log.debug(`getImageIds failed for '${imageFilter}': ${error instanceof Error ? error.message : String(error)}`);
    return new Set();
  }
}

/**
 * Get all dangling image IDs.
 *
 * @returns List of dangling image IDs, or empty list on failure.
 */
export async function getDanglingImageIds(): Promise<string[]> {
  try {
    const result = await safeDockerRun(["images", "-f", "dangling=true", "-q"]);
    if (result.exitCode !== 0 || !result.stdout.trim()) {return [];}
    return result.stdout.trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Check if an image's parent chain includes any of the given IDs.
 *
 * @param imageId - Docker image ID to check.
 * @param parentIds - Set of potential parent image IDs.
 * @returns True if image has a parent in the set, false otherwise.
 */
export async function imageHasParent(imageId: string, parentIds: Set<string>): Promise<boolean> {
  try {
    const result = await safeDockerRun(["history", "--no-trunc", "-q", imageId]);
    if (result.exitCode !== 0) {return false;}

    const historyIds = new Set(result.stdout.trim().split("\n"));
    // Check intersection
    for (const id of historyIds) {
      if (parentIds.has(id)) {return true;}
    }
    return false;
  } catch (error) {
    log.debug(`imageHasParent failed for '${imageId}': ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

/**
 * List Docker containers matching filters.
 *
 * @param options - Filter options.
 * @returns List of container names matching filters.
 */
export async function listContainers(options: {
  nameFilter?: string;
  statusFilter?: string;
  allContainers?: boolean;
} = {}): Promise<string[]> {
  try {
    const args = ["ps", "--format", "{{.Names}}"];

    if (options.allContainers !== false) {
      args.push("-a");
    }
    if (options.nameFilter) {
      args.push("--filter", `name=${options.nameFilter}`);
    }
    if (options.statusFilter) {
      args.push("--filter", `status=${options.statusFilter}`);
    }

    const result = await safeDockerRun(args);
    if (result.exitCode !== 0) {return [];}

    return result.stdout.trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * List Docker images, optionally filtered by prefix.
 *
 * @param prefix - Optional prefix to filter images by repository name.
 * @returns List of image names (repository:tag format).
 */
export async function listImages(prefix?: string): Promise<string[]> {
  try {
    const result = await safeDockerRun(["images", "--format", "{{.Repository}}:{{.Tag}}"]);
    if (result.exitCode !== 0) {return [];}

    const images = result.stdout.trim().split("\n").filter(Boolean);
    if (prefix) {
      return images.filter((img) => img.startsWith(prefix));
    }
    return images;
  } catch {
    return [];
  }
}
