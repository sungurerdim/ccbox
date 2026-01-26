/**
 * Docker operations for ccbox.
 *
 * This module contains Docker-specific utilities and operations,
 * separated from CLI logic for better modularity.
 */

import { execa, type Options as ExecaOptions } from "execa";

import { DOCKER_COMMAND_TIMEOUT } from "./constants.js";
import { DockerError, DockerNotFoundError, DockerTimeoutError } from "./errors.js";
import { getDockerEnv } from "./paths.js";

/** Error message for Docker not running */
export const ERR_DOCKER_NOT_RUNNING = "Error: Docker is not running.";

/** Result of a Docker command execution */
export interface DockerResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Run a Docker command with consistent error handling.
 *
 * @param args - Command arguments (without 'docker' prefix).
 * @param options - Additional execa options.
 * @returns Docker command result.
 * @throws DockerNotFoundError if docker command is not found.
 * @throws DockerTimeoutError if command times out.
 */
export async function safeDockerRun(
  args: string[],
  options: { timeout?: number; check?: boolean } = {}
): Promise<DockerResult> {
  const timeout = options.timeout ?? DOCKER_COMMAND_TIMEOUT;

  try {
    const result = await execa("docker", args, {
      timeout,
      env: getDockerEnv(),
      reject: false,
      encoding: "utf8",
    } as ExecaOptions);

    if (options.check && result.exitCode !== 0) {
      throw new DockerError(`Docker command failed: docker ${args.slice(0, 3).join(" ")}...`);
    }

    return {
      exitCode: result.exitCode ?? 0,
      stdout: String(result.stdout ?? ""),
      stderr: String(result.stderr ?? ""),
    };
  } catch (error: unknown) {
    if (error instanceof DockerError) {throw error;}

    const err = error as NodeJS.ErrnoException & { timedOut?: boolean };

    if (err.code === "ENOENT") {
      throw new DockerNotFoundError(`Docker not found in PATH. Command: docker ${args.slice(0, 3).join(" ")}...`);
    }

    if (err.timedOut) {
      throw new DockerTimeoutError(
        `Docker command timed out after ${timeout}ms. Command: docker ${args.slice(0, 3).join(" ")}...`
      );
    }

    throw error;
  }
}

/**
 * Check if Docker daemon is responsive.
 *
 * @returns True if Docker is running and responsive, false otherwise.
 */
