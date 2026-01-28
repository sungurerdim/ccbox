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
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { LanguageStack } from "./config.js";
import type { DepsInfo, DepsMode } from "./deps.js";
import { getInstallCommands } from "./deps.js";
import {
  FUSE_BINARY_AMD64,
  FUSE_BINARY_ARM64,
  FAKEPATH_BINARY_AMD64,
  FAKEPATH_BINARY_ARM64,
} from "./fuse-binaries.js";

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

// ES module equivalent of __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Generate entrypoint script with comprehensive debugging support. */
export function generateEntrypoint(): string {
  // Try to read from package resources first
  const scriptPath = join(__dirname, "scripts", "entrypoint.sh");
  try {
    if (existsSync(scriptPath)) {
      return readFileSync(scriptPath, "utf-8");
    }
  } catch {
    // Fall through to embedded version
  }

  // Fallback to embedded script
  return `#!/bin/bash

# Debug logging function (stdout for diagnostic, stderr for errors only)
_log() {
    if [[ -n "$CCBOX_DEBUG" ]]; then
        echo "[ccbox] $*"
    fi
}

_log_verbose() {
    if [[ "$CCBOX_DEBUG" == "2" ]]; then
        echo "[ccbox:debug] $*"
    fi
}

_die() {
    echo "[ccbox:ERROR] $*" >&2
    exit 1
}

# Error trap - show what failed
trap 'echo "[ccbox:ERROR] Command failed at line $LINENO: $BASH_COMMAND" >&2' ERR

set -e

_log "Entrypoint started (PID: $$)"
_log_verbose "Working directory: $PWD"
_log_verbose "Arguments: $*"

# Log current user info
_log "Running as UID: $(id -u), GID: $(id -g)"
_log_verbose "User: $(id -un 2>/dev/null || echo 'unknown')"

# ══════════════════════════════════════════════════════════════════════════════
# Dynamic User Setup
# Ensure container user matches host UID/GID for proper file ownership
# This allows all tools (npm, pip, git, etc.) to work seamlessly
# ══════════════════════════════════════════════════════════════════════════════
if [[ "$(id -u)" == "0" && -n "$CCBOX_UID" && -n "$CCBOX_GID" ]]; then
    _log_verbose "Setting up dynamic user (UID:$CCBOX_UID GID:$CCBOX_GID)"

    # Update ccbox group GID if different from 1000
    if [[ "$CCBOX_GID" != "1000" ]]; then
        # Check if target GID already exists
        if getent group "$CCBOX_GID" >/dev/null 2>&1; then
            _log_verbose "GID $CCBOX_GID already exists, removing"
            groupdel "$(getent group "$CCBOX_GID" | cut -d: -f1)" 2>/dev/null || true
        fi
        groupmod -g "$CCBOX_GID" ccbox 2>/dev/null || true
        _log_verbose "Changed ccbox group GID to $CCBOX_GID"
    fi

    # Update ccbox user UID if different from 1000
    if [[ "$CCBOX_UID" != "1000" ]]; then
        # Check if target UID already exists
        if getent passwd "$CCBOX_UID" >/dev/null 2>&1; then
            _log_verbose "UID $CCBOX_UID already exists, removing"
            userdel "$(getent passwd "$CCBOX_UID" | cut -d: -f1)" 2>/dev/null || true
        fi
        usermod -u "$CCBOX_UID" ccbox 2>/dev/null || true
        _log_verbose "Changed ccbox user UID to $CCBOX_UID"
    fi

    # Fix ownership of ccbox home directory and cache directories
    # Only fix directories that exist to avoid unnecessary operations
    for dir in /ccbox /ccbox/.cache /ccbox/.npm /ccbox/.local /ccbox/.config; do
        if [[ -d "$dir" ]]; then
            chown "$CCBOX_UID:$CCBOX_GID" "$dir" 2>/dev/null || true
        fi
    done

    # Create tmp directory in cache (for tools that need temp space)
    mkdir -p /ccbox/.cache/tmp 2>/dev/null || true
    chown "$CCBOX_UID:$CCBOX_GID" /ccbox/.cache/tmp 2>/dev/null || true

    # Fix .claude directory ownership (projects, sessions, etc. created by previous runs)
    # Uses CLAUDE_CONFIG_DIR env var for dynamic path resolution
    _claude_dir="\${CLAUDE_CONFIG_DIR:-/ccbox/.claude}"
    if [[ -d "$_claude_dir" ]]; then
        # Fix projects directory and subdirectories (session files)
        if [[ -d "$_claude_dir/projects" ]]; then
            find "$_claude_dir/projects" -user root -exec chown "$CCBOX_UID:$CCBOX_GID" {} + 2>/dev/null || true
        fi
        # Fix other runtime directories that Claude Code writes to
        for subdir in todos tasks plans statsig session-env debug; do
            if [[ -d "$_claude_dir/$subdir" ]]; then
                find "$_claude_dir/$subdir" -user root -exec chown "$CCBOX_UID:$CCBOX_GID" {} + 2>/dev/null || true
            fi
        done
    fi
fi

# ══════════════════════════════════════════════════════════════════════════════
# Onboarding state symlink
# Claude Code looks for ~/.claude.json at $HOME/.claude.json
# But host may store it inside .claude/ directory (at .claude/.claude.json)
# Create symlink so Claude finds it at expected location
# ══════════════════════════════════════════════════════════════════════════════
if [[ -f "/ccbox/.claude/.claude.json" && ! -e "/ccbox/.claude.json" ]]; then
    ln -sf /ccbox/.claude/.claude.json /ccbox/.claude.json 2>/dev/null || true
    _log "Linked onboarding state: /ccbox/.claude.json -> .claude/.claude.json"
fi

# ══════════════════════════════════════════════════════════════════════════════
# Cross-platform path compatibility via FUSE (in-place overlay)
# FUSE provides kernel-level path transformation that works with ALL apps
# including Bun/Zig which bypass glibc (and thus LD_PRELOAD)
#
# In-place overlay: FUSE mounts directly over existing directories without
# creating additional directories on host. Uses bind mount trick:
# 1. Bind mount original dir to temp location (container-only)
# 2. FUSE mounts from temp back to original path
# 3. Changes go through FUSE -> bind mount -> host (transparent)
# ══════════════════════════════════════════════════════════════════════════════

# Helper function for in-place FUSE overlay on a directory
_setup_fuse_overlay() {
    local mount_point="$1"
    local label="$2"

    if [[ ! -d "$mount_point" ]]; then
        _log_verbose "FUSE skip ($label): dir not found: $mount_point"
        return 1
    fi

    # Container-only bind mount source directory
    # Use /run (tmpfs, always available, not cleaned by tmp cleaners)
    # Bind mount doesn't copy data - just creates alternate path to same inode
    local safe_name
    safe_name=$(echo "$mount_point" | tr '/' '-' | sed 's/^-//')
    local fuse_base="/run/ccbox-fuse"
    mkdir -p "$fuse_base" 2>/dev/null || true
    local tmp_source="$fuse_base/$safe_name"
    mkdir -p "$tmp_source"

    # Bind mount original to temp (preserves bidirectional host connection)
    if ! mount --bind "$mount_point" "$tmp_source"; then
        _log "Warning: bind mount failed for $label"
        rmdir "$tmp_source" 2>/dev/null
        return 1
    fi

    # Build FUSE options
    # pathmap/dirmap passed via env vars (CCBOX_PATH_MAP, CCBOX_DIR_MAP) to avoid
    # FUSE -o comma parsing issues when paths contain commas
    local fuse_opts="source=$tmp_source,allow_other"
    [[ -n "$CCBOX_UID" ]] && fuse_opts="$fuse_opts,uid=$CCBOX_UID"
    [[ -n "$CCBOX_GID" ]] && fuse_opts="$fuse_opts,gid=$CCBOX_GID"

    _log_verbose "FUSE ($label): $tmp_source -> $mount_point (in-place overlay)"

    # Mount FUSE over original path (in-place overlay)
    nohup /usr/local/bin/ccbox-fuse -f -o "$fuse_opts" "$mount_point" </dev/null >/dev/null 2>&1 &
    local fuse_pid=$!

    # Poll for FUSE mount readiness instead of fixed sleep
    local waited=0
    while ! mountpoint -q "$mount_point" 2>/dev/null; do
        sleep 0.1
        waited=$((waited + 1))
        if [[ $waited -ge 50 ]]; then
            _log "FUSE mount timeout: $label"
            kill $fuse_pid 2>/dev/null || true
            umount "$tmp_source" 2>/dev/null || true
            rmdir "$tmp_source" 2>/dev/null
            return 1
        fi
    done

    # Verify mount
    if mountpoint -q "$mount_point" 2>/dev/null; then
        _log "FUSE mounted: $label (in-place)"
        return 0
    else
        _log "Warning: FUSE mount failed for $label"
        kill $fuse_pid 2>/dev/null || true
        umount "$tmp_source" 2>/dev/null || true
        rmdir "$tmp_source" 2>/dev/null
        return 1
    fi
}

if [[ -n "$CCBOX_PATH_MAP" && -x "/usr/local/bin/ccbox-fuse" ]]; then
    _log "Setting up FUSE for path translation (in-place overlay)..."

    # Mount global .claude with FUSE overlay
    if [[ -d "/ccbox/.claude" ]]; then
        if _setup_fuse_overlay "/ccbox/.claude" "global"; then
            export CCBOX_FUSE_GLOBAL=1
        fi
    fi

    # Mount project .claude with FUSE overlay (if exists)
    if [[ -d "$PWD/.claude" ]]; then
        if _setup_fuse_overlay "$PWD/.claude" "project"; then
            export CCBOX_FUSE_PROJECT=1
        fi
    fi

    _log "Path mapping: $CCBOX_PATH_MAP"

    # Clean orphaned plugin markers in global .claude
    if [[ -d "/ccbox/.claude/plugins/cache" ]]; then
        _orphan_count=$(find "/ccbox/.claude/plugins/cache" -name ".orphaned_at" -type f 2>/dev/null | wc -l)
        if [[ "$_orphan_count" -gt 0 ]]; then
            find "/ccbox/.claude/plugins/cache" -name ".orphaned_at" -type f -exec rm -f {} + 2>/dev/null || true
            _log "Cleaned $_orphan_count orphaned plugin marker(s)"
        fi
    fi
else
    # No path mapping needed or FUSE not available
    if [[ -d "$PWD/.claude" ]]; then
        _log "Project .claude detected (direct mount, no path transform)"
    fi
fi


# Git performance optimizations (I/O reduction)
# Use --system for settings that must apply to all users (root runs this, ccbox runs claude)
# Use --global for user-specific settings (will be inherited when gosu switches to ccbox)
# CRITICAL: Add wildcard safe.directory to allow any mounted path (quotes prevent shell expansion)
git config --system --add safe.directory "*" 2>/dev/null || true
git config --system core.fileMode false 2>/dev/null || true
# Also add current project directory explicitly (belt and suspenders)
git config --system --add safe.directory "$PWD" 2>/dev/null || true
git config --global core.preloadindex true 2>/dev/null || true
git config --global core.fscache true 2>/dev/null || true
git config --global core.untrackedcache true 2>/dev/null || true
git config --global core.commitgraph true 2>/dev/null || true
git config --global core.splitIndex true 2>/dev/null || true
git config --global fetch.writeCommitGraph true 2>/dev/null || true
git config --global gc.auto 0 2>/dev/null || true
git config --global credential.helper 'cache --timeout=86400' 2>/dev/null || true
git config --global pack.threads 0 2>/dev/null || true
git config --global index.threads 0 2>/dev/null || true

# Copy root's gitconfig to ccbox user so performance settings are inherited
if [[ -f /root/.gitconfig && -n "$CCBOX_UID" ]]; then
    cp /root/.gitconfig /ccbox/.gitconfig 2>/dev/null || true
    chown "$CCBOX_UID:$CCBOX_GID" /ccbox/.gitconfig 2>/dev/null || true
fi

# If project has .git, ensure it's recognized despite path/ownership differences
if [[ -d "$PWD/.git" ]]; then
    _log "Git repository detected at $PWD"
    # Add this specific directory as safe (belt and suspenders with --system '*')
    git config --global --add safe.directory "$PWD" 2>/dev/null || true
fi

# Create temp directory in cache (exec allowed, ephemeral tmpfs)
mkdir -p /ccbox/.cache/tmp 2>/dev/null || true
mkdir -p /ccbox/.cache/tmp/.gradle 2>/dev/null || true  # Gradle home
_log_verbose "TMPDIR: /ccbox/.cache/tmp"

# Verify claude command exists
if ! command -v claude &>/dev/null; then
    _die "claude command not found in PATH"
fi

_log_verbose "Claude location: $(which claude)"
_log_verbose "Claude version: $(claude --version 2>/dev/null || echo 'N/A')"

_log "Starting Claude Code..."

# Priority wrapper: nice (CPU) + ionice (I/O) for system responsiveness
# These are soft limits - only activate when competing for resources
# Skip if CCBOX_UNRESTRICTED is set (--unrestricted flag)
if [[ -z "$CCBOX_UNRESTRICTED" ]]; then
    PRIORITY_CMD="nice -n 10 ionice -c2 -n7"
    _log_verbose "Resource limits active (nice -n 10, ionice -c2 -n7)"
else
    PRIORITY_CMD=""
    _log_verbose "Unrestricted mode: no resource limits"
fi

# Build execution command with user switching if needed
EXEC_PREFIX=""
if [[ "$(id -u)" == "0" && -n "$CCBOX_UID" && -n "$CCBOX_GID" ]]; then
    # Running as root - switch to ccbox user via gosu
    # Use user name instead of UID:GID so HOME is properly set from /etc/passwd
    # ccbox user's UID/GID was dynamically updated above to match host
    _log_verbose "Switching to ccbox user (UID:$CCBOX_UID GID:$CCBOX_GID)"
    export HOME=/ccbox
    EXEC_PREFIX="gosu ccbox"
fi

# ══════════════════════════════════════════════════════════════════════════════
# Path Translation via LD_PRELOAD (fakepath.so) - DISABLED
# fakepath.so doesn't work with Bun (bypasses glibc via direct syscalls).
# Session compatibility is handled host-side via NTFS junctions (paths.ts).
# ══════════════════════════════════════════════════════════════════════════════
FAKEPATH_PRELOAD=""

# Run Claude Code
if [[ -t 1 ]]; then
    printf '\\e[?2026h' 2>/dev/null || true
    exec $EXEC_PREFIX env $FAKEPATH_PRELOAD $PRIORITY_CMD claude --dangerously-skip-permissions "$@"
else
    exec $EXEC_PREFIX env $FAKEPATH_PRELOAD stdbuf -oL -eL $PRIORITY_CMD claude --dangerously-skip-permissions "$@"
fi
`;
}



