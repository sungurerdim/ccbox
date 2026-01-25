/**
 * Cleanup operations for ccbox.
 *
 * Handles container/image removal, pruning, and disk cleanup.
 */

import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import chalk from "chalk";
import { execa, type Options as ExecaOptions } from "execa";

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
    console.log(chalk.dim(`Pruned: ${results.containers} stale container(s)`));
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
 * - ccbox/base, ccbox/web (stack images)
 * - ccbox.projectname/web (project images)
 * - ccbox-projectname (legacy project images)
 * - ccbox:base (legacy stack images)
 */
export async function removeCcboxImages(): Promise<number> {
  // Collect all unique ccbox images first to avoid double-counting
  const imagesToRemove = new Set<string>();

  // Add stack images - new format (ccbox/base) and old format (ccbox:base)
  for (const stack of Object.values(LanguageStack)) {
    imagesToRemove.add(getImageName(stack));
    imagesToRemove.add(`ccbox:${stack}`);
  }

  // Add all ccbox-prefixed images (project images + any others)
  // Covers: ccbox/, ccbox., ccbox-, ccbox:
  for (const prefix of ["ccbox/", "ccbox.", "ccbox-", "ccbox:"]) {
    const images = await listImages(prefix);
    for (const image of images) {
      imagesToRemove.add(image);
    }
  }

  // Remove images and count only successful removals
  // Check if image exists before counting as removed
  let removed = 0;
  for (const image of imagesToRemove) {
    // Check if image actually exists before trying to remove
    const exists = (await listImages()).includes(image);
    if (exists && await removeImage(image, true)) {
      // Verify it was actually removed
      const stillExists = (await listImages()).includes(image);
      if (!stillExists) {
        removed++;
      }
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
        if (parts.length >= 3) {
          const resourceType = parts[0]!.toLowerCase();
          const reclaimable = parts[2]!;
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
    console.log(chalk.dim("Docker disk usage unavailable"));
  }

  return usage;
}

/**
 * Prune entire Docker system (all unused resources).
 */
export async function pruneSystem(): Promise<void> {
  console.log(chalk.bold("\nCleaning Docker system..."));

  const env = getDockerEnv();

  // 1. Remove stopped containers
  console.log(chalk.dim("Removing stopped containers..."));
  await execa("docker", ["container", "prune", "-f"], {
    timeout: PRUNE_TIMEOUT,
    env,
    reject: false,
  } as ExecaOptions);

  // 2. Remove dangling images
  console.log(chalk.dim("Removing dangling images..."));
  await execa("docker", ["image", "prune", "-f"], {
    timeout: PRUNE_TIMEOUT,
    env,
    reject: false,
  } as ExecaOptions);

  // 3. Remove unused volumes
  console.log(chalk.dim("Removing unused volumes..."));
  await execa("docker", ["volume", "prune", "-f"], {
    timeout: PRUNE_TIMEOUT,
    env,
    reject: false,
  } as ExecaOptions);

  // 4. Remove build cache
  console.log(chalk.dim("Removing build cache..."));
  await execa("docker", ["builder", "prune", "-f", "--all"], {
    timeout: PRUNE_TIMEOUT,
    env,
    reject: false,
  } as ExecaOptions);

  console.log(chalk.green("\nSystem cleanup complete"));

  const newUsage = await getDockerDiskUsage();
  console.log(
    chalk.dim(
      `Remaining: Images ${newUsage.images}, Volumes ${newUsage.volumes}, Cache ${newUsage.cache}`
    )
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
