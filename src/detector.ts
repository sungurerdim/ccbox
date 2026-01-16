/**
 * Project type detection for automatic language stack selection.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import { LanguageStack } from "./config.js";

/** Result of project detection. */
export interface DetectionResult {
  recommendedStack: LanguageStack;
  detectedLanguages: string[];
}

/** File patterns for language detection */
const LANGUAGE_PATTERNS: Record<string, string[]> = {
  python: ["pyproject.toml", "setup.py", "requirements.txt", "Pipfile", "poetry.lock"],
  node: ["package.json", "package-lock.json", "yarn.lock", "pnpm-lock.yaml"],
  go: ["go.mod", "go.sum"],
  rust: ["Cargo.toml", "Cargo.lock"],
  java: ["pom.xml", "build.gradle", "build.gradle.kts"],
};

/**
 * Detect the project type based on files in the directory.
 *
 * @param directory - Project root directory path.
 * @returns Detection result with recommended stack and detected languages.
 */
export function detectProjectType(directory: string): DetectionResult {
  const detected: string[] = [];

  for (const [lang, patterns] of Object.entries(LANGUAGE_PATTERNS)) {
    for (const pattern of patterns) {
      if (existsSync(join(directory, pattern))) {
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
 */
function determineStack(languages: string[]): LanguageStack {
  const hasPython = languages.includes("python");
  const hasNode = languages.includes("node");
  const hasGo = languages.includes("go");
  const hasRust = languages.includes("rust");
  const hasJava = languages.includes("java");

  // Multiple compiled languages -> FULL
  const compiledCount = [hasGo, hasRust, hasJava].filter(Boolean).length;
  if (compiledCount >= 2) {
    return LanguageStack.FULL;
  }

  // Single compiled language takes priority
  if (hasGo) {return LanguageStack.GO;}
  if (hasRust) {return LanguageStack.RUST;}
  if (hasJava) {return LanguageStack.JAVA;}

  // Node + Python -> WEB (fullstack)
  if (hasNode && hasPython) {
    return LanguageStack.WEB;
  }

  // Python only, Node only, or nothing -> BASE
  // (BASE includes Python + Node tools anyway)
  return LanguageStack.BASE;
}
