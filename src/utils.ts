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
 * Git credentials: token + identity (name/email).
 */
export interface GitCredentials {
  token: string | null;
  name: string;
  email: string;
}

/**
 * Get all git credentials from host system (zero-config UX).
 *
 * Single function that retrieves:
 * - GitHub token (for push/pull auth)
 * - Git identity (name/email for commits)
 *
 * Priority for token:
 * 1. GITHUB_TOKEN or GH_TOKEN env var
 * 2. gh CLI auth token
 * 3. git credential helper
 *
 * Priority for identity:
 * 1. GitHub API (if gh CLI authenticated) - most accurate
 * 2. git config user.name/email - fallback
 */
export async function getGitCredentials(): Promise<GitCredentials> {
  let token: string | null = null;
  let name = "";
  let email = "";
  let ghAvailable = false;

  // 1. Check environment variables for token
  if (env.GITHUB_TOKEN) {
    token = env.GITHUB_TOKEN;
    log.debug("GitHub token: from GITHUB_TOKEN env");
  } else if (env.GH_TOKEN) {
    token = env.GH_TOKEN;
    log.debug("GitHub token: from GH_TOKEN env");
  }

  // 2. Try gh CLI for token (if not from env)
  if (!token) {
    try {
      const ghResult = await exec("gh", ["auth", "token"], {
        timeout: 5000,
        encoding: "utf8",
      });
      if (ghResult.exitCode === 0 && ghResult.stdout.trim()) {
        token = ghResult.stdout.trim();
        ghAvailable = true;
        log.debug("GitHub token: from gh CLI");
      }
    } catch {
      // gh not installed or not authenticated
    }
  }

  // 3. If gh CLI worked, get identity from GitHub API (most accurate)
  if (ghAvailable) {
    try {
      const userResult = await exec("gh", ["api", "user", "--jq", ".name, .email"], {
        timeout: 5000,
        encoding: "utf8",
      });
      if (userResult.exitCode === 0) {
        const lines = userResult.stdout.trim().split("\n");
        if (lines[0] && lines[0] !== "null") {name = lines[0];}
        if (lines[1] && lines[1] !== "null") {email = lines[1];}
        if (name || email) {
          log.debug("Git identity: from GitHub API");
        }
      }
    } catch {
      // gh api failed, will fallback to git config
    }
  }

  // 4. Try git credential helper for token (if still not found)
  if (!token) {
    try {
      token = await getGitCredential();
      if (token) {
        log.debug("GitHub token: from git credential helper");
      }
    } catch {
      // git credential helper not configured
    }
  }

  // 5. Fallback to git config for identity
  if (!name || !email) {
    const [gitName, gitEmail] = await Promise.all([
      getGitConfigValue("user.name"),
      getGitConfigValue("user.email"),
    ]);
    if (!name && gitName) {name = gitName;}
    if (!email && gitEmail) {email = gitEmail;}
    if (gitName || gitEmail) {
      log.debug("Git identity: from git config");
    }
  }

  return { token, name, email };
}

/**
 * Get GitHub token from git credential helper.
 * Uses spawn to write to stdin (required by git credential fill).
 */
async function getGitCredential(): Promise<string | null> {
  const { spawn } = await import("node:child_process");

  return new Promise((resolve) => {
    const child = spawn("git", ["credential", "fill"], {
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 5000,
    });

    let stdout = "";
    child.stdout?.on("data", (data) => { stdout += data.toString(); });
    child.on("error", () => resolve(null));
    child.on("close", (code) => {
      if (code === 0) {
        const match = stdout.match(/^password=(.+)$/m);
        if (match?.[1]) {
          resolve(match[1].trim());
          return;
        }
      }
      resolve(null);
    });

    // Write credential request to stdin
    child.stdin?.write("protocol=https\nhost=github.com\n\n");
    child.stdin?.end();
  });
}

// Legacy exports for backward compatibility
export async function getGitConfig(): Promise<[string, string]> {
  const creds = await getGitCredentials();
  return [creds.name, creds.email];
}

export async function getGitHubToken(): Promise<string | null> {
  const creds = await getGitCredentials();
  return creds.token;
}
