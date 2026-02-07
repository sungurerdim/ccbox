/**
 * Docker file generation for ccbox.
 *
 * Main module that re-exports from specialized modules and provides
 * entrypoint generation, FUSE source, and build file utilities.
 *
 * Module structure:
 *   - dockerfile-gen.ts: Dockerfile templates for all stacks
 *   - docker-runtime.ts: Container execution and runtime utilities
 *   - generator.ts (this file): Build files, entrypoint, FUSE source
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { LanguageStack } from "./config.js";
import { getCcboxTempBuild } from "./constants.js";
import type { DepsInfo, DepsMode } from "./deps.js";
import { getInstallCommands } from "./deps.js";

// Embedded native binaries - Bun's compile embeds these into the executable.
// In dev mode (bun run), they resolve to filesystem paths; in compiled mode, to embedded paths.
// @ts-expect-error Bun embed import
import fuseAmd64Path from "../native/ccbox-fuse-linux-amd64" with { type: "file" };
// @ts-expect-error Bun embed import
import fuseArm64Path from "../native/ccbox-fuse-linux-arm64" with { type: "file" };
// @ts-expect-error Bun embed import
import fakepathAmd64Path from "../native/fakepath-linux-amd64.so" with { type: "file" };
// @ts-expect-error Bun embed import
import fakepathArm64Path from "../native/fakepath-linux-arm64.so" with { type: "file" };
// @ts-expect-error Bun embed import
import fuseSrcPath from "../native/ccbox-fuse.c" with { type: "file" };
// @ts-expect-error Bun embed import
import fakepathSrcPath from "../native/fakepath.c" with { type: "file" };
// @ts-expect-error Bun embed import
import entrypointShPath from "./templates/entrypoint.sh" with { type: "file" };

const EMBEDDED_NATIVES: Record<string, string> = {
  "ccbox-fuse-linux-amd64": fuseAmd64Path,
  "ccbox-fuse-linux-arm64": fuseArm64Path,
  "fakepath-linux-amd64.so": fakepathAmd64Path,
  "fakepath-linux-arm64.so": fakepathArm64Path,
  "ccbox-fuse.c": fuseSrcPath,
  "fakepath.c": fakepathSrcPath,
};

/** Get embedded path for a native file. */
function readNativePath(name: string): string {
  const embeddedPath = EMBEDDED_NATIVES[name];
  if (embeddedPath) { return embeddedPath; }
  throw new Error(
    `Native file not found: ${name}\nRun: cd native && docker buildx build --platform linux/amd64,linux/arm64 -f Dockerfile.build --output type=local,dest=. .`
  );
}

/** Read a pre-compiled native binary.
 *  Uses Bun's embedded file imports (works in both dev and compiled mode). */
function readNativeBinary(name: string): Buffer {
  return readFileSync(readNativePath(name));
}

// Import and re-export from dockerfile-gen.ts
import { generateDockerfile, DOCKERFILE_GENERATORS } from "./dockerfile-gen.js";
export { generateDockerfile, DOCKERFILE_GENERATORS };

// Re-export from docker-runtime.ts
export {
  buildClaudeArgs,
  buildContainerAwarenessPrompt,
  getDockerRunCmd,
  getHostTimezone,
  getHostUserIds,
  getTerminalSize,
  transformSlashCommand,
} from "./docker-runtime.js";

/** Generate entrypoint script with comprehensive debugging support.
 *  Template source: src/templates/entrypoint.sh */
export function generateEntrypoint(): string {
  return readFileSync(entrypointShPath, "utf-8");
}



/**
 * Write Dockerfile and entrypoint to build directory.
 * Uses OS-agnostic path handling.
 */
