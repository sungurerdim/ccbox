/**
 * Project type detection for automatic language stack selection.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { LanguageStack } from "./config.js";

/** Result of project detection. */
export interface DetectionResult {
  recommendedStack: LanguageStack;
  detectedLanguages: string[];
  /** Optional: files that triggered each detection (for verbose mode) */
  detectionDetails?: Record<string, string>;
}

/** File patterns for language detection (exact names or glob with *) */
const LANGUAGE_PATTERNS: Record<string, string[]> = {
  // Core languages
  python: ["pyproject.toml", "setup.py", "requirements.txt", "Pipfile", "poetry.lock", "uv.lock", "pdm.lock", "setup.cfg"],
  node: ["package.json", "package-lock.json", "yarn.lock", "pnpm-lock.yaml"],
  bun: ["bun.lockb", "bun.lock", "bunfig.toml"],  // bun.lock is text format since v1.0
  deno: ["deno.json", "deno.jsonc", "deno.lock"],  // Deno runtime
  typescript: ["tsconfig.json", "tsconfig.base.json", "tsconfig.*.json"],
  go: ["go.mod", "go.sum"],
  rust: ["Cargo.toml", "Cargo.lock"],
  java: ["pom.xml", "build.gradle", "build.gradle.kts", "gradle.lock", "settings.gradle", "settings.gradle.kts"],

  // Extended languages
  scala: ["build.sbt", "project/build.properties"],
  clojure: ["project.clj", "deps.edn"],
  kotlin: ["build.gradle.kts", "settings.gradle.kts"],  // Note: overlaps with java
  ruby: ["Gemfile", "Gemfile.lock", "Rakefile", ".ruby-version", "*.gemspec"],
  php: ["composer.json", "composer.lock", "artisan"],  // artisan = Laravel
  dotnet: ["*.csproj", "*.fsproj", "*.vbproj", "*.sln", "global.json", "nuget.config"],
  elixir: ["mix.exs", "mix.lock"],
  haskell: ["stack.yaml", "cabal.project", "*.cabal", "package.yaml"],
  swift: ["Package.swift", "*.xcodeproj", "*.xcworkspace"],
  dart: ["pubspec.yaml", "pubspec.lock"],
  perl: ["cpanfile", "Makefile.PL", "Build.PL", "*.pm"],
  lua: ["*.rockspec", ".luacheckrc", "*.lua"],
  ocaml: ["dune-project", "*.opam", "dune", "_opam"],
  cpp: ["CMakeLists.txt", "conanfile.txt", "conanfile.py", "vcpkg.json", "Makefile", "*.cpp", "*.hpp"],
  r: ["renv.lock", "DESCRIPTION", ".Rprofile", "*.Rproj"],
  julia: ["Project.toml", "Manifest.toml"],
  zig: ["build.zig", "build.zig.zon"],
  nim: ["*.nimble", "nim.cfg", "*.nim"],
  gleam: ["gleam.toml", "manifest.toml"],  // Erlang-based functional language
};

/** Check if a file matches a pattern (supports * prefix wildcard) */
function matchesPattern(filename: string, pattern: string): boolean {
  if (pattern.startsWith("*.")) {
    const ext = pattern.slice(1);  // ".csproj", ".cabal" etc.
    return filename.endsWith(ext);
  }
  return filename === pattern;
}

/** Check if directory contains files matching the pattern */
function hasMatchingFile(directory: string, pattern: string): boolean {
  // Exact match - fast path
  if (!pattern.includes("*")) {
    return existsSync(join(directory, pattern));
  }

  // Glob pattern - need to scan directory
  try {
    const files = readdirSync(directory, { withFileTypes: true });
    return files.some((f) => f.isFile() && matchesPattern(f.name, pattern));
  } catch {
    return false;
  }
}

/** Check package.json for packageManager field */
function detectPackageManager(directory: string): string | null {
  const pkgPath = join(directory, "package.json");
  if (!existsSync(pkgPath)) { return null; }

  try {
    const content = readFileSync(pkgPath, "utf-8");
    const pkg = JSON.parse(content);
    if (pkg.packageManager && typeof pkg.packageManager === "string") {
      const pm = pkg.packageManager.split("@")[0];  // "bun@1.2.9" -> "bun"
      return pm;
    }
  } catch {
    // Ignore parse errors
  }
  return null;
}

