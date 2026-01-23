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
 * Architecture:
 * - base: Minimal Claude Code only (vanilla benchmark)
 * - Language stacks: Built on base or official language images
 * - full: Everything combined (development/testing)
 *
 * Hierarchy:
 *   debian:bookworm-slim -> base -> python/web/ruby/php/elixir/dotnet/...
 *   golang:latest -> go
 *   rust:latest -> rust
 *   eclipse-temurin:latest -> java -> jvm
 */
export enum LanguageStack {
  // ═══════════════════════════════════════════════════════════════════════════
  // Core Language Stacks
  // ═══════════════════════════════════════════════════════════════════════════
  BASE = "base",         // Claude Code only (vanilla/benchmark)
  PYTHON = "python",     // Python + uv + ruff + pytest + mypy
  WEB = "web",           // Node.js + TypeScript + eslint + vitest
  GO = "go",             // Go + golangci-lint (golang base)
  RUST = "rust",         // Rust + clippy + rustfmt (rust base)
  JAVA = "java",         // JDK + Maven + Gradle (temurin base)
  CPP = "cpp",           // C++ + CMake + Clang + Conan
  DOTNET = "dotnet",     // .NET SDK + C# + F#
  SWIFT = "swift",       // Swift
  DART = "dart",         // Dart SDK
  LUA = "lua",           // Lua + LuaRocks

  // ═══════════════════════════════════════════════════════════════════════════
  // Combined Language Stacks (multiple languages grouped)
  // ═══════════════════════════════════════════════════════════════════════════
  JVM = "jvm",           // Java + Scala + Clojure + Kotlin
  FUNCTIONAL = "functional", // Haskell + OCaml + Elixir/Erlang
  SCRIPTING = "scripting",   // Ruby + PHP + Perl
  SYSTEMS = "systems",   // C++ + Zig + Nim

  // ═══════════════════════════════════════════════════════════════════════════
  // Use-Case Stacks (project type focused)
  // ═══════════════════════════════════════════════════════════════════════════
  DATA = "data",         // Python + R + Julia (data science)
  AI = "ai",             // Python + Jupyter + PyTorch + TensorFlow
  MOBILE = "mobile",     // Dart + Flutter SDK + Android tools
  GAME = "game",         // C++ + SDL2 + Lua + OpenGL
  FULLSTACK = "fullstack", // Node.js + Python + DB clients
}

/** Stack descriptions for CLI help (sizes are estimates) */
export const STACK_INFO: Record<LanguageStack, { description: string; sizeMB: number }> = {
  // ═══════════════════════════════════════════════════════════════════════════
  // Core Language Stacks
  // ═══════════════════════════════════════════════════════════════════════════
  [LanguageStack.BASE]: { description: "Claude Code only (vanilla)", sizeMB: 200 },
  [LanguageStack.PYTHON]: { description: "Python + uv + ruff + pytest", sizeMB: 350 },
  [LanguageStack.WEB]: { description: "Node.js + TypeScript + eslint + vitest", sizeMB: 400 },
  [LanguageStack.GO]: { description: "Go + golangci-lint", sizeMB: 550 },
  [LanguageStack.RUST]: { description: "Rust + clippy + rustfmt", sizeMB: 700 },
  [LanguageStack.JAVA]: { description: "JDK + Maven + Gradle", sizeMB: 600 },
  [LanguageStack.CPP]: { description: "C++ + CMake + Clang + Conan", sizeMB: 450 },
  [LanguageStack.DOTNET]: { description: ".NET SDK + C# + F#", sizeMB: 500 },
  [LanguageStack.SWIFT]: { description: "Swift", sizeMB: 500 },
  [LanguageStack.DART]: { description: "Dart SDK", sizeMB: 300 },
  [LanguageStack.LUA]: { description: "Lua + LuaRocks", sizeMB: 250 },

  // ═══════════════════════════════════════════════════════════════════════════
  // Combined Language Stacks
  // ═══════════════════════════════════════════════════════════════════════════
  [LanguageStack.JVM]: { description: "Java + Scala + Clojure + Kotlin", sizeMB: 900 },
  [LanguageStack.FUNCTIONAL]: { description: "Haskell + OCaml + Elixir/Erlang", sizeMB: 900 },
  [LanguageStack.SCRIPTING]: { description: "Ruby + PHP + Perl (web backends)", sizeMB: 450 },
  [LanguageStack.SYSTEMS]: { description: "C++ + Zig + Nim (low-level)", sizeMB: 550 },

  // ═══════════════════════════════════════════════════════════════════════════
  // Use-Case Stacks
  // ═══════════════════════════════════════════════════════════════════════════
  [LanguageStack.DATA]: { description: "Python + R + Julia (data science)", sizeMB: 800 },
  [LanguageStack.AI]: { description: "Python + Jupyter + PyTorch + TensorFlow", sizeMB: 2500 },
  [LanguageStack.MOBILE]: { description: "Dart + Flutter SDK + Android tools", sizeMB: 1500 },
  [LanguageStack.GAME]: { description: "C++ + SDL2 + Lua + OpenGL", sizeMB: 600 },
  [LanguageStack.FULLSTACK]: { description: "Node.js + Python + PostgreSQL client", sizeMB: 700 },
};