export async function checkDockerStatus(): Promise<boolean> {
  try {
    const result = await safeDockerRun(["info"]);
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Get Docker image IDs matching a filter.
 *
 * @param imageFilter - Image name/tag filter.
 * @returns Set of image IDs, or empty set on failure.
 */
export async function getImageIds(imageFilter: string): Promise<Set<string>> {
  try {
    const result = await safeDockerRun(["images", "--format", "{{.ID}}", imageFilter]);
    if (result.exitCode !== 0) {return new Set();}

    const ids = new Set(result.stdout.trim().split("\n").filter(Boolean));
    return ids;
  } catch {
    return new Set();
  }
}

/**
 * Get all dangling image IDs.
 *
 * @returns List of dangling image IDs, or empty list on failure.
 */
export async function getDanglingImageIds(): Promise<string[]> {
  try {
    const result = await safeDockerRun(["images", "-f", "dangling=true", "-q"]);
    if (result.exitCode !== 0 || !result.stdout.trim()) {return [];}
    return result.stdout.trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Check if an image's parent chain includes any of the given IDs.
 *
 * @param imageId - Docker image ID to check.
 * @param parentIds - Set of potential parent image IDs.
 * @returns True if image has a parent in the set, false otherwise.
 */
export async function imageHasParent(imageId: string, parentIds: Set<string>): Promise<boolean> {
  try {
    const result = await safeDockerRun(["history", "--no-trunc", "-q", imageId]);
    if (result.exitCode !== 0) {return false;}

    const historyIds = new Set(result.stdout.trim().split("\n"));
    // Check intersection
    for (const id of historyIds) {
      if (parentIds.has(id)) {return true;}
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Remove a Docker image.
 *
 * @param imageId - Image ID or name to remove.
 * @param force - Force removal if true.
 * @returns True if image was removed, false otherwise.
 */
export async function removeImage(imageId: string, force = true): Promise<boolean> {
  try {
    const args = ["rmi"];
    if (force) {args.push("-f");}
    args.push(imageId);

    const result = await safeDockerRun(args);
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Remove a Docker container.
 *
 * @param containerName - Container name or ID to remove.
 * @param force - Force removal if true.
 * @returns True if container was removed, false otherwise.
 */
export async function removeContainer(containerName: string, force = true): Promise<boolean> {
  try {
    const args = ["rm"];
    if (force) {args.push("-f");}
    args.push(containerName);

    const result = await safeDockerRun(args);
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * List Docker containers matching filters.
 *
 * @param options - Filter options.
 * @returns List of container names matching filters.
 */
export async function listContainers(options: {
  nameFilter?: string;
  statusFilter?: string;
  allContainers?: boolean;
} = {}): Promise<string[]> {
  try {
    const args = ["ps", "--format", "{{.Names}}"];

    if (options.allContainers !== false) {
      args.push("-a");
    }
    if (options.nameFilter) {
      args.push("--filter", `name=${options.nameFilter}`);
    }
    if (options.statusFilter) {
      args.push("--filter", `status=${options.statusFilter}`);
    }

    const result = await safeDockerRun(args);
    if (result.exitCode !== 0) {return [];}

    return result.stdout.trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * List Docker images, optionally filtered by prefix.
 *
 * @param prefix - Optional prefix to filter images by repository name.
 * @returns List of image names (repository:tag format).
 */
export async function listImages(prefix?: string): Promise<string[]> {
  try {
    const result = await safeDockerRun(["images", "--format", "{{.Repository}}:{{.Tag}}"]);
    if (result.exitCode !== 0) {return [];}

    const images = result.stdout.trim().split("\n").filter(Boolean);
    if (prefix) {
      return images.filter((img) => img.startsWith(prefix));
    }
    return images;
  } catch {
    return [];
  }
}

/**
 * Build a Docker image from a directory.
 *
 * @param buildDir - Directory containing Dockerfile.
 * @param imageName - Name for the built image.
 * @param buildArgs - Optional build arguments.
 * @param timeout - Build timeout in milliseconds.
 * @returns True if build succeeded, false otherwise.
 */
export async function buildImage(
  buildDir: string,
  imageName: string,
  buildArgs: Record<string, string> = {},
  timeout = 600_000
): Promise<{ success: boolean; output: string }> {
  const args = ["build", "-t", imageName, "--no-cache", "--pull"];

  for (const [key, value] of Object.entries(buildArgs)) {
    args.push("--build-arg", `${key}=${value}`);
  }

  args.push(buildDir);

  try {
    const result = await execa("docker", args, {
      timeout,
      env: getDockerEnv(),
      reject: false,
      encoding: "utf8",
      all: true, // Combine stdout and stderr
    } as ExecaOptions);

    return {
      success: result.exitCode === 0,
      output: String(result.all ?? ""),
    };
  } catch (error: unknown) {
    const err = error as { all?: string };
    return {
      success: false,
      output: err.all ?? String(error),
    };
  }
}

/**
 * Run a Docker container and return the exit code.
 *
 * @param args - Full docker run command arguments (without 'docker' prefix).
 * @param options - Execution options.
 * @returns Exit code from the container.
 */
export async function runContainer(
  args: string[],
  options: {
    stdio?: "inherit" | "pipe";
    timeout?: number;
  } = {}
): Promise<number> {
  try {
    const result = await execa("docker", args, {
      stdio: options.stdio ?? "inherit",
      timeout: options.timeout,
      env: getDockerEnv(),
      reject: false,
    } as ExecaOptions);

    return result.exitCode ?? 0;
  } catch (error: unknown) {
    const err = error as { exitCode?: number };
    return err.exitCode ?? 1;
  }
}