/**
 * Write Dockerfile and entrypoint to build directory.
 * Uses OS-agnostic path handling.
 * @param targetArch - Target architecture (amd64 or arm64). If not specified, uses host arch.
 */
export function writeBuildFiles(stack: LanguageStack, _targetArch?: string): string {
  // Use OS-agnostic temp directory
  const buildDir = join(tmpdir(), "ccbox", "build", stack);
  mkdirSync(buildDir, { recursive: true });

  // Write with explicit newline handling (Unix line endings for Dockerfile)
  const dockerfile = generateDockerfile(stack);
  const entrypoint = generateEntrypoint();

  writeFileSync(join(buildDir, "Dockerfile"), dockerfile, { encoding: "utf-8" });
  writeFileSync(join(buildDir, "entrypoint.sh"), entrypoint, { encoding: "utf-8", mode: 0o755 });

  // Write pre-compiled FUSE binary (no gcc needed - ~2GB savings)
  // Architecture is detected at build time via Docker's TARGETARCH
  // We write both binaries and let Docker select the right one
  const fuseBinaryAmd64 = Buffer.from(FUSE_BINARY_AMD64, "base64");
  const fuseBinaryArm64 = Buffer.from(FUSE_BINARY_ARM64, "base64");

  writeFileSync(join(buildDir, "ccbox-fuse-amd64"), fuseBinaryAmd64, { mode: 0o755 });
  writeFileSync(join(buildDir, "ccbox-fuse-arm64"), fuseBinaryArm64, { mode: 0o755 });

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

  // Also keep ccbox-fuse.c for source builds if needed
  const fuseSrc = join(__dirname, "..", "native", "ccbox-fuse.c");
  if (existsSync(fuseSrc)) {
    const fuseContent = readFileSync(fuseSrc, "utf-8");
    writeFileSync(join(buildDir, "ccbox-fuse.c"), fuseContent, { encoding: "utf-8" });
  }

  // Write pre-compiled fakepath.so binary (no gcc needed)
  // Architecture is detected at build time via Docker's TARGETARCH
  const fakepathBinaryAmd64 = Buffer.from(FAKEPATH_BINARY_AMD64, "base64");
  const fakepathBinaryArm64 = Buffer.from(FAKEPATH_BINARY_ARM64, "base64");

  writeFileSync(join(buildDir, "fakepath-amd64.so"), fakepathBinaryAmd64, { mode: 0o755 });
  writeFileSync(join(buildDir, "fakepath-arm64.so"), fakepathBinaryArm64, { mode: 0o755 });

  // Also keep fakepath.c for source builds if needed
  const fakepathSrc = join(__dirname, "..", "native", "fakepath.c");
  if (existsSync(fakepathSrc)) {
    const fakepathContent = readFileSync(fakepathSrc, "utf-8");
    writeFileSync(join(buildDir, "fakepath.c"), fakepathContent, { encoding: "utf-8" });
  }

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
    lines.push("# Install dependencies");
    for (const cmd of installCmds) {
      const pkgManager = cmd.split(" ")[0] ?? "package";
      lines.push(`RUN ${cmd} || echo 'Warning: ${pkgManager} install failed'`);
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
