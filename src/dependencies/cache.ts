/**
 * Dependency cache for ccbox.
 *
 * Caches detected dependencies to avoid re-scanning on every run.
 * Invalidation: any lock file newer than cache timestamp = invalidate.
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { DepsInfo } from "./detector.js";

/** Cached dependency information. */
export interface DepsCache {
  readonly hash: string;
  readonly timestamp: number;
  readonly detectedDeps: DepsInfo[];
  readonly cacheTimestamp: number;
}

const CACHE_DIR = ".ccbox/cache";
const CACHE_FILE = "deps.json";

/** Lock files that trigger cache invalidation when modified. */
const LOCK_FILES = [
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lockb",
  "bun.lock",
  "poetry.lock",
  "pdm.lock",
  "uv.lock",
  "Pipfile.lock",
  "go.sum",
  "Cargo.lock",
  "Gemfile.lock",
  "composer.lock",
  "mix.lock",
  "pubspec.lock",
  "requirements.txt",
  "pyproject.toml",
  "package.json",
  "go.mod",
  "Cargo.toml",
  "Gemfile",
  "composer.json",
  "mix.exs",
  "pubspec.yaml",
];

/**
 * Get the cache file path for a project.
 */
function getCachePath(projectDir: string): string {
  return join(projectDir, CACHE_DIR, CACHE_FILE);
}

/**
 * Load cached dependency information.
 * Returns null if cache doesn't exist or is malformed.
 */
export function loadCache(projectDir: string): DepsCache | null {
  const cachePath = getCachePath(projectDir);
  if (!existsSync(cachePath)) {
    return null;
  }

  try {
    const content = readFileSync(cachePath, "utf-8");
    const parsed = JSON.parse(content) as DepsCache;

    // Basic validation
    if (!parsed.hash || !parsed.cacheTimestamp || !Array.isArray(parsed.detectedDeps)) {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

/**
 * Save dependency cache to disk.
 */
export function saveCache(
  projectDir: string,
  deps: DepsInfo[],
  hash: string
): void {
  const cacheDir = join(projectDir, CACHE_DIR);
  const cachePath = getCachePath(projectDir);

  try {
    mkdirSync(cacheDir, { recursive: true });
    const cache: DepsCache = {
      hash,
      timestamp: Date.now(),
      detectedDeps: deps,
      cacheTimestamp: Date.now(),
    };
    writeFileSync(cachePath, JSON.stringify(cache, null, 2), "utf-8");
  } catch {
    // Non-fatal: cache write failure shouldn't break the build
  }
}

/**
 * Check if the dependency cache is still valid.
 *
 * Invalid if any lock file has been modified since the cache was written.
 */
export function isCacheValid(projectDir: string): boolean {
  const cache = loadCache(projectDir);
  if (!cache) {
    return false;
  }

  const cacheTime = cache.cacheTimestamp;

  for (const lockFile of LOCK_FILES) {
    const filePath = join(projectDir, lockFile);
    if (!existsSync(filePath)) {
      continue;
    }

    try {
      const stat = statSync(filePath);
      if (stat.mtimeMs > cacheTime) {
        return false;
      }
    } catch {
      // If we can't stat the file, invalidate to be safe
      return false;
    }
  }

  return true;
}
