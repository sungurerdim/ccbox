/**
 * CLI utilities for ccbox.
 *
 * Docker status checks, git configuration, and console setup.
 */

import { existsSync } from "node:fs";
import { platform, env } from "node:process";
import { join } from "node:path";

import chalk from "chalk";
import { execa, type Options as ExecaOptions } from "execa";

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
      const result = await execa("docker", ["desktop", "start"], {
        timeout: DOCKER_COMMAND_TIMEOUT,
        env: getDockerEnv(),
        reject: false,
      } as ExecaOptions);

      if (result.exitCode === 0) return true;
    } catch {
      // Fall through
    }

    // Try to start Docker Desktop executable
    const programFiles = env.PROGRAMFILES || "C:\\Program Files";
    const dockerExe = join(programFiles, "Docker", "Docker", "Docker Desktop.exe");

    if (existsSync(dockerExe)) {
      try {
        // Start Docker Desktop in background (detached)
        execa(dockerExe, [], { detached: true, stdio: "ignore" });
        return true;
      } catch {
        return false;
      }
    }
  } else if (os === "darwin") {
    try {
      await execa("open", ["-a", "Docker"], {
        timeout: DOCKER_COMMAND_TIMEOUT,
        env: getDockerEnv(),
        reject: false,
      } as ExecaOptions);
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
    console.log(chalk.dim("Docker not running, attempting to start..."));
    if (await startDockerDesktop()) {
      const maxWait = DOCKER_STARTUP_TIMEOUT / 1000; // Convert to seconds
      const checkInterval = DOCKER_CHECK_INTERVAL / 1000;

      for (let i = 0; i < maxWait; i++) {
        await sleep(1000);
        if (await checkDockerStatus()) {
          console.log(chalk.green("Docker started successfully"));
          return true;
        }
        if ((i + 1) % checkInterval === 0) {
          console.log(chalk.dim(`Waiting for Docker... (${i + 1}s)`));
        }
      }
    }
  }

  return false;
}

/**
 * Get a single git config value.
 */
async function getGitConfigValue(key: string): Promise<string> {
  try {
    const result = await execa("git", ["config", "--global", key], {
      timeout: DOCKER_COMMAND_TIMEOUT,
      reject: false,
      encoding: "utf8",
    } as ExecaOptions);

    if (result.exitCode === 0) {
      return String(result.stdout ?? "").trim();
    }
  } catch (error) {
    const err = error as { code?: string; timedOut?: boolean };
    if (err.code === "ENOENT") {
      console.log(chalk.dim("Git not found in PATH"));
    } else if (err.timedOut) {
      console.log(chalk.dim(`Git config ${key} timed out`));
    }
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
