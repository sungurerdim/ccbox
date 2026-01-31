/**
 * Dependency detection and installation for ccbox.
 *
 * This module is a facade that re-exports from specialized sub-modules
 * for backward compatibility. New code should import from:
 * - ./dependencies/detector.js (detectDependencies, PACKAGE_MANAGERS)
 * - ./dependencies/installer.js (computeDepsHash, getInstallCommands)
 */

export {
  type DepsMode,
  type DepsInfo,
  PACKAGE_MANAGERS,
  detectDependencies,
} from "./dependencies/detector.js";

export {
  computeDepsHash,
  getInstallCommands,
} from "./dependencies/installer.js";
