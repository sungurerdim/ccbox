/**
 * Docker utilities for ccbox.
 *
 * Common Docker operations used across multiple modules.
 *
 * Dependency direction:
 *   This module imports from: exec.ts, paths.ts, constants.ts
 *   It should NOT import from: cli, generator, docker-runtime, clipboard, voice
 */

import { exec } from "./exec.js";
import { getDockerEnv } from "./paths.js";
import { DOCKER_COMMAND_TIMEOUT } from "./constants.js";

/**
 * Find a running ccbox container.
 *
 * Searches for containers with names matching "ccbox" prefix.
 *
 * @returns Container name or null if none found.
 */
export async function findRunningContainer(): Promise<string | null> {
  try {
    const result = await exec("docker", [
      "ps", "--format", "{{.Names}}",
      "--filter", "name=ccbox",
    ], { timeout: DOCKER_COMMAND_TIMEOUT, env: getDockerEnv() });

    const containers = result.stdout.trim().split("\n").filter(Boolean);
    return containers[0] ?? null;
  } catch {
    return null;
  }
}
