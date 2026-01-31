/**
 * Docker operations for ccbox.
 *
 * This module is a facade that re-exports from specialized sub-modules
 * for backward compatibility. New code should import from:
 * - ./docker/executor.js (safeDockerRun, checkDockerStatus, buildImage, runContainer)
 * - ./docker/inspect.js (getImageIds, getDanglingImageIds, imageHasParent, listContainers, listImages)
 * - ./docker/cleanup.js (removeImage, removeContainer)
 */

export {
  type DockerResult,
  safeDockerRun,
  checkDockerStatus,
  buildImage,
  runContainer,
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

/** Error message for Docker not running */
export const ERR_DOCKER_NOT_RUNNING = "Error: Docker is not running.";
