/**
 * Build command operations for ccbox.
 *
 * Re-exports from the original build module.
 * Commands directory organization (ARC-11).
 */

export {
  buildImage,
  buildProjectImage,
  ensureImageReady,
  getProjectImageName,
  getProjectImageDepsHash,
  projectImageExists,
  getInstalledCcboxImages,
} from "../build.js";
