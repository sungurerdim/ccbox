/**
 * Project type detection for automatic language stack selection.
 *
 * Uses a confidence scoring system with:
 * - Per-pattern static scores (lock files, configs, extensions)
 * - Content validation for ambiguous files (peeks inside to confirm language)
 * - Source extension count scaling (single file = low confidence)
 * - Mutual exclusion rules (typescript suppresses node, etc.)
 * - Context-dependent demotion (Makefile demoted when primary language exists)
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { LanguageStack } from "./config.js";
import { log } from "./logger.js";

/** A single language detection with confidence score. */
export interface LanguageDetection {
  language: string;
  confidence: number;     // 0-100
  trigger: string;        // File/pattern that triggered detection
  stack: LanguageStack;   // Stack this language maps to
}

/** Result of project detection. */
export interface DetectionResult {
  recommendedStack: LanguageStack;
  detectedLanguages: LanguageDetection[];  // Sorted by confidence (highest first)
}

/** Confidence levels for different signal types. */
const CONFIDENCE = {
  LOCK_FILE: 95,
  PACKAGE_MANAGER_FIELD: 95,
  PRIMARY_CONFIG: 90,
  SECONDARY_CONFIG: 80,
  AMBIGUOUS_CONFIG: 50,
  GENERAL_TOOL: 40,
  SOURCE_EXTENSION: 30,
  SOURCE_EXTENSION_SINGLE: 15,   // Single source file = weak signal
  MAKEFILE_DEMOTED: 20,
  CONTENT_REJECTED: 0,          // Content validation failed
} as const;

/** Pattern with confidence score. */
interface PatternEntry {
  pattern: string;
  confidence: number;
}

