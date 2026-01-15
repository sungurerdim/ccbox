/**
 * ccbox - Run Claude Code in isolated Docker containers.
 *
 * This is the main entry point for the ccbox npm package.
 */

// Re-export main types and functions
export { VERSION, VALID_MODELS } from "./constants.js";
export { LanguageStack, STACK_INFO, type Config, createConfig, imageExists } from "./config.js";
export { CCBoxError, ValidationError, DockerError, PathError } from "./errors.js";
export { detectDependencies, type DepsInfo, type DepsMode } from "./deps.js";
export { detectProjectType, type DetectionResult } from "./detector.js";
export { checkDocker, getGitConfig } from "./utils.js";
export { buildImage, ensureImageReady } from "./build.js";
export { removeCcboxContainers, removeCcboxImages, pruneSystem } from "./cleanup.js";
