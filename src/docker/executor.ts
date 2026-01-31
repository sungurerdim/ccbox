/**
 * Docker command execution with consistent error handling.
 *
 * Core execution layer - all Docker commands flow through safeDockerRun.
 */

import { DOCKER_COMMAND_TIMEOUT } from "../constants.js";
import { exec, execInherit, type ExecResult } from "../exec.js";
import { DockerError, DockerNotFoundError, DockerTimeoutError } from "../errors.js";
import { getDockerEnv } from "../paths.js";

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

  const result = await exec("docker", args, {
    timeout,
    env: getDockerEnv(),
    encoding: "utf8",
  });

  const resultWithCode = result as ExecResult & { code?: string };
  if (resultWithCode.code === "ENOENT") {
    throw new DockerNotFoundError(`Docker not found in PATH. Command: docker ${args.slice(0, 3).join(" ")}...`);
  }

  if (result.timedOut) {
    throw new DockerTimeoutError(
      `Docker command timed out after ${timeout}ms. Command: docker ${args.slice(0, 3).join(" ")}...`
    );
  }

  if (options.check && result.exitCode !== 0) {
    throw new DockerError(`Docker command failed: docker ${args.slice(0, 3).join(" ")}...`);
  }

  return {
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
  };
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
 * Build a Docker image from a directory.
 *
 * Uses consistent error handling wrapper for Docker operations.
 *
 * @param buildDir - Directory containing Dockerfile.
 * @param imageName - Name for the built image.
 * @param buildArgs - Optional build arguments.
 * @param timeout - Build timeout in milliseconds.
 * @returns Build result with success status and output.
 * @throws DockerNotFoundError if docker command is not found.
 * @throws DockerTimeoutError if build times out.
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

  const result = await exec("docker", args, {
    timeout,
    env: getDockerEnv(),
    encoding: "utf8",
    all: true,
  });

  const resultWithCode = result as ExecResult & { code?: string };
  if (resultWithCode.code === "ENOENT") {
    throw new DockerNotFoundError(`Docker not found in PATH. Command: docker ${args.slice(0, 3).join(" ")}...`);
  }

  if (result.timedOut) {
    throw new DockerTimeoutError(
      `Docker build timed out after ${timeout}ms. Image: ${imageName}`
    );
  }

  return {
    success: result.exitCode === 0,
    output: result.all ?? "",
  };
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
    const result = await execInherit("docker", args, {
      timeout: options.timeout,
      env: getDockerEnv(),
    });
    return result.exitCode;
  } catch {
    return 1;
  }
}
