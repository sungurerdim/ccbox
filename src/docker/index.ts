/**
 * Docker operations for ccbox.
 *
 * Facade module that re-exports from specialized sub-modules:
 * - executor.ts: Command execution (safeDockerRun, checkDockerStatus)
 * - inspect.ts: Read-only queries (getImageIds, listImages, listContainers)
 * - cleanup.ts: Resource removal (removeImage, removeContainer)
 */

// Executor
export {
  type DockerResult,
  safeDockerRun,
  checkDockerStatus,
  buildImage,
  runContainer,
} from "./executor.js";

// Inspect
export {
  getImageIds,
  getDanglingImageIds,
  imageHasParent,
  listContainers,
  listImages,
} from "./inspect.js";

// Cleanup
export {
  removeImage,
  removeContainer,
} from "./cleanup.js";
