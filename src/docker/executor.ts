/**
 * Docker command execution with consistent error handling.
 *
 * Core execution layer - all Docker commands flow through safeDockerRun.
 */

import { DOCKER_COMMAND_TIMEOUT } from "../constants.js";
import { exec, type ExecResult } from "../exec.js";
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

