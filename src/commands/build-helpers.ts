/**
 * Build phase helpers for ccbox.
 *
 * Extracted from commands/run.ts buildAndRun() to separate concerns:
 * - ensureBaseImage: Build base image if missing
 * - ensureStackImage: Build stack image if missing
 * - buildProjectIfNeeded: Build project-specific image with deps
 */

import {
  imageExistsAsync,
  LanguageStack,
} from "../config.js";
import type { DepsInfo, DepsMode } from "../deps.js";
import { computeDepsHash } from "../deps.js";
import {
  buildImage,
  buildProjectImage,
  ensureImageReady,
  getProjectImageName,
  getProjectImageDepsHash,
} from "../build.js";
import type { BuildOptions } from "../build.js";
import { log } from "../logger.js";

/**
 * Ensure the base image exists (required for all stacks).
 * Builds it on first-time setup if missing.
 */
export async function ensureBaseImage(options: BuildOptions = {}): Promise<void> {
  if (await imageExistsAsync(LanguageStack.BASE)) {
    return;
  }

  log.bold("First-time setup: building base image...");
  try {
    await buildImage(LanguageStack.BASE, options);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    log.error(msg);
    process.exit(1);
  }
  log.newline();
}

/**
 * Ensure the stack image is ready (built if needed).
 */
export async function ensureStackImage(
  stack: LanguageStack,
  options: BuildOptions = {}
): Promise<void> {
  try {
    await ensureImageReady(stack, false, options);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    log.error(msg);
    process.exit(1);
  }
}

/**
 * Build a project-specific image with dependencies if needed.
 *
 * Returns the project image name if built/reused, or undefined if no deps.
 * Handles cache invalidation via dependency hash comparison.
 */
export async function buildProjectIfNeeded(
  projectPath: string,
  projectName: string,
  stack: LanguageStack,
  depsList: DepsInfo[],
  depsMode: DepsMode,
  options: BuildOptions = {}
): Promise<string | undefined> {
  if (depsMode === "skip" || depsList.length === 0) {
    return undefined;
  }

  // Check if existing project image has matching deps hash (skip rebuild)
  const currentHash = computeDepsHash(depsList, projectPath);
  const existingHash = await getProjectImageDepsHash(projectName, stack);

  if (existingHash && existingHash === currentHash) {
    const imageName = getProjectImageName(projectName, stack);
    log.dim(`Dependencies unchanged (${currentHash}), reusing project image`);
    return imageName;
  }

  try {
    return await buildProjectImage(
      projectPath,
      projectName,
      stack,
      depsList,
      depsMode,
      options
    );
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    log.error(`Failed to build project image: ${msg}`);
    process.exit(1);
  }
}
