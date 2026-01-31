/**
 * Generic Docker list operations for ccbox.
 *
 * DRY extraction of common Docker list/filter patterns.
 * Used by inspect.ts for getImageIds, listImages, listContainers, etc.
 */

import { safeDockerRun } from "./executor.js";

/**
 * Generic Docker list operation.
 *
 * Executes a docker command that returns line-separated output and parses results.
 *
 * @param args - Docker command arguments.
 * @param parseItem - Transform each line into the desired type (return null to skip).
 * @returns List of parsed items.
 */
export async function listDockerItems<T>(
  args: string[],
  parseItem: (line: string) => T | null = (line) => line as unknown as T
): Promise<T[]> {
  try {
    const result = await safeDockerRun(args);
    if (result.exitCode !== 0) { return []; }

    const lines = result.stdout.trim().split("\n").filter(Boolean);
    const items: T[] = [];

    for (const line of lines) {
      const item = parseItem(line);
      if (item !== null) {
        items.push(item);
      }
    }

    return items;
  } catch {
    return [];
  }
}

/**
 * List Docker items as a Set (for fast lookups).
 */
export async function listDockerItemsAsSet(
  args: string[],
  parseItem?: (line: string) => string | null
): Promise<Set<string>> {
  const items = await listDockerItems<string>(args, parseItem);
  return new Set(items);
}
