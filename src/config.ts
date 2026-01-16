/**
 * Configuration management for ccbox.
 *
 * Dependency direction:
 *   This module has minimal dependencies (near-leaf module).
 *   It may be imported by: cli.ts, generator.ts, docker.ts, paths.ts
 *   It should NOT import from: cli, generator
 */

import { execSync } from "node:child_process";
import { existsSync, lstatSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";

import { PathError } from "./errors.js";
import { DOCKER_COMMAND_TIMEOUT } from "./constants.js";

/**
 * Supported language stacks for Docker images.
 *
 * Hierarchy: minimal -> base -> python/web/full (+ extras)
 * Standalone: go, rust, java (own base images)
 */
export enum LanguageStack {
  MINIMAL = "minimal", // Node.js + Claude Code (~300MB)
  BASE = "base", // minimal alias (default) (~300MB)
  PYTHON = "python", // base + ruff, mypy, pytest, uv (~400MB)
  GO = "go", // Go + Node.js + golangci-lint (~650MB)
  RUST = "rust", // Rust + Node.js + clippy (~800MB)
  JAVA = "java", // JDK (Temurin LTS) + Maven (~900MB)
  WEB = "web", // base + pnpm (~350MB)
  FULL = "full", // base + Go + Rust + Java + pnpm (~1.3GB)
}

/** Stack descriptions for CLI help (sizes are estimates) */
export const STACK_INFO: Record<LanguageStack, { description: string; sizeMB: number }> = {
  [LanguageStack.MINIMAL]: { description: "Node.js + Claude Code", sizeMB: 300 },
  [LanguageStack.BASE]: { description: "minimal alias (default)", sizeMB: 300 },
  [LanguageStack.PYTHON]: { description: "base + ruff, mypy, pytest, uv", sizeMB: 400 },
  [LanguageStack.GO]: { description: "Go + Node.js + golangci-lint", sizeMB: 650 },
  [LanguageStack.RUST]: { description: "Rust + Node.js + clippy", sizeMB: 800 },
  [LanguageStack.JAVA]: { description: "JDK (Temurin) + Maven", sizeMB: 900 },
  [LanguageStack.WEB]: { description: "base + pnpm", sizeMB: 350 },
  [LanguageStack.FULL]: { description: "base + Go + Rust + Java + pnpm", sizeMB: 1300 },
};

/**
 * Stack dependencies: which stack must be built first.
 * Hierarchy: minimal -> base -> python/web/full
 * GO, RUST, JAVA use their own base images (golang:latest, rust:latest, etc.)
 */
export const STACK_DEPENDENCIES: Record<LanguageStack, LanguageStack | null> = {
  [LanguageStack.MINIMAL]: null,
  [LanguageStack.BASE]: LanguageStack.MINIMAL,
  [LanguageStack.PYTHON]: LanguageStack.BASE,
  [LanguageStack.GO]: null,
  [LanguageStack.RUST]: null,
  [LanguageStack.JAVA]: null,
  [LanguageStack.WEB]: LanguageStack.BASE,
  [LanguageStack.FULL]: LanguageStack.BASE,
};

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
 * Validate that a path is safe (within user's home directory).
 *
 * @param path - Path to validate (should already be expanded/resolved).
 * @param description - Human-readable description for error messages.
 * @returns The validated path.
 * @throws PathError if path is outside user's home directory or is a symlink.
 */
export function validateSafePath(path: string, description = "path"): string {
  const home = homedir();
  const resolved = resolve(path);

  // Security: reject symlinks to prevent symlink attacks
  if (existsSync(resolved)) {
    const stats = lstatSync(resolved);
    if (stats.isSymbolicLink()) {
      throw new PathError(`${description} cannot be a symlink: ${path}`);
    }
  }

  // Check if path is within home directory
  if (!resolved.startsWith(home)) {
    throw new PathError(
      `Invalid ${description}: '${resolved}' must be within home directory '${home}'`
    );
  }

  return resolved;
}

/**
 * Get expanded and validated Claude config directory path.
 *
 * @throws PathError if path traversal is detected.
 */
export function getClaudeConfigDir(config: Config): string {
  const expanded = config.claudeConfigDir.replace(/^~/, homedir());
  return validateSafePath(expanded, "claude_config_dir");
}

/** Get Docker image name for a language stack. */
export function getImageName(stack: LanguageStack): string {
  return `ccbox/${stack}`;
}

/** Check if Docker image exists for stack. */
export function imageExists(stack: LanguageStack): boolean {
  try {
    execSync(`docker image inspect ${getImageName(stack)}`, {
      stdio: "ignore",
      timeout: DOCKER_COMMAND_TIMEOUT,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get Docker container name for a project.
 *
 * @param projectName - Name of the project directory.
 * @param unique - If true, append a short unique suffix to allow multiple instances.
 */
export function getContainerName(projectName: string, unique = true): string {
  const safeName = projectName
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-");

  if (unique) {
    const suffix = randomUUID().slice(0, 6);
    return `ccbox.${safeName}-${suffix}`;
  }
  return `ccbox.${safeName}`;
}

/** Parse stack from string value. */
export function parseStack(value: string): LanguageStack | undefined {
  const normalized = value.toLowerCase();
  return Object.values(LanguageStack).find((s) => s === normalized);
}

/** Get all stack values as array (for CLI choices). */
export function getStackValues(): string[] {
  return Object.values(LanguageStack);
}
