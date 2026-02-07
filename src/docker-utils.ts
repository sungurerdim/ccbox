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

/** Information about a running ccbox container. */
export interface DockerContainerInfo {
  name: string;
  id: string;
  image: string;
  status: string;
}

/**
 * Find a running ccbox container.
 *
 * Searches for containers with names matching "ccbox" prefix.
 * Returns the first match (backward compatibility).
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

/**
 * Find ALL running ccbox containers with full info.
 *
 * Uses tab-separated format for reliable parsing.
 *
 * @returns Array of container info objects.
 */
export async function findRunningContainers(): Promise<DockerContainerInfo[]> {
  try {
    const result = await exec("docker", [
      "ps", "--format", "{{.Names}}\t{{.ID}}\t{{.Image}}\t{{.Status}}",
      "--filter", "name=ccbox",
    ], { timeout: DOCKER_COMMAND_TIMEOUT, env: getDockerEnv() });

    const lines = result.stdout.trim().split("\n").filter(Boolean);
    const containers: DockerContainerInfo[] = [];

    for (const line of lines) {
      const parts = line.split("\t");
      if (parts.length >= 4) {
        containers.push({
          name: parts[0]!,
          id: parts[1]!,
          image: parts[2]!,
          status: parts[3]!,
        });
      }
    }

    return containers;
  } catch {
    return [];
  }
}

/**
 * Stop a running container by name.
 *
 * @returns true if stopped successfully, false otherwise.
 */
export async function stopContainer(name: string): Promise<boolean> {
  try {
    const result = await exec("docker", ["stop", name], {
      timeout: DOCKER_COMMAND_TIMEOUT,
      env: getDockerEnv(),
    });
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Extract project name from a ccbox container name.
 *
 * Container names follow the pattern: ccbox_<project>_<hash>
 *
 * @example
 * extractProjectName("ccbox_myproject_a1b2c3") // => "myproject"
 * extractProjectName("ccbox_my-app_d4e5f6")    // => "my-app"
 * extractProjectName("ccbox")                   // => "ccbox"
 */
export function extractProjectName(containerName: string): string {
  const parts = containerName.split("_");
  if (parts.length >= 3) {
    // Remove first (ccbox) and last (hash) parts
    return parts.slice(1, -1).join("_");
  }
  return containerName;
}