/**
 * Detect the project type based on files in the directory.
 *
 * Detection strategy:
 * 1. Check package.json#packageManager field (most reliable for JS ecosystem)
 * 2. Scan for language-specific config files (pyproject.toml, go.mod, Cargo.toml, etc.)
 * 3. Map detected languages to optimal stack (e.g., bun/node/typescript → WEB)
 *
 * @param directory - Project root directory path.
 * @param verbose - If true, include detection details (which file triggered each detection).
 * @returns Detection result with recommended stack and detected languages.
 * @throws Never throws - returns BASE stack if directory doesn't exist or is unreadable.
 */
export function detectProjectType(directory: string, verbose = false): DetectionResult {
  // Defensive: verify directory exists before scanning
  if (!existsSync(directory)) {
    return {
      recommendedStack: LanguageStack.BASE,
      detectedLanguages: [],
      ...(verbose && { detectionDetails: { error: "directory not found" } }),
    };
  }

  const detected: string[] = [];
  const details: Record<string, string> = {};

  // Check packageManager field first (most reliable for JS ecosystem)
  const pkgManager = detectPackageManager(directory);
  if (pkgManager === "bun") {
    detected.push("bun");
    if (verbose) { details.bun = "package.json#packageManager=bun"; }
  } else if (pkgManager === "pnpm" || pkgManager === "yarn" || pkgManager === "npm") {
    detected.push("node");
    if (verbose) { details.node = `package.json#packageManager=${pkgManager}`; }
  }

  // Scan for language patterns
  for (const [lang, patterns] of Object.entries(LANGUAGE_PATTERNS)) {
    // Skip if already detected via packageManager
    if (detected.includes(lang)) { continue; }

    for (const pattern of patterns) {
      if (hasMatchingFile(directory, pattern)) {
        detected.push(lang);
        if (verbose) { details[lang] = pattern; }
        break;
      }
    }
  }

  const stack = determineStack(detected);

  const result: DetectionResult = {
    recommendedStack: stack,
    detectedLanguages: detected,
  };

  if (verbose) {
    result.detectionDetails = details;
  }

  return result;
}

/**
 * Determine the best stack based on detected languages.
 * Returns the most specific stack for the detected language(s).
 */
function determineStack(languages: string[]): LanguageStack {
  // Helper to check for language
  const has = (lang: string) => languages.includes(lang);

  // ═══════════════════════════════════════════════════════════════════════════
  // JVM languages (check specific ones first, then fallback to java)
  // ═══════════════════════════════════════════════════════════════════════════
  if (has("scala") || has("clojure") || has("kotlin")) {
    return LanguageStack.JVM;
  }
  if (has("java")) {
    return LanguageStack.JAVA;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Systems programming languages
  // ═══════════════════════════════════════════════════════════════════════════
  if (has("go")) { return LanguageStack.GO; }
  if (has("rust")) { return LanguageStack.RUST; }
  if (has("zig") || has("nim")) { return LanguageStack.SYSTEMS; }
  if (has("cpp")) { return LanguageStack.CPP; }

  // ═══════════════════════════════════════════════════════════════════════════
  // Web/scripting languages (bun/node/deno/typescript all map to WEB)
  // ═══════════════════════════════════════════════════════════════════════════
  if (has("bun") || has("node") || has("deno") || has("typescript")) { return LanguageStack.WEB; }
  if (has("python")) { return LanguageStack.PYTHON; }
  if (has("lua")) { return LanguageStack.LUA; }

  // ═══════════════════════════════════════════════════════════════════════════
  // Scripting languages (combined: Ruby + PHP + Perl)
  // ═══════════════════════════════════════════════════════════════════════════
  if (has("ruby") || has("php") || has("perl")) { return LanguageStack.SCRIPTING; }

  // ═══════════════════════════════════════════════════════════════════════════
  // Platform-specific languages
  // ═══════════════════════════════════════════════════════════════════════════
  if (has("dotnet")) { return LanguageStack.DOTNET; }
  if (has("swift")) { return LanguageStack.SWIFT; }
  if (has("dart")) { return LanguageStack.DART; }

  // ═══════════════════════════════════════════════════════════════════════════
  // Functional languages (combined: Haskell + OCaml + Elixir + Gleam)
  // ═══════════════════════════════════════════════════════════════════════════
  if (has("elixir") || has("haskell") || has("ocaml") || has("gleam")) { return LanguageStack.FUNCTIONAL; }

  // ═══════════════════════════════════════════════════════════════════════════
  // Data science languages
  // ═══════════════════════════════════════════════════════════════════════════
  if (has("r") || has("julia")) { return LanguageStack.DATA; }

  // ═══════════════════════════════════════════════════════════════════════════
  // Nothing detected -> BASE (vanilla Claude Code)
  // ═══════════════════════════════════════════════════════════════════════════
  return LanguageStack.BASE;
}
