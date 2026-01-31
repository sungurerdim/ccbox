/**
 * Self-update, uninstall, and version check for ccbox.
 *
 * Uses rename-based self-update pattern:
 * - Windows: rename running exe → .old, move new → exe, cleanup .old
 * - Linux/macOS: overwrite directly (OS allows replacing running binary)
 */

import { style } from "./logger.js";
import { createHash } from "crypto";
import { writeFileSync, renameSync, unlinkSync, chmodSync, existsSync } from "fs";
import { VERSION } from "./constants.js";

const REPO = "sungurerdim/ccbox";
const GITHUB_API_URL = `https://api.github.com/repos/${REPO}/releases/latest`;

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
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(GITHUB_API_URL, {
      headers: {
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "ccbox",
      },
      signal: controller.signal,
    });
    if (!response.ok) {return null;}
    return (await response.json()) as GitHubRelease;
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Compare semantic versions.
 * Returns: -1 if a < b, 0 if a === b, 1 if a > b
 */
function compareVersions(a: string, b: string): number {
  const cleanA = a.replace(/^v/, "");
  const cleanB = b.replace(/^v/, "");
  const partsA = cleanA.split(".").map(Number);
  const partsB = cleanB.split(".").map(Number);

  for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
    const numA = partsA[i] || 0;
    const numB = partsB[i] || 0;
    if (numA < numB) {return -1;}
    if (numA > numB) {return 1;}
  }
  return 0;
}

/**
 * Download a file and return its contents as a Buffer.
 */
async function downloadFile(url: string): Promise<Buffer> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": "ccbox" },
      redirect: "follow",
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Download failed: ${response.status} ${response.statusText}`);
    }
    return Buffer.from(await response.arrayBuffer());
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Fetch checksums.txt from a GitHub release and parse into a Map<filename, hash>.
 * Returns null if the file is unavailable (old release, network error).
 */
async function fetchChecksums(tagName: string): Promise<Map<string, string> | null> {
  const url = `https://github.com/${REPO}/releases/download/${tagName}/checksums.txt`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": "ccbox" },
      redirect: "follow",
      signal: controller.signal,
    });
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
  } finally {
    clearTimeout(timeoutId);
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
  } catch {
    // Ignore: might still be locked on Windows, will be cleaned next run
  }
}

/**
 * Self-update: download new binary and replace current executable.
 */
export async function selfUpdate(force: boolean): Promise<void> {
  // Clean up leftover from previous update
  cleanupOldBinary();

  const currentVersion = `v${VERSION}`;

  console.log(style.dim("  Checking for updates..."));
  console.log();

  const release = await fetchLatestRelease();
  if (!release) {
    console.log(style.red("  Failed to check (network error or rate limited)"));
    process.exit(1);
  }

  const latestVersion = release.tag_name;

  console.log(`  ${style.dim("Current")}  ${currentVersion}`);
  console.log(`  ${style.dim("Latest")}   ${latestVersion}`);

  if (!force && compareVersions(currentVersion, latestVersion) >= 0) {
    console.log();
    console.log(style.green("  Already up to date"));
    return;
  }

  // Confirm (force skips both version check and confirmation)
  if (!force) {
    console.log();
    const { confirm } = await import("./prompt-io.js");
    const confirmed = await confirm({
      message: `Update to ${latestVersion}?`,
      default: true,
    });
    if (!confirmed) {
      console.log(style.dim("  Cancelled."));
      return;
    }
  }

  // Download
  const platform = detectPlatform();
  const ext = process.platform === "win32" ? ".exe" : "";
  const binaryName = `ccbox-${latestVersion}-${platform}${ext}`;
  const downloadUrl = `https://github.com/${REPO}/releases/download/${latestVersion}/${binaryName}`;

  process.stdout.write("  Downloading ...");

  // Download binary and fetch checksums in parallel
  const [dataResult, checksums] = await Promise.all([
    downloadFile(downloadUrl).catch((e: unknown) => e),
    fetchChecksums(latestVersion),
  ]);

  if (dataResult instanceof Error || !(dataResult instanceof Buffer)) {
    console.log(style.red(" failed"));
    const msg = dataResult instanceof Error ? dataResult.message : String(dataResult);
    console.log(style.red(`  ${msg}`));
    process.exit(1);
  }

  const data: Buffer = dataResult;
  console.log(style.green(" done"));
  if (checksums) {
    const expectedHash = checksums.get(binaryName);
    if (expectedHash) {
      if (!verifyChecksum(data, expectedHash)) {
        console.log(style.red("  Checksum verification failed — aborting update"));
        process.exit(1);
      }
      console.log(style.green("  Checksum verified ✓"));
    } else {
      console.log(style.yellow("  Warning: no checksum entry for this binary, skipping verification"));
    }
  } else {
    console.log(style.yellow("  Warning: checksums.txt unavailable, skipping verification"));
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
    // Attempt rollback
    try {
      if (existsSync(oldPath) && !existsSync(exePath)) {
        renameSync(oldPath, exePath);
      }
    } catch {
      // Rollback failed
    }
    console.log(style.red(`  Update failed: ${e instanceof Error ? e.message : String(e)}`));
    process.exit(1);
  }

  console.log();
  console.log(style.green(`  Updated to ${latestVersion}`));
}

/**
 * Uninstall: remove the current binary.
 */
export async function selfUninstall(force: boolean): Promise<void> {
  const exePath = getExePath();

  console.log();
  console.log(style.yellow("  This will remove:"));
  console.log(`    ${exePath}`);
  console.log();

  if (!force) {
    const { confirm } = await import("./prompt-io.js");
    const confirmed = await confirm({
      message: "Continue?",
      default: false,
    });
    if (!confirmed) {
      console.log(style.dim("  Cancelled."));
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
    console.log(style.red(`  Uninstall failed: ${e instanceof Error ? e.message : String(e)}`));
    process.exit(1);
  }

  // Clean up .old if exists
  cleanupOldBinary();

  console.log();
  console.log(style.green("  ccbox has been uninstalled"));
}

/**
 * Show version info, optionally check for updates.
 */
export async function showVersion(check: boolean): Promise<void> {
  console.log(`  ccbox v${VERSION}`);

  if (check) {
    console.log();
    console.log(style.dim("  Checking for updates..."));

    const release = await fetchLatestRelease();
    if (!release) {
      console.log(style.yellow("  Could not check (network error)"));
      return;
    }

    const currentVersion = `v${VERSION}`;
    const latestVersion = release.tag_name;

    if (compareVersions(currentVersion, latestVersion) >= 0) {
      console.log(style.green("  Up to date"));
    } else {
      console.log(style.yellow(`  Update available: ${currentVersion} -> ${latestVersion}`));
      console.log(style.dim("  Run 'ccbox update' to update"));
    }
  }
}
