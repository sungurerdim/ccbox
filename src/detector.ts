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
}

/** File patterns for language detection (exact names or glob with *) */
const LANGUAGE_PATTERNS: Record<string, string[]> = {
  // Core languages
  python: ["pyproject.toml", "setup.py", "requirements.txt", "Pipfile", "poetry.lock", "uv.lock", "setup.cfg"],
  node: ["package.json", "package-lock.json", "yarn.lock", "pnpm-lock.yaml"],
  bun: ["bun.lockb", "bunfig.toml"],  // Bun-specific (also check packageManager)
  typescript: ["tsconfig.json", "tsconfig.base.json", "tsconfig.*.json"],
  go: ["go.mod", "go.sum"],
  rust: ["Cargo.toml", "Cargo.lock"],
  java: ["pom.xml", "build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts"],

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
 * @param directory - Project root directory path.
 * @returns Detection result with recommended stack and detected languages.
 */
export function detectProjectType(directory: string): DetectionResult {
  const detected: string[] = [];

  // Check packageManager field first (most reliable for JS ecosystem)
  const pkgManager = detectPackageManager(directory);
  if (pkgManager === "bun") {
    detected.push("bun");
  } else if (pkgManager === "pnpm" || pkgManager === "yarn" || pkgManager === "npm") {
    detected.push("node");
  }

  // Scan for language patterns
  for (const [lang, patterns] of Object.entries(LANGUAGE_PATTERNS)) {
    // Skip if already detected via packageManager
    if (detected.includes(lang)) { continue; }

    for (const pattern of patterns) {
      if (hasMatchingFile(directory, pattern)) {
        detected.push(lang);
        break;
      }
    }
  }

  const stack = determineStack(detected);

  return {
    recommendedStack: stack,
    detectedLanguages: detected,
  };
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
  // Web/scripting languages (bun/node/typescript all map to WEB)
  // ═══════════════════════════════════════════════════════════════════════════
  if (has("bun") || has("node") || has("typescript")) { return LanguageStack.WEB; }
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
  // Functional languages (combined: Haskell + OCaml + Elixir)
  // ═══════════════════════════════════════════════════════════════════════════
  if (has("elixir") || has("haskell") || has("ocaml")) { return LanguageStack.FUNCTIONAL; }

  // ═══════════════════════════════════════════════════════════════════════════
  // Data science languages
  // ═══════════════════════════════════════════════════════════════════════════
  if (has("r") || has("julia")) { return LanguageStack.DATA; }

  // ═══════════════════════════════════════════════════════════════════════════
  // Nothing detected -> BASE (vanilla Claude Code)
  // ═══════════════════════════════════════════════════════════════════════════
  return LanguageStack.BASE;
}