/** File patterns for language detection with confidence scores. */
const LANGUAGE_PATTERNS: Record<string, PatternEntry[]> = {
  // Core languages
  python: [
    { pattern: "poetry.lock", confidence: CONFIDENCE.LOCK_FILE },
    { pattern: "uv.lock", confidence: CONFIDENCE.LOCK_FILE },
    { pattern: "pdm.lock", confidence: CONFIDENCE.LOCK_FILE },
    { pattern: "pyproject.toml", confidence: CONFIDENCE.PRIMARY_CONFIG },
    { pattern: "setup.py", confidence: CONFIDENCE.SECONDARY_CONFIG },
    { pattern: "requirements.txt", confidence: CONFIDENCE.SECONDARY_CONFIG },
    { pattern: "Pipfile", confidence: CONFIDENCE.SECONDARY_CONFIG },
    { pattern: "setup.cfg", confidence: CONFIDENCE.SECONDARY_CONFIG },
  ],
  node: [
    { pattern: "package-lock.json", confidence: CONFIDENCE.LOCK_FILE },
    { pattern: "yarn.lock", confidence: CONFIDENCE.LOCK_FILE },
    { pattern: "pnpm-lock.yaml", confidence: CONFIDENCE.LOCK_FILE },
    { pattern: "package.json", confidence: CONFIDENCE.PRIMARY_CONFIG },
  ],
  bun: [
    { pattern: "bun.lockb", confidence: CONFIDENCE.LOCK_FILE },
    { pattern: "bun.lock", confidence: CONFIDENCE.LOCK_FILE },
    { pattern: "bunfig.toml", confidence: CONFIDENCE.PRIMARY_CONFIG },
  ],
  deno: [
    { pattern: "deno.lock", confidence: CONFIDENCE.LOCK_FILE },
    { pattern: "deno.json", confidence: CONFIDENCE.PRIMARY_CONFIG },
    { pattern: "deno.jsonc", confidence: CONFIDENCE.PRIMARY_CONFIG },
  ],
  typescript: [
    { pattern: "tsconfig.json", confidence: CONFIDENCE.PRIMARY_CONFIG },
    { pattern: "tsconfig.base.json", confidence: CONFIDENCE.SECONDARY_CONFIG },
    { pattern: "tsconfig.*.json", confidence: CONFIDENCE.SECONDARY_CONFIG },
  ],
  go: [
    { pattern: "go.sum", confidence: CONFIDENCE.LOCK_FILE },
    { pattern: "go.mod", confidence: CONFIDENCE.PRIMARY_CONFIG },
  ],
  rust: [
    { pattern: "Cargo.lock", confidence: CONFIDENCE.LOCK_FILE },
    { pattern: "Cargo.toml", confidence: CONFIDENCE.PRIMARY_CONFIG },
  ],
  java: [
    { pattern: "gradle.lock", confidence: CONFIDENCE.LOCK_FILE },
    { pattern: "pom.xml", confidence: CONFIDENCE.PRIMARY_CONFIG },
    { pattern: "build.gradle", confidence: CONFIDENCE.PRIMARY_CONFIG },
    { pattern: "build.gradle.kts", confidence: CONFIDENCE.SECONDARY_CONFIG },  // .kts = Kotlin DSL, weaker Java signal
    { pattern: "settings.gradle", confidence: CONFIDENCE.SECONDARY_CONFIG },
    { pattern: "settings.gradle.kts", confidence: CONFIDENCE.SECONDARY_CONFIG },
  ],

  // Extended languages
  scala: [
    { pattern: "build.sbt", confidence: CONFIDENCE.PRIMARY_CONFIG },
    { pattern: "project/build.properties", confidence: CONFIDENCE.SECONDARY_CONFIG },
  ],
  clojure: [
    { pattern: "project.clj", confidence: CONFIDENCE.PRIMARY_CONFIG },
    { pattern: "deps.edn", confidence: CONFIDENCE.PRIMARY_CONFIG },
  ],
  kotlin: [
    { pattern: "build.gradle.kts", confidence: CONFIDENCE.PRIMARY_CONFIG },
    { pattern: "settings.gradle.kts", confidence: CONFIDENCE.SECONDARY_CONFIG },
  ],
  ruby: [
    { pattern: "Gemfile.lock", confidence: CONFIDENCE.LOCK_FILE },
    { pattern: "Gemfile", confidence: CONFIDENCE.PRIMARY_CONFIG },
    { pattern: "Rakefile", confidence: CONFIDENCE.SECONDARY_CONFIG },
    { pattern: ".ruby-version", confidence: CONFIDENCE.SECONDARY_CONFIG },
    { pattern: "*.gemspec", confidence: CONFIDENCE.SECONDARY_CONFIG },
  ],
  php: [
    { pattern: "composer.lock", confidence: CONFIDENCE.LOCK_FILE },
    { pattern: "composer.json", confidence: CONFIDENCE.PRIMARY_CONFIG },
    { pattern: "artisan", confidence: CONFIDENCE.SECONDARY_CONFIG },
  ],
  dotnet: [
    { pattern: "*.sln", confidence: CONFIDENCE.PRIMARY_CONFIG },
    { pattern: "*.csproj", confidence: CONFIDENCE.PRIMARY_CONFIG },
    { pattern: "*.fsproj", confidence: CONFIDENCE.PRIMARY_CONFIG },
    { pattern: "*.vbproj", confidence: CONFIDENCE.PRIMARY_CONFIG },
    { pattern: "global.json", confidence: CONFIDENCE.SECONDARY_CONFIG },
    { pattern: "nuget.config", confidence: CONFIDENCE.SECONDARY_CONFIG },
  ],
  elixir: [
    { pattern: "mix.lock", confidence: CONFIDENCE.LOCK_FILE },
    { pattern: "mix.exs", confidence: CONFIDENCE.PRIMARY_CONFIG },
  ],
  haskell: [
    { pattern: "stack.yaml", confidence: CONFIDENCE.PRIMARY_CONFIG },
    { pattern: "cabal.project", confidence: CONFIDENCE.PRIMARY_CONFIG },
    { pattern: "*.cabal", confidence: CONFIDENCE.PRIMARY_CONFIG },
    { pattern: "package.yaml", confidence: CONFIDENCE.SECONDARY_CONFIG },
  ],
  swift: [
    { pattern: "Package.swift", confidence: CONFIDENCE.PRIMARY_CONFIG },
    { pattern: "*.xcodeproj", confidence: CONFIDENCE.SECONDARY_CONFIG },
    { pattern: "*.xcworkspace", confidence: CONFIDENCE.SECONDARY_CONFIG },
  ],
  dart: [
    { pattern: "pubspec.lock", confidence: CONFIDENCE.LOCK_FILE },
    { pattern: "pubspec.yaml", confidence: CONFIDENCE.PRIMARY_CONFIG },
  ],
  perl: [
    { pattern: "cpanfile", confidence: CONFIDENCE.PRIMARY_CONFIG },
    { pattern: "Makefile.PL", confidence: CONFIDENCE.SECONDARY_CONFIG },
    { pattern: "Build.PL", confidence: CONFIDENCE.SECONDARY_CONFIG },
    { pattern: "*.pm", confidence: CONFIDENCE.SOURCE_EXTENSION },
  ],
  lua: [
    { pattern: "*.rockspec", confidence: CONFIDENCE.SECONDARY_CONFIG },
    { pattern: ".luacheckrc", confidence: CONFIDENCE.SECONDARY_CONFIG },
    { pattern: "*.lua", confidence: CONFIDENCE.SOURCE_EXTENSION },
  ],
  ocaml: [
    { pattern: "dune-project", confidence: CONFIDENCE.PRIMARY_CONFIG },
    { pattern: "*.opam", confidence: CONFIDENCE.PRIMARY_CONFIG },
    { pattern: "dune", confidence: CONFIDENCE.SECONDARY_CONFIG },
    { pattern: "_opam", confidence: CONFIDENCE.SECONDARY_CONFIG },
  ],
  cpp: [
    { pattern: "CMakeLists.txt", confidence: CONFIDENCE.PRIMARY_CONFIG },
    { pattern: "conanfile.txt", confidence: CONFIDENCE.PRIMARY_CONFIG },
    { pattern: "conanfile.py", confidence: CONFIDENCE.PRIMARY_CONFIG },
    { pattern: "vcpkg.json", confidence: CONFIDENCE.PRIMARY_CONFIG },
    { pattern: "Makefile", confidence: CONFIDENCE.GENERAL_TOOL },
    { pattern: "*.cpp", confidence: CONFIDENCE.SOURCE_EXTENSION },
    { pattern: "*.hpp", confidence: CONFIDENCE.SOURCE_EXTENSION },
  ],
  r: [
    { pattern: "renv.lock", confidence: CONFIDENCE.LOCK_FILE },
    { pattern: "DESCRIPTION", confidence: CONFIDENCE.AMBIGUOUS_CONFIG },
    { pattern: ".Rprofile", confidence: CONFIDENCE.SECONDARY_CONFIG },
    { pattern: "*.Rproj", confidence: CONFIDENCE.PRIMARY_CONFIG },
  ],
  julia: [
    { pattern: "Manifest.toml", confidence: CONFIDENCE.LOCK_FILE },
    { pattern: "Project.toml", confidence: CONFIDENCE.AMBIGUOUS_CONFIG },
  ],
  zig: [
    { pattern: "build.zig", confidence: CONFIDENCE.PRIMARY_CONFIG },
    { pattern: "build.zig.zon", confidence: CONFIDENCE.PRIMARY_CONFIG },
  ],
  nim: [
    { pattern: "*.nimble", confidence: CONFIDENCE.PRIMARY_CONFIG },
    { pattern: "nim.cfg", confidence: CONFIDENCE.SECONDARY_CONFIG },
    { pattern: "*.nim", confidence: CONFIDENCE.SOURCE_EXTENSION },
  ],
  gleam: [
    { pattern: "gleam.toml", confidence: CONFIDENCE.PRIMARY_CONFIG },
    { pattern: "manifest.toml", confidence: CONFIDENCE.AMBIGUOUS_CONFIG },
  ],
};

