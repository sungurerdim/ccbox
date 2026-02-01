/**
 * Docker operations for ccbox.
 *
 * Facade that re-exports from specialized sub-modules.
 */

export {
  type DockerResult,
  safeDockerRun,
  checkDockerStatus,
} from "./docker/executor.js";

export {
  getImageIds,
  getDanglingImageIds,
  imageHasParent,
  listContainers,
  listImages,
} from "./docker/inspect.js";

export {
  removeImage,
  removeContainer,
} from "./docker/cleanup.js";
