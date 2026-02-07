/**
 * Self-update, uninstall, and version check for ccbox.
 *
 * Uses rename-based self-update pattern:
 * - Windows: rename running exe → .old, move new → exe, cleanup .old
 * - Linux/macOS: overwrite directly (OS allows replacing running binary)
 */

import { log } from "./logger.js";
import { createHash } from "crypto";
import { writeFileSync, renameSync, unlinkSync, chmodSync, existsSync } from "fs";
import { VERSION } from "./constants.js";

const REPO = "sungurerdim/ccbox";
const GITHUB_API_URL = `https://api.github.com/repos/${REPO}/releases/latest`;

/** Wrap a promise with a timeout. Rejects with TimeoutError if not resolved in time. */
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

/** Retry transient errors with exponential backoff. */
async function withRetry<T>(
  fn: () => Promise<T>,
  retries = 3,
  label = "Operation"
): Promise<T> {
  const RETRYABLE = ["ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "UND_ERR_CONNECT_TIMEOUT"];
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      const code = (err as { code?: string }).code ?? "";
      const message = err instanceof Error ? err.message : String(err);
      const isRetryable = RETRYABLE.includes(code)
        || message.includes("fetch failed")
        || /5\d{2}/.test(message);

      if (!isRetryable || attempt === retries) {
        throw err;
      }
      const delay = Math.min(1000 * 2 ** attempt, 8000);
      log.debug(`${label} attempt ${attempt + 1} failed (${code || message}), retrying in ${delay}ms`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw new Error(`${label} failed after ${retries + 1} attempts`);
}

interface GitHubRelease {
  tag_name: string;
  html_url: string;
}

/**
 * Get the path to the current executable.
 */
function getExePath(): string {
  return process.execPath;
}

/**
 * Detect platform string for download URL.
 */
function detectPlatform(): string {
  const os = process.platform === "win32" ? "windows"
    : process.platform === "darwin" ? "darwin"
    : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  return `${os}-${arch}`;
}

/**
 * Fetch latest release info from GitHub.
 */
async function fetchLatestRelease(): Promise<GitHubRelease | null> {
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
    if (!response.ok) {return null;}
    const json = (await response.json()) as Record<string, unknown>;
    if (!json || typeof json.tag_name !== "string") {
      log.debug("Invalid GitHub release response: missing or non-string tag_name");
      return null;
    }
    return json as unknown as GitHubRelease;
  } catch {
    return null;
  }
}

/**
 * Compare semantic versions.
 * Returns: -1 if a < b, 0 if a === b, 1 if a > b
 */
function compareVersions(a: string, b: string): number {
  const partsA = a.replace(/^v/, "").split(".").map(Number);
  const partsB = b.replace(/^v/, "").split(".").map(Number);
  const len = Math.max(partsA.length, partsB.length);

  const diff = Array.from({ length: len }, (_, i) => (partsA[i] || 0) - (partsB[i] || 0))
    .find((d) => d !== 0);
  return diff === undefined ? 0 : diff > 0 ? 1 : -1;
}

/**
 * Download a file and return its contents as a Buffer.
 */
async function downloadFile(url: string): Promise<Buffer> {
  if (!url.startsWith("https://")) {
    throw new Error(`Refusing to download from non-HTTPS URL: ${url}`);
  }
  return withRetry(async () => {
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
  }, 3, "downloadFile");
}

/**
 * Fetch checksums.txt from a GitHub release and parse into a Map<filename, hash>.
 * Returns null if the file is unavailable (old release, network error).
 */
async function fetchChecksums(tagName: string): Promise<Map<string, string> | null> {
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
    if (!response.ok) {return null;}
    const text = await response.text();
    const map = new Map<string, string>();
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) {continue;}
      // Format: "hash  filename" (two spaces)
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
 * Verify a buffer's SHA-256 hash against an expected hex digest.
 */
function verifyChecksum(data: Buffer, expectedHash: string): boolean {
  const actual = createHash("sha256").update(data).digest("hex");
  return actual === expectedHash.toLowerCase();
}

/**
 * Clean up leftover .old file from previous update.
 */
function cleanupOldBinary(): void {
  const oldPath = getExePath() + ".old";
  try {
    if (existsSync(oldPath)) {
      unlinkSync(oldPath);
    }
  } catch (err: unknown) {
    const code = (err as { code?: string }).code ?? "";
    // EBUSY/EACCES expected on Windows when binary is still locked
    if (code === "EBUSY" || code === "EACCES") {
      // Silently ignore - will be cleaned next run
    } else {
      log.debug(`cleanupOldBinary failed (${code}): ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

interface UpdateOptions {
  skipConfirm?: boolean;
  forceReinstall?: boolean;
}

/**
 * Self-update: download new binary and replace current executable.
 */
export async function selfUpdate(options: UpdateOptions = {}): Promise<void> {
  const { skipConfirm = false, forceReinstall = false } = options;

  // Clean up leftover from previous update
  cleanupOldBinary();

  const currentVersion = `v${VERSION}`;

  log.dim("  Checking for updates...");
  log.newline();

  const release = await fetchLatestRelease();
  if (!release) {
    log.error("  Failed to check (network error or rate limited)");
    process.exit(1);
  }

  const latestVersion = release.tag_name;

  log.raw(`  Current  ${currentVersion}`);
  log.raw(`  Latest   ${latestVersion}`);

  if (!forceReinstall && compareVersions(currentVersion, latestVersion) >= 0) {
    log.newline();
    log.success("  Already up to date");
    return;
  }

  // Confirm unless -y flag was passed
  if (!skipConfirm) {
    log.newline();
    const { confirm } = await import("./prompt-io.js");
    const confirmed = await confirm({
      message: `Update to ${latestVersion}?`,
      default: true,
    });
    if (!confirmed) {
      log.dim("  Cancelled.");
      return;
    }
  }

  // Download
  const platform = detectPlatform();
  const ext = process.platform === "win32" ? ".exe" : "";
  const binaryName = `ccbox-${latestVersion}-${platform}${ext}`;
  const downloadUrl = `https://github.com/${REPO}/releases/download/${latestVersion}/${binaryName}`;

  log.write("  Downloading ...");

  // Download binary and fetch checksums in parallel
  const [dataResult, checksums] = await Promise.all([
    downloadFile(downloadUrl).catch((e: unknown) => e),
    fetchChecksums(latestVersion),
  ]);

  if (dataResult instanceof Error || !(dataResult instanceof Buffer)) {
    log.red(" failed");
    const msg = dataResult instanceof Error ? dataResult.message : String(dataResult);
    log.error(`  ${msg}`);
    process.exit(1);
  }

  const data: Buffer = dataResult;
  log.green(" done");
  if (checksums) {
    const expectedHash = checksums.get(binaryName);
    if (expectedHash) {
      if (!verifyChecksum(data, expectedHash)) {
        log.error("  Checksum verification failed — aborting update");
        process.exit(1);
      }
      log.success("  Checksum verified");
    } else {
      log.warn("  Warning: no checksum entry for this binary, skipping verification");
    }
  } else {
    log.warn("  Warning: checksums.txt unavailable, skipping verification");
  }

  // Replace binary
  const exePath = getExePath();
  const newPath = exePath + ".new";
  const oldPath = exePath + ".old";

  try {
    // Write new binary to .new
    writeFileSync(newPath, data);
    if (process.platform !== "win32") {
      chmodSync(newPath, 0o755);
    }

    if (process.platform === "win32") {
      // Windows: rename running exe → .old, then .new → exe
      renameSync(exePath, oldPath);
      renameSync(newPath, exePath);
      // .old will be cleaned up on next run
    } else {
      // Unix: overwrite directly (OS keeps old inode for running process)
      renameSync(newPath, exePath);
    }
  } catch (e: unknown) {
    // Attempt rollback with timeout to prevent indefinite blocking
    try {
      await withTimeout(
        new Promise<void>((resolve, reject) => {
          try {
            if (existsSync(oldPath) && !existsSync(exePath)) {
              renameSync(oldPath, exePath);
            }
            resolve();
          } catch (rollbackErr) {
            reject(rollbackErr);
          }
        }),
        5000,
        "Rollback"
      );
    } catch (rollbackErr: unknown) {
      log.debug(`Rollback failed: ${rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)}`);
    }
    log.error(`  Update failed: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }

  log.newline();
  log.success(`  Updated to ${latestVersion}`);
}

/**
 * Uninstall: remove the current binary.
 */
export async function selfUninstall(skipConfirm = false): Promise<void> {
  const exePath = getExePath();

  log.newline();
  log.yellow("  This will remove:");
  log.info(`    ${exePath}`);
  log.newline();

  if (!skipConfirm) {
    const { confirm } = await import("./prompt-io.js");
    const confirmed = await confirm({
      message: "Continue?",
      default: false,
    });
    if (!confirmed) {
      log.dim("  Cancelled.");
      return;
    }
  }

  try {
    if (process.platform === "win32") {
      // Windows: rename to .old, it will be orphaned after process exits
      // User can delete manually, or next install will overwrite
      const oldPath = exePath + ".old";
      renameSync(exePath, oldPath);
      // Schedule deletion via cmd after process exits
      const { execSync } = await import("child_process");
      execSync(`cmd /c "timeout /t 1 /nobreak >nul & del /f "${oldPath}""`, {
        stdio: "ignore",
        windowsHide: true,
      });
    } else {
      unlinkSync(exePath);
    }
  } catch (e: unknown) {
    const code = (e as { code?: string }).code ?? "";
    const message = e instanceof Error ? e.message : String(e);
    // Permission/access errors are critical and actionable
    if (code === "EPERM" || code === "EACCES") {
      log.error(`  Uninstall failed (permission denied): ${message}`);
      log.dim("  Try running with elevated permissions (sudo/admin)");
    } else {
      log.error(`  Uninstall failed: ${message}`);
    }
    log.debug(`selfUninstall error code=${code}: ${message}`);
    process.exit(1);
  }

  // Clean up .old if exists
  cleanupOldBinary();

  log.newline();
  log.success("  ccbox has been uninstalled");
}

/**
 * Show version info, optionally check for updates.
 */
export async function showVersion(check: boolean): Promise<void> {
  log.info(`  ccbox v${VERSION}`);

  if (check) {
    log.newline();
    log.dim("  Checking for updates...");

    const release = await fetchLatestRelease();
    if (!release) {
      log.warn("  Could not check (network error)");
      return;
    }

    const currentVersion = `v${VERSION}`;
    const latestVersion = release.tag_name;

    if (compareVersions(currentVersion, latestVersion) >= 0) {
      log.success("  Up to date");
    } else {
      log.yellow(`  Update available: ${currentVersion} -> ${latestVersion}`);
      log.dim("  Run 'ccbox update' to update");
    }
  }
}