// ═══════════════════════════════════════════════════════════════════════════════
// Content validators — peek inside ambiguous files to confirm language
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Content validator functions for ambiguous config files.
 * Returns adjusted confidence (0 = reject, original = confirm).
 * Only called when the file exists and matched a pattern.
 */
type ContentValidator = (directory: string, originalConfidence: number) => number;

/** Read first N bytes of a file (efficient for large files). */
function readHead(filePath: string, bytes = 2048): string {
  try {
    return readFileSync(filePath, "utf-8").slice(0, bytes);
  } catch {
    return "";
  }
}

const CONTENT_VALIDATORS: Record<string, Record<string, ContentValidator>> = {
  python: {
    // pyproject.toml without [project] or [tool.poetry/pdm/setuptools] = likely not Python
    // (could be ruff/black-only config in a JS project)
    "pyproject.toml": (dir, conf) => {
      const content = readHead(join(dir, "pyproject.toml"));
      const pythonMarkers = [
        "[project]",
        "[tool.poetry]",
        "[tool.pdm]",
        "[tool.setuptools]",
        "[tool.hatch]",
        "[tool.flit",
        "[build-system]",
      ];
      return pythonMarkers.some((m) => content.includes(m)) ? conf : CONFIDENCE.CONTENT_REJECTED;
    },
  },
  r: {
    // DESCRIPTION without R-specific fields = not R (common filename)
    "DESCRIPTION": (dir, conf) => {
      const content = readHead(join(dir, "DESCRIPTION"));
      const rMarkers = ["Package:", "Type:", "Imports:", "Depends:", "License:"];
      // Need at least 2 R-specific fields to confirm
      const matchCount = rMarkers.filter((m) => content.includes(m)).length;
      return matchCount >= 2 ? conf : CONFIDENCE.CONTENT_REJECTED;
    },
  },
  julia: {
    // Project.toml without Julia-specific structure = not Julia
    "Project.toml": (dir, conf) => {
      const content = readHead(join(dir, "Project.toml"));
      const juliaMarkers = ["uuid", "[deps]", "[compat]", "julia ="];
      return juliaMarkers.some((m) => content.includes(m)) ? conf : CONFIDENCE.CONTENT_REJECTED;
    },
  },
  gleam: {
    // manifest.toml without Gleam-specific content = not Gleam
    "manifest.toml": (dir, conf) => {
      const content = readHead(join(dir, "manifest.toml"));
      return content.includes("[packages]") ? conf : CONFIDENCE.CONTENT_REJECTED;
    },
  },
  cpp: {
    // Makefile with C/C++ compiler references = stronger cpp signal
    "Makefile": (dir, conf) => {
      const content = readHead(join(dir, "Makefile"), 4096);
      const cppMarkers = ["gcc", "g++", "clang", "clang++", "$(CC)", "$(CXX)", ".cpp", ".c ", ".o "];
      const hasCppContent = cppMarkers.some((m) => content.includes(m));
      // Boost to SECONDARY_CONFIG if C/C++ content found, keep GENERAL_TOOL otherwise
      return hasCppContent ? CONFIDENCE.SECONDARY_CONFIG : conf;
    },
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// Source extension count scaling
// ═══════════════════════════════════════════════════════════════════════════════

/** Source extensions that benefit from count-based scaling. */
const SOURCE_EXTENSIONS: Record<string, string[]> = {
  cpp: [".cpp", ".hpp", ".cc", ".cxx", ".hxx"],
  lua: [".lua"],
  nim: [".nim"],
  perl: [".pm", ".pl"],
};

/**
 * Count source files for a language and scale confidence.
 * 1 file = SOURCE_EXTENSION_SINGLE (15), 2+ = SOURCE_EXTENSION (30).
 */
function scaleSourceConfidence(directory: string, lang: string, baseConfidence: number): number {
  const extensions = SOURCE_EXTENSIONS[lang];
  if (!extensions || baseConfidence !== CONFIDENCE.SOURCE_EXTENSION) {
    return baseConfidence;
  }

  const files = getDirFiles(directory);
  const count = files.filter((f) => extensions.some((ext) => f.endsWith(ext))).length;

  if (count === 0) { return CONFIDENCE.CONTENT_REJECTED; }
  if (count === 1) { return CONFIDENCE.SOURCE_EXTENSION_SINGLE; }
  return CONFIDENCE.SOURCE_EXTENSION;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Mutual exclusion rules
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * When language A is detected, suppress or demote language B.
 * Format: { suppressor: target } — target is removed from detections.
 */
const SUPPRESSION_RULES: Array<{ if: string; suppress: string }> = [
  // typescript project ⊃ node (tsconfig.json implies package.json is just config)
  { if: "typescript", suppress: "node" },
  // bun project suppresses node (bun is the runtime)
  { if: "bun", suppress: "node" },
  // deno suppresses node
  { if: "deno", suppress: "node" },
  // scala/kotlin/clojure suppress java (JVM languages include Java tooling)
  { if: "scala", suppress: "java" },
  { if: "kotlin", suppress: "java" },
  { if: "clojure", suppress: "java" },
];

// ═══════════════════════════════════════════════════════════════════════════════
// Promotion rules: multi-language → combined stack
// ═══════════════════════════════════════════════════════════════════════════════

const WEB_FAMILY = new Set(["typescript", "node", "bun", "deno"]);

const PROMOTION_RULES: Array<{
  if: (langs: Set<string>) => boolean;
  promote: LanguageStack;
  label: string;
}> = [
  {
    if: (langs) => [...langs].some(l => WEB_FAMILY.has(l)) && langs.has("python"),
    promote: LanguageStack.FULLSTACK,
    label: "web+python → fullstack",
  },
];

// ═══════════════════════════════════════════════════════════════════════════════
// Core detection logic
// ═══════════════════════════════════════════════════════════════════════════════

/** Check if a file matches a pattern (supports * prefix wildcard) */
function matchesPattern(filename: string, pattern: string): boolean {
  if (pattern.startsWith("*.")) {
    const ext = pattern.slice(1);  // ".csproj", ".cabal" etc.
    return filename.endsWith(ext);
  }
  return filename === pattern;
}

/** Cached directory listing for glob patterns (avoids repeated readdirSync) */
let _dirCacheKey = "";
let _dirCacheFiles: string[] = [];

function getDirFiles(directory: string): string[] {
  if (_dirCacheKey === directory) { return _dirCacheFiles; }
  try {
    const entries = readdirSync(directory, { withFileTypes: true });
    _dirCacheFiles = entries.filter((f) => f.isFile()).map((f) => f.name);
  } catch {
    _dirCacheFiles = [];
  }
  _dirCacheKey = directory;
  return _dirCacheFiles;
}

/** Check if directory contains files matching the pattern */
function hasMatchingFile(directory: string, pattern: string): boolean {
  // Exact match - fast path
  if (!pattern.includes("*")) {
    return existsSync(join(directory, pattern));
  }

  // Glob pattern - use cached directory listing
  return getDirFiles(directory).some((name) => matchesPattern(name, pattern));
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

/** Map a language to its corresponding LanguageStack. */
function languageToStack(lang: string): LanguageStack {
  switch (lang) {
    case "scala": case "clojure": case "kotlin": return LanguageStack.JVM;
    case "java": return LanguageStack.JAVA;
    case "go": return LanguageStack.GO;
    case "rust": return LanguageStack.RUST;
    case "zig": case "nim": return LanguageStack.SYSTEMS;
    case "cpp": return LanguageStack.CPP;
    case "bun": case "node": case "deno": case "typescript": return LanguageStack.WEB;
    case "python": return LanguageStack.PYTHON;
    case "lua": return LanguageStack.LUA;
    case "ruby": case "php": case "perl": return LanguageStack.SCRIPTING;
    case "dotnet": return LanguageStack.DOTNET;
    case "swift": return LanguageStack.SWIFT;
    case "dart": return LanguageStack.DART;
    case "elixir": case "haskell": case "ocaml": case "gleam": return LanguageStack.FUNCTIONAL;
    case "r": case "julia": return LanguageStack.DATA;
    default: return LanguageStack.BASE;
  }
}

/**
 * Detect the project type based on files in the directory.
 *
 * Uses a confidence scoring system where each file pattern has a score,
 * refined by content validation, source count scaling, and mutual exclusion.
 * The language with the highest confidence score determines the recommended stack.
 *
 * @param directory - Project root directory path.
 * @param verbose - If true, log detection details.
 * @returns Detection result with recommended stack and detected languages with scores.
 * @throws Never throws - returns BASE stack if directory doesn't exist or is unreadable.
 */
export function detectProjectType(directory: string, verbose = false): DetectionResult {
  // Defensive: verify directory exists before scanning
  if (!existsSync(directory)) {
    return {
      recommendedStack: LanguageStack.BASE,
      detectedLanguages: [],
    };
  }

  const detections: LanguageDetection[] = [];

  // Check packageManager field first (most reliable for JS ecosystem)
  const pkgManager = detectPackageManager(directory);
  if (pkgManager === "bun") {
    detections.push({
      language: "bun",
      confidence: CONFIDENCE.PACKAGE_MANAGER_FIELD,
      trigger: "package.json#packageManager=bun",
      stack: LanguageStack.WEB,
    });
  } else if (pkgManager === "pnpm" || pkgManager === "yarn" || pkgManager === "npm") {
    detections.push({
      language: "node",
      confidence: CONFIDENCE.PACKAGE_MANAGER_FIELD,
      trigger: `package.json#packageManager=${pkgManager}`,
      stack: LanguageStack.WEB,
    });
  }

  if (verbose) {
    const files = getDirFiles(directory);
    log.debug(`Scanning ${directory} (${files.length} files)`);
  }

  // Scan for language patterns - pick highest confidence match per language
  const detectedLangs = new Set(detections.map((d) => d.language));

  for (const [lang, patterns] of Object.entries(LANGUAGE_PATTERNS)) {
    // Skip if already detected via packageManager
    if (detectedLangs.has(lang)) { continue; }

    let bestConfidence = 0;
    let bestTrigger = "";

    for (const { pattern, confidence } of patterns) {
      if (hasMatchingFile(directory, pattern)) {
        let adjustedConfidence = confidence;

        // Content validation: peek inside ambiguous files
        const validator = CONTENT_VALIDATORS[lang]?.[pattern];
        if (validator) {
          adjustedConfidence = validator(directory, confidence);
          if (verbose && adjustedConfidence !== confidence) {
            log.debug(`  content-check: ${lang} ← ${pattern} (${confidence} → ${adjustedConfidence})`);
          }
        }

        // Source extension count scaling
        adjustedConfidence = scaleSourceConfidence(directory, lang, adjustedConfidence);

        if (verbose && adjustedConfidence > 0) {
          log.debug(`  match: ${lang} ← ${pattern} (${adjustedConfidence})`);
        }

        if (adjustedConfidence > bestConfidence) {
          bestConfidence = adjustedConfidence;
          bestTrigger = pattern;
        }
      }
    }

    if (bestConfidence > 0) {
      detections.push({
        language: lang,
        confidence: bestConfidence,
        trigger: bestTrigger,
        stack: languageToStack(lang),
      });
    }
  }

  // Makefile context-dependent scoring:
  // If a primary language (not cpp) is detected with high confidence,
  // demote Makefile-triggered cpp detection since Makefile is multi-purpose.
  const cppIdx = detections.findIndex((d) => d.language === "cpp");
  if (cppIdx !== -1 && detections[cppIdx]!.trigger === "Makefile") {
    const hasPrimaryLanguage = detections.some(
      (d) => d.language !== "cpp" && d.confidence >= CONFIDENCE.SECONDARY_CONFIG
    );
    if (hasPrimaryLanguage) {
      detections[cppIdx] = {
        ...detections[cppIdx]!,
        confidence: CONFIDENCE.MAKEFILE_DEMOTED,
      };
    }
  }

  // Apply mutual exclusion rules: remove suppressed languages
  const suppressedLangs = new Set<string>();
  const detectedLangSet = new Set(detections.map((d) => d.language));
  for (const rule of SUPPRESSION_RULES) {
    if (detectedLangSet.has(rule.if) && detectedLangSet.has(rule.suppress)) {
      suppressedLangs.add(rule.suppress);
      if (verbose) {
        log.debug(`  suppress: ${rule.suppress} (${rule.if} detected)`);
      }
    }
  }

  const filtered = suppressedLangs.size > 0
    ? detections.filter((d) => !suppressedLangs.has(d.language))
    : detections;

  // Sort by confidence (highest first)
  filtered.sort((a, b) => b.confidence - a.confidence);

  // Determine stack from highest confidence detection
  const stack = filtered.length > 0
    ? filtered[0]!.stack
    : LanguageStack.BASE;

  // Apply promotion rules: multi-language → combined stack
  const detectedLangSet2 = new Set(filtered.map(d => d.language));
  for (const rule of PROMOTION_RULES) {
    if (rule.if(detectedLangSet2)) {
      if (verbose) log.debug(`  promote: ${rule.label}`);
      return { recommendedStack: rule.promote, detectedLanguages: filtered };
    }
  }

  return {
    recommendedStack: stack,
    detectedLanguages: filtered,
  };
}
