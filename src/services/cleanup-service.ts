/**
 * Cleanup service for ccbox.
 *
 * Encapsulates Docker resource cleanup operations with dependency injection
 * for the Docker executor. Makes cleanup testable without Docker daemon.
 */

import { log } from "../logger.js";
import { getImageIds, getDanglingImageIds, imageHasParent, listContainers, listImages, removeContainer, removeImage } from "../docker.js";
import { getImageName, LanguageStack } from "../config.js";

/**
 * Service for managing ccbox Docker resource cleanup.
 *
 * All methods are static since they operate through the docker module.
 * Future: accept injected Docker executor for testing.
 */
export class CleanupService {
  /**
   * Remove ONLY ccbox-originated dangling images.
   */
  static async cleanupDanglingImages(): Promise<number> {
    const ccboxIds = await getImageIds("ccbox");
    if (ccboxIds.size === 0) { return 0; }

    const danglingIds = await getDanglingImageIds();
    if (danglingIds.length === 0) { return 0; }

    let removed = 0;
    for (const imageId of danglingIds) {
      if ((await imageHasParent(imageId, ccboxIds)) && (await removeImage(imageId, true))) {
        removed++;
      }
    }
    return removed;
  }

  /**
   * Remove all ccbox images (stacks + project images).
   */
  static async cleanupImages(): Promise<number> {
    const imagesToRemove = new Set<string>();

    for (const stack of Object.values(LanguageStack)) {
      imagesToRemove.add(getImageName(stack));
    }

    for (const prefix of ["ccbox_", "ccbox/", "ccbox.", "ccbox-", "ccbox:"]) {
      const images = await listImages(prefix);
      for (const image of images) {
        imagesToRemove.add(image);
      }
    }

    const existingImages = new Set(await listImages());
    let removed = 0;
    for (const image of imagesToRemove) {
      if (existingImages.has(image) && await removeImage(image, true)) {
        removed++;
      }
    }

    const danglingRemoved = await CleanupService.cleanupDanglingImages();
    removed += danglingRemoved;

    return removed;
  }

  /**
   * Remove all ccbox containers (running + stopped).
   */
  static async cleanupContainers(): Promise<number> {
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
   * Prune stale ccbox resources (stopped containers only).
   */
  static async pruneStale(verbose = false): Promise<{ containers: number }> {
    const results = { containers: 0 };

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
   * Full cleanup: containers + images + dangling.
   */
  static async cleanupAll(): Promise<{ containers: number; images: number }> {
    const containers = await CleanupService.cleanupContainers();
    const images = await CleanupService.cleanupImages();
    return { containers, images };
  }
}
