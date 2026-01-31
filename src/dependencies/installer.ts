/**
 * Dependency installation utilities for ccbox.
 *
 * Generates install commands and computes dependency hashes for cache invalidation.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { DepsInfo, DepsMode } from "./detector.js";

/**
 * Compute a stable hash of dependency files for cache invalidation.
 *
 * Reads the content of all dependency files and produces a short SHA-256 hash.
 * Used to determine if project image needs rebuilding.
 *
 * @param depsList - Detected dependencies with file lists.
 * @param projectPath - Project root directory.
 * @returns Hex hash string (first 16 chars of SHA-256).
 */
export function computeDepsHash(depsList: DepsInfo[], projectPath: string): string {
  const hash = createHash("sha256");

  // Sort for deterministic ordering
  const allFiles = [...new Set(depsList.flatMap((d) => [...d.files]))].sort();

  for (const file of allFiles) {
    const filePath = join(projectPath, file);
    try {
      const content = readFileSync(filePath, "utf-8");
      hash.update(`${file}\n${content}\n`);
    } catch {
      hash.update(`${file}\n<missing>\n`);
    }
  }

  return hash.digest("hex").slice(0, 16);
}

/**
 * Get installation commands for detected dependencies.
 *
 * @param depsList - List of detected dependencies.
 * @param mode - Installation mode (all, prod, skip).
 * @returns List of shell commands to run.
 */
export function getInstallCommands(depsList: DepsInfo[], mode: DepsMode): string[] {
  if (mode === "skip") {return [];}

  return depsList.map((deps) => (mode === "all" ? deps.installAll : deps.installProd));
}
