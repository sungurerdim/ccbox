/**
 * Dependency detection and installation for ccbox.
 *
 * Re-exports from specialized sub-modules:
 * - detector.ts: Package manager detection (detectDependencies, PACKAGE_MANAGERS)
 * - installer.ts: Install commands and hash computation (getInstallCommands, computeDepsHash)
 */

export {
  type DepsMode,
  type DepsInfo,
  PACKAGE_MANAGERS,
  detectDependencies,
} from "./detector.js";

export {
  computeDepsHash,
  getInstallCommands,
} from "./installer.js";
