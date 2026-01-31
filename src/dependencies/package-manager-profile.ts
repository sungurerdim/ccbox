/**
 * Package manager profile abstraction for ccbox.
 *
 * Provides a structured way to define package manager detection rules.
 * Adding a new package manager is a 5-line change instead of 20.
 */

import type { DepsInfo } from "./detector.js";

/**
 * Profile for a package manager.
 *
 * Encapsulates detection rules, install commands, and metadata
 * for a single package manager.
 */
export interface PackageManagerProfile {
  /** Package manager name (e.g., "npm", "pip") */
  name: string;
  /** File patterns that trigger detection */
  patterns: string[];
  /** Priority (higher = run first) */
  priority: number;
  /** Custom detection function (optional, for complex cases) */
  detectFn?: (dir: string, matchedFiles: string[]) => DepsInfo | null;
  /** Install all dependencies command */
  installAll?: string;
  /** Install production-only dependencies command */
  installProd?: string;
  /** Whether dev dependencies are distinguishable */
  hasDev?: boolean;
}

/**
 * Registry for package manager profiles.
 *
 * Allows registering and querying package manager profiles.
 * Makes adding new package managers declarative.
 */
export class PackageManagerRegistry {
  private profiles: PackageManagerProfile[] = [];

  /** Register a new package manager profile. */
  register(profile: PackageManagerProfile): this {
    this.profiles.push(profile);
    return this;
  }

  /** Get all registered profiles, sorted by priority (highest first). */
  getAll(): PackageManagerProfile[] {
    return [...this.profiles].sort((a, b) => b.priority - a.priority);
  }

  /** Find profiles matching a given name. */
  findByName(name: string): PackageManagerProfile[] {
    return this.profiles.filter((p) => p.name === name);
  }

  /** Get count of registered profiles. */
  get size(): number {
    return this.profiles.length;
  }
}