export function writeBuildFiles(stack: LanguageStack): string {
  // Use OS-agnostic temp directory
  const buildDir = getCcboxTempBuild(stack);
  mkdirSync(buildDir, { recursive: true });

  // Write with explicit newline handling (Unix line endings for Dockerfile)
  const dockerfile = generateDockerfile(stack);
  const entrypoint = generateEntrypoint();

  writeFileSync(join(buildDir, "Dockerfile"), dockerfile, { encoding: "utf-8" });
  writeFileSync(join(buildDir, "entrypoint.sh"), entrypoint, { encoding: "utf-8", mode: 0o755 });

  // Copy pre-compiled FUSE binaries from native/ directory
  // Architecture is detected at build time via Docker's TARGETARCH
  writeFileSync(join(buildDir, "ccbox-fuse-amd64"), readNativeBinary("ccbox-fuse-linux-amd64"), { mode: 0o755 });
  writeFileSync(join(buildDir, "ccbox-fuse-arm64"), readNativeBinary("ccbox-fuse-linux-arm64"), { mode: 0o755 });

  // Write architecture selector script
  // Docker will use TARGETARCH to copy the correct binary
  const archSelector = `#!/bin/sh
# Select correct binary based on architecture
ARCH=\${TARGETARCH:-amd64}
if [ "$ARCH" = "arm64" ]; then
  cp /tmp/ccbox-fuse-arm64 /usr/local/bin/ccbox-fuse
else
  cp /tmp/ccbox-fuse-amd64 /usr/local/bin/ccbox-fuse
fi
chmod 755 /usr/local/bin/ccbox-fuse
`;
  writeFileSync(join(buildDir, "install-fuse.sh"), archSelector, { encoding: "utf-8", mode: 0o755 });

  // Copy ccbox-fuse.c source for in-container source builds if needed
  writeFileSync(join(buildDir, "ccbox-fuse.c"), readFileSync(readNativePath("ccbox-fuse.c"), "utf-8"), { encoding: "utf-8" });

  // Copy pre-compiled fakepath.so binaries
  writeFileSync(join(buildDir, "fakepath-amd64.so"), readNativeBinary("fakepath-linux-amd64.so"), { mode: 0o755 });
  writeFileSync(join(buildDir, "fakepath-arm64.so"), readNativeBinary("fakepath-linux-arm64.so"), { mode: 0o755 });

  // Copy fakepath.c source for in-container source builds if needed
  writeFileSync(join(buildDir, "fakepath.c"), readFileSync(readNativePath("fakepath.c"), "utf-8"), { encoding: "utf-8" });

  return buildDir;
}

/**
 * Generate project-specific Dockerfile with dependencies.
 */
export function generateProjectDockerfile(
  baseImage: string,
  depsList: DepsInfo[],
  depsMode: DepsMode,
  projectPath: string
): string {
  const lines = [
    "# syntax=docker/dockerfile:1",
    "# Project-specific image with dependencies",
    `FROM ${baseImage}`,
    "",
    "USER root",
    "WORKDIR /tmp/deps",
    "",
  ];

  // Collect candidate dependency files
  const candidateFiles = new Set<string>();
  for (const deps of depsList) {
    for (const f of deps.files) {
      if (!f.includes("*")) {
        candidateFiles.add(f);
      }
    }
  }

  // Add common dependency files
  const commonFiles = [
    "pyproject.toml",
    "setup.py",
    "setup.cfg",
    "package.json",
    "package-lock.json",
    "yarn.lock",
    "pnpm-lock.yaml",
    "go.mod",
    "go.sum",
    "Cargo.toml",
    "Cargo.lock",
    "Gemfile",
    "Gemfile.lock",
    "composer.json",
    "composer.lock",
  ];
  commonFiles.forEach((f) => candidateFiles.add(f));

  // Filter to only files that actually exist
  const existingFiles = [...candidateFiles].filter((f) => existsSync(join(projectPath, f)));

  // Copy only existing dependency files
  if (existingFiles.length > 0) {
    lines.push("# Copy dependency files");
    for (const pattern of existingFiles.sort()) {
      lines.push(`COPY ${pattern} ./`);
    }
  }

  lines.push("");

  // Get install commands
  const installCmds = getInstallCommands(depsList, depsMode);

  if (installCmds.length > 0) {
    lines.push("# Install dependencies (skip if runtime not available in stack)");
    for (const cmd of installCmds) {
      // Extract the binary name from the command to check availability
      const binary = cmd.split(/[\s|&;>]/)[0]?.trim() ?? "";
      // Commands starting with a runtime binary get a "which" guard
      // so they gracefully skip when the stack doesn't include that runtime
      const needsGuard = ["python3", "pip", "poetry", "pdm", "uv", "conda", "pipenv",
        "npm", "npx", "yarn", "pnpm", "bun", "bunx", "deno",
        "go", "cargo", "dotnet", "nuget", "mix", "rebar3", "gleam",
        "stack", "cabal", "swift", "dart", "flutter", "julia",
        "lein", "clojure", "zig", "nimble", "opam", "cpanm",
        "conan", "vcpkg", "luarocks", "Rscript",
        "gem", "bundle", "bundler", "composer", "mvn", "gradle", "sbt"].includes(binary);
      if (needsGuard) {
        lines.push(`RUN which ${binary} >/dev/null 2>&1 && ${cmd} || echo "Skipping ${binary} (not in stack)"`);
      } else {
        lines.push(`RUN ${cmd}`);
      }
    }
  }

  lines.push(
    "",
    "# Return to project directory (entrypoint will handle user switching via gosu)",
    "WORKDIR /ccbox",
    ""
  );

  return lines.join("\n");
}
