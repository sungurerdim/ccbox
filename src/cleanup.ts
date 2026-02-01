/**
 * Cleanup operations for ccbox.
 *
 * Handles container/image removal, pruning, and disk cleanup.
 */

import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { exec } from "./exec.js";
import { log } from "./logger.js";

import { getImageName, LanguageStack } from "./config.js";
import { PRUNE_TIMEOUT } from "./constants.js";
import {
  getDanglingImageIds,
  getImageIds,
  imageHasParent,
  listContainers,
  listImages,
  removeContainer,
  removeImage,
  safeDockerRun,
} from "./docker.js";
import { getDockerEnv } from "./paths.js";

/**
 * Post-build cleanup: remove ONLY ccbox-originated dangling images.
 */
export async function cleanupCcboxDanglingImages(): Promise<number> {
  const ccboxIds = await getImageIds("ccbox");
  if (ccboxIds.size === 0) {return 0;}

  const danglingIds = await getDanglingImageIds();
  if (danglingIds.length === 0) {return 0;}

  let removed = 0;
  for (const imageId of danglingIds) {
    if ((await imageHasParent(imageId, ccboxIds)) && (await removeImage(imageId, true))) {
      removed++;
    }
  }
  return removed;
}

/**
 * Prune stale ccbox Docker resources before run.
 */
export async function pruneStaleResources(verbose = false): Promise<{ containers: number }> {
  const results = { containers: 0 };

  // Remove stopped ccbox containers
  for (const prefix of ["ccbox.", "ccbox-"]) {
    const containers = await listContainers({ nameFilter: prefix, statusFilter: "exited" });
    for (const containerName of containers) {
      if (await removeContainer(containerName, true)) {
        results.containers++;
      }
    }
  }

  if (verbose && results.containers > 0) {
    log.dim(`Pruned: ${results.containers} stale container(s)`);
  }

  return results;
}

/**
 * Remove all ccbox containers (running + stopped).
 */
export async function removeCcboxContainers(): Promise<number> {
  let removed = 0;
  for (const prefix of ["ccbox.", "ccbox-"]) {
    const containers = await listContainers({ nameFilter: prefix });
    for (const name of containers) {
      if (await removeContainer(name, true)) {
        removed++;
      }
    }
  }
  return removed;
}

/**
 * Remove all ccbox images (stacks + project images).
 * Cleans up all image naming conventions:
 * - ccbox_web:latest (stack images)
 * - ccbox_web:projectname (project images)
 * - ccbox/base, ccbox.project/web (legacy formats)
 */
export async function removeCcboxImages(): Promise<number> {
  // Collect all unique ccbox images first to avoid double-counting
  const imagesToRemove = new Set<string>();

  // Add stack images - current format (ccbox_base:latest)
  for (const stack of Object.values(LanguageStack)) {
    imagesToRemove.add(getImageName(stack));
  }

  // Single Docker call to get all images, then filter in memory
  const allImages = await listImages();
  const ccboxPrefixes = ["ccbox_", "ccbox/", "ccbox.", "ccbox-", "ccbox:"];
  for (const image of allImages) {
    if (ccboxPrefixes.some(prefix => image.startsWith(prefix))) {
      imagesToRemove.add(image);
    }
  }

  const existingImages = new Set(allImages);
  let removed = 0;
  for (const image of imagesToRemove) {
    if (existingImages.has(image) && await removeImage(image, true)) {
      removed++;
    }
  }

  // Also remove any dangling images that originated from ccbox builds
  const danglingRemoved = await cleanupCcboxDanglingImages();
  removed += danglingRemoved;

  return removed;
}

/**
 * Get Docker disk usage for display.
 */
export async function getDockerDiskUsage(): Promise<Record<string, string>> {
  const usage: Record<string, string> = {
    containers: "?",
    images: "?",
    volumes: "?",
    cache: "?",
  };

  try {
    const result = await safeDockerRun([
      "system",
      "df",
      "--format",
      "{{.Type}}\t{{.Size}}\t{{.Reclaimable}}",
    ]);

    if (result.exitCode === 0) {
      for (const line of result.stdout.trim().split("\n")) {
        const parts = line.split("\t");
        const resourceType = parts?.[0]?.toLowerCase() ?? "";
        const reclaimable = parts?.[2] ?? "";
        if (parts.length >= 3 && resourceType && reclaimable) {
          if (resourceType.includes("images")) {
            usage.images = reclaimable;
          } else if (resourceType.includes("containers")) {
            usage.containers = reclaimable;
          } else if (resourceType.includes("volumes")) {
            usage.volumes = reclaimable;
          } else if (resourceType.includes("build")) {
            usage.cache = reclaimable;
          }
        }
      }
    }
  } catch {
    // Non-fatal: disk usage is informational only
  }

  return usage;
}

/**
 * Prune entire Docker system (all unused resources).
 */
export async function pruneSystem(): Promise<void> {
  log.bold("\nCleaning Docker system...");

  const env = getDockerEnv();

  // 1. Remove stopped containers
  log.dim("Removing stopped containers...");
  await exec("docker", ["container", "prune", "-f"], { timeout: PRUNE_TIMEOUT, env });

  // 2. Remove dangling images
  log.dim("Removing dangling images...");
  await exec("docker", ["image", "prune", "-f"], { timeout: PRUNE_TIMEOUT, env });

  // 3. Remove unused volumes
  log.dim("Removing unused volumes...");
  await exec("docker", ["volume", "prune", "-f"], { timeout: PRUNE_TIMEOUT, env });

  // 4. Remove build cache
  log.dim("Removing build cache...");
  await exec("docker", ["builder", "prune", "-f", "--all"], { timeout: PRUNE_TIMEOUT, env });

  log.success("\nSystem cleanup complete");

  const newUsage = await getDockerDiskUsage();
  log.dim(
    `Remaining: Images ${newUsage.images}, Volumes ${newUsage.volumes}, Cache ${newUsage.cache}`
  );
}

/**
 * Clean up ccbox build directory.
 */
export function cleanTempFiles(): number {
  const ccboxTmp = join(tmpdir(), "ccbox");
  if (existsSync(ccboxTmp)) {
    rmSync(ccboxTmp, { recursive: true, force: true });
    return 1;
  }
  return 0;
}
