/**
 * Cleanup command operations for ccbox.
 *
 * Re-exports from the original cleanup module.
 * Commands directory organization (ARC-11).
 */

export {
  removeCcboxContainers,
  removeCcboxImages,
  cleanTempFiles,
  pruneStaleResources,
  pruneSystem,
  cleanupCcboxDanglingImages,
  getDockerDiskUsage,
} from "../cleanup.js";
