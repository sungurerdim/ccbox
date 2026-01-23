#!/usr/bin/env bun
/**
 * Cross-platform binary build script for ccbox.
 *
 * Uses Bun's compile feature to create standalone executables.
 *
 * Usage:
 *   bun run scripts/build.ts           # Build for current platform
 *   bun run scripts/build.ts --all     # Build for all platforms
 *   bun run scripts/build.ts --target linux-x64
 */

import { $ } from "bun";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Supported targets for cross-compilation
const TARGETS = [
  "bun-linux-x64",
  "bun-linux-arm64",
  "bun-darwin-x64",
  "bun-darwin-arm64",
  "bun-windows-x64",
] as const;

type Target = (typeof TARGETS)[number];

// Output directory
const DIST_DIR = "dist";
const ENTRY_POINT = "src/cli.ts";

// Get version from package.json
function getVersion(): string {
  const pkg = JSON.parse(readFileSync("package.json", "utf-8"));
  return pkg.version;
}

// Get output filename for a target
function getOutputName(target: Target): string {
  const version = getVersion();
  const parts = target.replace("bun-", "").split("-");
  const os = parts[0];
  const arch = parts[1];
  const ext = os === "windows" ? ".exe" : "";
  return `ccbox-v${version}-${os}-${arch}${ext}`;
}

// Build for a specific target
async function buildForTarget(target: Target): Promise<void> {
  const outputName = getOutputName(target);
  const outputPath = join(DIST_DIR, outputName);

  console.log(`Building ${outputName}...`);

  try {
    await $`bun build ${ENTRY_POINT} --compile --target ${target} --outfile ${outputPath} --minify`.quiet();
    console.log(`  ✓ ${outputPath}`);
  } catch (error) {
    console.error(`  ✗ Failed to build ${target}`);
    throw error;
  }
}

// Build for current platform
async function buildForCurrentPlatform(): Promise<void> {
  const outputPath = join(DIST_DIR, "ccbox");

  console.log("Building for current platform...");

  try {
    await $`bun build ${ENTRY_POINT} --compile --outfile ${outputPath} --minify`.quiet();
    console.log(`  ✓ ${outputPath}`);
  } catch (error) {
    console.error("  ✗ Build failed");
    throw error;
  }
}

// Main function
async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // Ensure dist directory exists
  if (!existsSync(DIST_DIR)) {
    mkdirSync(DIST_DIR, { recursive: true });
  }

  // Parse arguments
  const buildAll = args.includes("--all");
  const targetArg = args.find((arg) => arg.startsWith("--target="));
  const specificTarget = targetArg?.split("=")[1] as Target | undefined;

  console.log(`ccbox v${getVersion()} - Binary Build\n`);

  if (buildAll) {
    // Build for all platforms
    console.log("Building for all platforms...\n");
    for (const target of TARGETS) {
      await buildForTarget(target);
    }
    console.log("\nAll builds complete!");
  } else if (specificTarget) {
    // Build for specific target
    if (!TARGETS.includes(specificTarget)) {
      console.error(`Unknown target: ${specificTarget}`);
      console.error(`Valid targets: ${TARGETS.join(", ")}`);
      process.exit(1);
    }
    await buildForTarget(specificTarget);
  } else {
    // Build for current platform
    await buildForCurrentPlatform();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
