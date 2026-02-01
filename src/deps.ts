/**
 * Dependency detection and installation for ccbox.
 *
 * Facade that re-exports from specialized sub-modules.
 */

export {
  type DepsMode,
  type DepsInfo,
  detectDependencies,
} from "./dependencies/detector.js";

export {
  computeDepsHash,
  getInstallCommands,
} from "./dependencies/installer.js";
