/**
 * GitHub API client for ccbox.
 *
 * Handles release checking and asset downloads with retry and timeout.
 * Extracted from upgrade.ts for reusability.
 */

import { retryAsync } from "../utils/retry-with-backoff.js";

const REPO = "sungurerdim/ccbox";
const GITHUB_API_URL = `https://api.github.com/repos/${REPO}/releases/latest`;

/** GitHub release metadata. */
export interface GitHubRelease {
  tag_name: string;
  html_url: string;
}

/** Wrap a promise with a timeout. */
async function withTimeout<T>(promise: Promise<T>, ms: number, label = "Operation"): Promise<T> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), ms);
  try {
    const result = await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        controller.signal.addEventListener("abort", () =>
          reject(new Error(`${label} timed out after ${ms}ms`))
        );
      }),
    ]);
    return result;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Fetch latest release info from GitHub.
 */
export async function fetchLatestRelease(): Promise<GitHubRelease | null> {
  if (!GITHUB_API_URL.startsWith("https://")) {
    throw new Error(`Refusing to fetch from non-HTTPS URL: ${GITHUB_API_URL}`);
  }
  try {
    const response = await withTimeout(
      fetch(GITHUB_API_URL, {
        headers: {
          Accept: "application/vnd.github.v3+json",
          "User-Agent": "ccbox",
        },
      }),
      15_000,
      "GitHub API fetch"
    );
    if (!response.ok) { return null; }
    const json = (await response.json()) as Record<string, unknown>;
    if (!json || typeof json.tag_name !== "string") {
      return null;
    }
    return json as unknown as GitHubRelease;
  } catch {
    return null;
  }
}

/**
 * Download a file from a URL with retry.
 */
export async function downloadFile(url: string): Promise<Buffer> {
  if (!url.startsWith("https://")) {
    throw new Error(`Refusing to download from non-HTTPS URL: ${url}`);
  }
  return retryAsync(async () => {
    const response = await withTimeout(
      fetch(url, {
        headers: { "User-Agent": "ccbox" },
        redirect: "follow",
      }),
      15_000,
      "Binary download"
    );
    if (!response.ok) {
      throw new Error(`Download failed: ${response.status} ${response.statusText}`);
    }
    return Buffer.from(await response.arrayBuffer());
  }, 3, 1000, "downloadFile");
}

/**
 * Fetch checksums.txt from a GitHub release.
 */
export async function fetchChecksums(tagName: string): Promise<Map<string, string> | null> {
  const url = `https://github.com/${REPO}/releases/download/${tagName}/checksums.txt`;
  try {
    const response = await withTimeout(
      fetch(url, {
        headers: { "User-Agent": "ccbox" },
        redirect: "follow",
      }),
      15_000,
      "Checksums fetch"
    );
    if (!response.ok) { return null; }
    const text = await response.text();
    const map = new Map<string, string>();
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) { continue; }
      const match = trimmed.match(/^([0-9a-f]{64})\s+(.+)$/);
      if (match) {
        map.set(match[2], match[1]);
      }
    }
    return map.size > 0 ? map : null;
  } catch {
    return null;
  }
}

/**
 * Compare semantic versions.
 * Returns: -1 if a < b, 0 if a === b, 1 if a > b
 */
export function compareVersions(a: string, b: string): number {
  const partsA = a.replace(/^v/, "").split(".").map(Number);
  const partsB = b.replace(/^v/, "").split(".").map(Number);
  const len = Math.max(partsA.length, partsB.length);

  const diff = Array.from({ length: len }, (_, i) => (partsA[i] || 0) - (partsB[i] || 0))
    .find((d) => d !== 0);
  return diff === undefined ? 0 : diff > 0 ? 1 : -1;
}

/** Get the GitHub repository identifier. */
export function getRepo(): string {
  return REPO;
}
