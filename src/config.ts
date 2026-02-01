/**
 * Configuration management for ccbox.
 *
 * Contains Config interface, validation, CLI config utilities.
 * Stack definitions (LanguageStack, STACK_INFO, STACK_DEPENDENCIES) are in stacks.ts
 * and re-exported here for backward compatibility.
 *
 * Dependency direction:
 *   This module has minimal dependencies (near-leaf module).
 *   It may be imported by: cli.ts, generator.ts, docker.ts, paths.ts
 *   It should NOT import from: cli, generator
 */

import { randomUUID } from "node:crypto";
import { DOCKER_COMMAND_TIMEOUT } from "./constants.js";
import { exec } from "./exec.js";
import { getDockerEnv } from "./paths.js";

// Re-export stack definitions for backward compatibility
export {
  LanguageStack,
  STACK_INFO,
  STACK_DEPENDENCIES,
  getImageName,
  parseStack,
  createStack,
  getStackValues,
  filterStacks,
} from "./stacks.js";

import { LanguageStack, getImageName } from "./stacks.js";

/** ccbox configuration model. */
export interface Config {
  version: string;
  gitName: string;
  gitEmail: string;
  claudeConfigDir: string;
}

/** Create a new Config with defaults. */
export function createConfig(): Config {
  return {
    version: "1.0.0",
    gitName: "",
    gitEmail: "",
    claudeConfigDir: "~/.claude",
  };
}


/**
 * Check if Docker image exists for stack (async, non-blocking).
 */
export async function imageExistsAsync(stack: LanguageStack): Promise<boolean> {
  try {
    const result = await exec("docker", ["image", "inspect", getImageName(stack)], {
      timeout: DOCKER_COMMAND_TIMEOUT,
      env: getDockerEnv(),
    });
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Get Docker container name for a project.
 */
export function getContainerName(projectName: string, unique = true): string {
  const MAX_PROJECT_NAME_LENGTH = 50;

  let safeName = projectName
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");

  if (safeName.length > MAX_PROJECT_NAME_LENGTH) {
    safeName = safeName.slice(0, MAX_PROJECT_NAME_LENGTH).replace(/-+$/, "");
  }

  if (!safeName) {
    safeName = "project";
  }

  if (unique) {
    const suffix = randomUUID().slice(0, 6);
    return `ccbox_${safeName}_${suffix}`;
  }
  return `ccbox_${safeName}`;
}
