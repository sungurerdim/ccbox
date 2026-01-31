/**
 * Language stack definitions for ccbox.
 *
 * Contains the LanguageStack enum, stack metadata (STACK_INFO), and
 * dependency hierarchy (STACK_DEPENDENCIES).
 *
 * Extracted from config.ts to separate stack definitions from configuration logic.
 */

import { ValidationError } from "./errors.js";

/**
 * Supported language stacks for Docker images.
 */
export enum LanguageStack {
  // Core Language Stacks
  BASE = "base",
  PYTHON = "python",
  WEB = "web",
  GO = "go",
  RUST = "rust",
  JAVA = "java",
  CPP = "cpp",
  DOTNET = "dotnet",
  SWIFT = "swift",
  DART = "dart",
  LUA = "lua",

  // Combined Language Stacks
  JVM = "jvm",
  FUNCTIONAL = "functional",
  SCRIPTING = "scripting",
  SYSTEMS = "systems",

  // Use-Case Stacks
  DATA = "data",
  AI = "ai",
  MOBILE = "mobile",
  GAME = "game",
  FULLSTACK = "fullstack",
}

/** Stack descriptions for CLI help (sizes are estimates) */
export const STACK_INFO: Record<LanguageStack, { description: string; sizeMB: number }> = {
  [LanguageStack.BASE]: { description: "Claude Code only (vanilla)", sizeMB: 215 },
  [LanguageStack.PYTHON]: { description: "Python + uv + ruff + pytest + mypy", sizeMB: 350 },
  [LanguageStack.WEB]: { description: "Node.js + Bun + TypeScript + pnpm + eslint + prettier + vitest", sizeMB: 400 },
  [LanguageStack.GO]: { description: "Go + golangci-lint", sizeMB: 550 },
  [LanguageStack.RUST]: { description: "Rust + clippy + rustfmt", sizeMB: 700 },
  [LanguageStack.JAVA]: { description: "JDK + Maven", sizeMB: 600 },
  [LanguageStack.CPP]: { description: "C++ + CMake + Clang + Conan", sizeMB: 450 },
  [LanguageStack.DOTNET]: { description: ".NET SDK + C# + F#", sizeMB: 500 },
  [LanguageStack.SWIFT]: { description: "Swift", sizeMB: 500 },
  [LanguageStack.DART]: { description: "Dart SDK", sizeMB: 300 },
  [LanguageStack.LUA]: { description: "Lua + LuaRocks", sizeMB: 250 },
  [LanguageStack.JVM]: { description: "Java + Scala + Clojure + Kotlin", sizeMB: 900 },
  [LanguageStack.FUNCTIONAL]: { description: "Haskell + OCaml + Elixir/Erlang", sizeMB: 900 },
  [LanguageStack.SCRIPTING]: { description: "Ruby + PHP + Perl (web backends)", sizeMB: 450 },
  [LanguageStack.SYSTEMS]: { description: "C++ + Zig + Nim (low-level)", sizeMB: 550 },
  [LanguageStack.DATA]: { description: "Python + R + Julia (data science)", sizeMB: 800 },
  [LanguageStack.AI]: { description: "Python + Jupyter + PyTorch + TensorFlow", sizeMB: 2500 },
  [LanguageStack.MOBILE]: { description: "Dart + Flutter SDK + Android tools", sizeMB: 1500 },
  [LanguageStack.GAME]: { description: "C++ + SDL2 + Lua + OpenGL", sizeMB: 600 },
  [LanguageStack.FULLSTACK]: { description: "Node.js + Python + PostgreSQL client", sizeMB: 700 },
};

/**
 * Stack dependencies: which stack must be built first.
 * null = uses external base image (golang:latest, rust:latest, etc.)
 */
export const STACK_DEPENDENCIES: Record<LanguageStack, LanguageStack | null> = {
  [LanguageStack.BASE]: null,
  [LanguageStack.PYTHON]: LanguageStack.BASE,
  [LanguageStack.WEB]: LanguageStack.BASE,
  [LanguageStack.GO]: null,
  [LanguageStack.RUST]: null,
  [LanguageStack.JAVA]: null,
  [LanguageStack.CPP]: LanguageStack.BASE,
  [LanguageStack.DOTNET]: LanguageStack.BASE,
  [LanguageStack.SWIFT]: LanguageStack.BASE,
  [LanguageStack.DART]: LanguageStack.BASE,
  [LanguageStack.LUA]: LanguageStack.BASE,
  [LanguageStack.JVM]: LanguageStack.JAVA,
  [LanguageStack.FUNCTIONAL]: LanguageStack.BASE,
  [LanguageStack.SCRIPTING]: LanguageStack.BASE,
  [LanguageStack.SYSTEMS]: LanguageStack.CPP,
  [LanguageStack.DATA]: LanguageStack.PYTHON,
  [LanguageStack.AI]: LanguageStack.PYTHON,
  [LanguageStack.MOBILE]: LanguageStack.DART,
  [LanguageStack.GAME]: LanguageStack.CPP,
  [LanguageStack.FULLSTACK]: LanguageStack.WEB,
};

/** Get Docker image name for a language stack. */
export function getImageName(stack: LanguageStack): string {
  return `ccbox_${stack}:latest`;
}

/** Parse stack from string value. */
export function parseStack(value: string): LanguageStack | undefined {
  const normalized = value.toLowerCase();
  return Object.values(LanguageStack).find((s) => s === normalized);
}

/**
 * Create and validate a LanguageStack from string input.
 * @throws ValidationError if stack name is invalid
 */
export function createStack(value: string): LanguageStack {
  const stack = parseStack(value);
  if (!stack) {
    const validStacks = getStackValues().join(", ");
    throw new ValidationError(
      `Invalid stack '${value}'. Valid options: ${validStacks}`
    );
  }
  return stack;
}

/** Get all stack values as array (for CLI choices). */
export function getStackValues(): string[] {
  return Object.values(LanguageStack);
}

/**
 * Filter stacks by category or search term.
 */
export function filterStacks(filter: string): LanguageStack[] {
  const normalized = filter.toLowerCase();
  const allStacks = Object.values(LanguageStack);

  const categories: Record<string, LanguageStack[]> = {
    core: [LanguageStack.BASE, LanguageStack.PYTHON, LanguageStack.WEB, LanguageStack.GO,
           LanguageStack.RUST, LanguageStack.JAVA, LanguageStack.CPP, LanguageStack.DOTNET,
           LanguageStack.SWIFT, LanguageStack.DART, LanguageStack.LUA],
    combined: [LanguageStack.JVM, LanguageStack.FUNCTIONAL, LanguageStack.SCRIPTING, LanguageStack.SYSTEMS],
    usecase: [LanguageStack.DATA, LanguageStack.AI, LanguageStack.MOBILE, LanguageStack.GAME, LanguageStack.FULLSTACK],
  };

  if (categories[normalized]) {
    return categories[normalized];
  }

  return allStacks.filter(stack =>
    stack.includes(normalized) ||
    STACK_INFO[stack].description.toLowerCase().includes(normalized)
  );
}