/**
 * Stack dependencies: which stack must be built first.
 * null = uses external base image (golang:latest, rust:latest, etc.)
 *
 * Hierarchy:
 *   debian:bookworm-slim -> base -> python -> data, ai
 *                                -> web -> fullstack
 *                                -> cpp -> systems, game
 *                                -> dart -> mobile
 *                                -> functional, scripting, dotnet, swift, lua
 *   golang:latest -> go
 *   rust:latest -> rust
 *   eclipse-temurin:latest -> java -> jvm
 */
export const STACK_DEPENDENCIES: Record<LanguageStack, LanguageStack | null> = {
  // ═══════════════════════════════════════════════════════════════════════════
  // Core Language Stacks
  // ═══════════════════════════════════════════════════════════════════════════
  [LanguageStack.BASE]: null,
  [LanguageStack.PYTHON]: LanguageStack.BASE,
  [LanguageStack.WEB]: LanguageStack.BASE,
  [LanguageStack.GO]: null,      // Uses golang:latest
  [LanguageStack.RUST]: null,    // Uses rust:latest
  [LanguageStack.JAVA]: null,    // Uses eclipse-temurin:latest
  [LanguageStack.CPP]: LanguageStack.BASE,
  [LanguageStack.DOTNET]: LanguageStack.BASE,
  [LanguageStack.SWIFT]: LanguageStack.BASE,
  [LanguageStack.DART]: LanguageStack.BASE,
  [LanguageStack.LUA]: LanguageStack.BASE,

  // ═══════════════════════════════════════════════════════════════════════════
  // Combined Language Stacks
  // ═══════════════════════════════════════════════════════════════════════════
  [LanguageStack.JVM]: LanguageStack.JAVA,          // java + Scala/Clojure/Kotlin
  [LanguageStack.FUNCTIONAL]: LanguageStack.BASE,   // Haskell + OCaml + Elixir
  [LanguageStack.SCRIPTING]: LanguageStack.BASE,    // Ruby + PHP + Perl
  [LanguageStack.SYSTEMS]: LanguageStack.CPP,       // cpp + Zig + Nim

  // ═══════════════════════════════════════════════════════════════════════════
  // Use-Case Stacks (optimized layering)
  // ═══════════════════════════════════════════════════════════════════════════
  [LanguageStack.DATA]: LanguageStack.PYTHON,       // python + R + Julia
  [LanguageStack.AI]: LanguageStack.PYTHON,         // python + Jupyter + ML libs
  [LanguageStack.MOBILE]: LanguageStack.DART,       // dart + Flutter SDK
  [LanguageStack.GAME]: LanguageStack.CPP,          // cpp + SDL2 + Lua
  [LanguageStack.FULLSTACK]: LanguageStack.WEB,     // web + Python
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
