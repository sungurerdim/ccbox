/**
 * CLI utilities for ccbox.
 *
 * Docker status checks, git configuration, and console setup.
 */

import { existsSync } from "node:fs";
import { platform, env } from "node:process";
import { join } from "node:path";

import { exec, execDetached } from "./exec.js";
import { log } from "./logger.js";

import { DOCKER_CHECK_INTERVAL, DOCKER_COMMAND_TIMEOUT, DOCKER_STARTUP_TIMEOUT } from "./constants.js";
import { checkDockerStatus } from "./docker.js";
import { getDockerEnv } from "./paths.js";

/** Error message for Docker not running */
export const ERR_DOCKER_NOT_RUNNING = "Error: Docker is not running.";

/**
 * Attempt to start Docker Desktop based on platform.
 */
async function startDockerDesktop(): Promise<boolean> {
  const os = platform;

  if (os === "win32") {
    // Try docker desktop command first
    try {
      const result = await exec("docker", ["desktop", "start"], {
        timeout: DOCKER_COMMAND_TIMEOUT,
        env: getDockerEnv(),
      });

      if (result.exitCode === 0) {return true;}
    } catch {
      // Fall through
    }

    // Try to start Docker Desktop executable
    const programFiles = env.PROGRAMFILES || "C:\\Program Files";
    const dockerExe = join(programFiles, "Docker", "Docker", "Docker Desktop.exe");

    if (existsSync(dockerExe)) {
      try {
        // Start Docker Desktop in background (detached)
        execDetached(dockerExe, []);
        return true;
      } catch {
        return false;
      }
    }
  } else if (os === "darwin") {
    try {
      await exec("open", ["-a", "Docker"], {
        timeout: DOCKER_COMMAND_TIMEOUT,
        env: getDockerEnv(),
      });
      return true;
    } catch {
      return false;
    }
  }

  return false;
}

/**
 * Sleep for specified milliseconds.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Check if Docker is available and running, optionally auto-start.
 */
export async function checkDocker(autoStart = true): Promise<boolean> {
  if (await checkDockerStatus()) {
    return true;
  }

  if (autoStart) {
    log.dim("Docker not running, attempting to start...");
    if (await startDockerDesktop()) {
      const maxWait = DOCKER_STARTUP_TIMEOUT / 1000; // Convert to seconds
      const checkInterval = DOCKER_CHECK_INTERVAL / 1000;

      for (let i = 0; i < maxWait; i++) {
        await sleep(1000);
        if (await checkDockerStatus()) {
          log.success("Docker started successfully");
          return true;
        }
        if ((i + 1) % checkInterval === 0) {
          log.dim(`Waiting for Docker... (${i + 1}s)`);
        }
      }
    }
  }

  return false;
}

/**
 * Sanitize a string value for safe use in Docker environment variables.
 * Removes characters that could cause injection or parsing issues.
 */
function sanitizeEnvValue(value: string): string {
  return value
    // Remove newlines (prevents environment variable injection)
    .replace(/[\r\n]/g, " ")
    // Remove null bytes
    // eslint-disable-next-line no-control-regex
    .replace(/\x00/g, "")
    // Trim whitespace
    .trim();
}

/**
 * Get a single git config value.
 * Returns sanitized value safe for Docker environment variables.
 */
async function getGitConfigValue(key: string): Promise<string> {
  const result = await exec("git", ["config", "--global", key], {
    timeout: DOCKER_COMMAND_TIMEOUT,
    encoding: "utf8",
  });

  const resultWithCode = result as typeof result & { code?: string };
  if (resultWithCode.code === "ENOENT") {
    log.dim("Git not found in PATH");
    return "";
  }
  if (result.timedOut) {
    log.dim(`Git config ${key} timed out`);
    return "";
  }
  if (result.exitCode === 0) {
    return sanitizeEnvValue(result.stdout);
  }
  return "";
}

/**
 * Get git user.name and user.email from system.
 */
export async function getGitConfig(): Promise<[string, string]> {
  const [name, email] = await Promise.all([
    getGitConfigValue("user.name"),
    getGitConfigValue("user.email"),
  ]);
  return [name, email];
}
