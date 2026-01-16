/**
 * Docker file generation for ccbox.
 *
 * Dependency direction:
 *   This module imports from: paths, config
 *   It may be imported by: cli.ts
 *   It should NOT import from: cli, docker
 */

import { existsSync, mkdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { env } from "node:process";
import { fileURLToPath } from "node:url";

// ES module equivalent of __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

import type { Config } from "./config.js";
import { getClaudeConfigDir, getContainerName, getImageName, LanguageStack } from "./config.js";
import { DEFAULT_PIDS_LIMIT } from "./constants.js";
import type { DepsInfo, DepsMode } from "./deps.js";
import { getInstallCommands } from "./deps.js";
import { resolveForDocker } from "./paths.js";

// Container constraints (SSOT - used for both docker run and prompt generation)
const CONTAINER_CONSTRAINTS = {
  tmpOptions: "noexec,nosuid",           // /tmp mount flags
  pidsLimit: DEFAULT_PIDS_LIMIT,         // from constants.ts
  capDrop: "ALL",                        // Linux capabilities
  ephemeralPaths: ["/tmp", "/var/tmp", "~/.npm", "~/.cache"],
} as const;

/** Generate container awareness prompt with current constraints. */
function buildContainerAwarenessPrompt(persistentPaths: string): string {
  const { pidsLimit, capDrop, ephemeralPaths } = CONTAINER_CONSTRAINTS;

  return `
You are running inside a ccbox Docker container with an isolated filesystem.

PERSISTENT directories (mounted from host, survive container exit):
  ${persistentPaths}

EPHEMERAL (DELETED on exit): ${ephemeralPaths.join(", ")}, and everything else

Container constraints:
- /tmp has noexec, but $TMPDIR points to ~/.cache/tmp (exec allowed)
- Process limit: ${pidsLimit} PIDs max (avoid excessive parallelism)
- Capabilities dropped: ${capDrop} (no Docker-in-docker)

Best practices:
- Run builds normally: npm install, pip install, go build, cargo build all work
- node_modules/, venv/, target/ persist in project directory
`.trim();
}

// Common system packages (minimal - matches original)
const COMMON_TOOLS = `
# Ensure node user exists (idempotent - node:lts-slim has it, others don't)
RUN id -u node &>/dev/null || useradd -m -s /bin/bash -u 1000 node

# System packages (minimal but complete)
RUN apt-get update && apt-get install -y --no-install-recommends \\
    git curl ca-certificates bash \\
    python3 python3-pip python3-venv python-is-python3 \\
    ripgrep jq procps openssh-client locales \\
    fd-find gh gosu \\
    gawk sed grep findutils coreutils less file unzip \\
    && rm -rf /var/lib/apt/lists/* \\
    && sed -i '/en_US.UTF-8/s/^# //g' /etc/locale.gen && locale-gen \\
    # Create fd symlink (Debian package installs as fdfind)
    && ln -s $(which fdfind) /usr/local/bin/fd \\
    # yq (not in apt, install from GitHub - auto-detect architecture)
    && YQ_ARCH=$(dpkg --print-architecture | sed 's/armhf/arm/;s/i386/386/') \\
    && curl -sL "https://github.com/mikefarah/yq/releases/latest/download/yq_linux_\${YQ_ARCH}" -o /usr/local/bin/yq \\
    && chmod +x /usr/local/bin/yq \\
    # git-delta (syntax-highlighted diffs for better code review)
    && DELTA_VER="0.18.2" \\
    && DELTA_ARCH=$(dpkg --print-architecture) \\
    && curl -sL "https://github.com/dandavison/delta/releases/download/\${DELTA_VER}/git-delta_\${DELTA_VER}_\${DELTA_ARCH}.deb" -o /tmp/delta.deb \\
    && dpkg -i /tmp/delta.deb && rm /tmp/delta.deb \\
    # Cleanup unnecessary files (~50MB savings)
    && rm -rf /usr/share/doc/* /usr/share/man/* /var/log/* \\
    && find /usr/share/locale -mindepth 1 -maxdepth 1 ! -name 'en*' -exec rm -rf {} +

# Locale and performance environment
ENV LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 \\
    # Node.js performance: disable npm funding/update checks, increase GC efficiency
    NODE_ENV=production \\
    NPM_CONFIG_FUND=false \\
    NPM_CONFIG_UPDATE_NOTIFIER=false \\
    # Git performance: disable advice messages, use parallel index
    GIT_ADVICE=0 \\
    GIT_INDEX_THREADS=0
`;

// Node.js installation snippet for non-node base images
const NODE_INSTALL = `
# Node.js (current)
RUN curl -fsSL https://deb.nodesource.com/setup_current.x | bash - \\
    && apt-get install -y --no-install-recommends nodejs \\
    && rm -rf /var/lib/apt/lists/*
`;

// Python dev tools (without CCO)
const PYTHON_TOOLS_BASE = `
# uv (ultra-fast Python package manager - 10-100x faster than pip)
RUN curl -LsSf https://astral.sh/uv/install.sh | sh
ENV PATH="/root/.local/bin:$PATH"

# Python dev tools (ruff, mypy, pytest) - installed as isolated tools
# Using 'uv tool' avoids PEP 668 externally-managed-environment errors
# Pre-compile bytecode at build time for faster startup
RUN uv tool install ruff && uv tool install mypy && uv tool install pytest \\
    && python -m compileall -q /root/.local/lib/python*/site-packages 2>/dev/null || true

# Disable runtime bytecode generation (SSD wear reduction)
# Pre-compiled .pyc files from build are still used
ENV PATH="/root/.local/bin:$PATH" PYTHONDONTWRITEBYTECODE=1
`;

// Claude Code + Node.js dev tools
const NODE_TOOLS_BASE = `
# Node.js dev tools (typescript, eslint, vitest) + Claude Code - latest versions
RUN npm config set fund false \\
    && npm config set update-notifier false \\
    && npm config set progress false \\
    && npm config set audit false \\
    && npm config set loglevel warn \\
    && npm config set fetch-retries 5 \\
    && npm config set fetch-retry-mintimeout 20000 \\
    && npm config set prefer-offline true \\
    && npm install -g typescript eslint vitest @anthropic-ai/claude-code --force \\
    && npm cache clean --force
`;


// Entrypoint setup
const ENTRYPOINT_SETUP = `
WORKDIR /home/node/project

COPY --chmod=755 entrypoint.sh /usr/local/bin/entrypoint.sh

ENV HOME=/home/node

# Start as root - entrypoint will switch to host user's UID/GID
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
`;

// Dockerfile generators for each stack
function minimalDockerfile(): string {
  return `# syntax=docker/dockerfile:1
# ccbox/minimal - Node.js + Claude Code (no Python dev tools)
FROM node:lts-slim

LABEL org.opencontainers.image.title="ccbox/minimal"

# Timezone passthrough from host
ARG TZ=UTC
ENV TZ="\${TZ}"

ENV DEBIAN_FRONTEND=noninteractive
${COMMON_TOOLS}
${NODE_TOOLS_BASE}
${ENTRYPOINT_SETUP}
`;
}

function baseDockerfile(): string {
  // base is now same as minimal (CCO installation requires manual setup)
  return `# syntax=docker/dockerfile:1
# ccbox/base - default stack (alias for minimal)
FROM ccbox/minimal

LABEL org.opencontainers.image.title="ccbox/base"
`;
}

function pythonDockerfile(): string {
  return `# syntax=docker/dockerfile:1
# ccbox/python - Python dev tools (ruff, mypy, pytest, uv)
FROM ccbox/base

LABEL org.opencontainers.image.title="ccbox/python"
${PYTHON_TOOLS_BASE}
`;
}

function goDockerfile(): string {
  return `# syntax=docker/dockerfile:1
# ccbox/go - Go + Node.js + golangci-lint
FROM golang:latest

LABEL org.opencontainers.image.title="ccbox/go"

# Timezone passthrough from host
ARG TZ=UTC
ENV TZ="\${TZ}"

ENV DEBIAN_FRONTEND=noninteractive
${NODE_INSTALL}${COMMON_TOOLS}
${NODE_TOOLS_BASE}
# golangci-lint (latest)
RUN curl -sSfL https://raw.githubusercontent.com/golangci/golangci-lint/master/install.sh | sh -s -- -b /usr/local/bin
${ENTRYPOINT_SETUP}
`;
}

function rustDockerfile(): string {
  return `# syntax=docker/dockerfile:1
# ccbox/rust - Rust + Node.js + clippy + rustfmt
FROM rust:latest

LABEL org.opencontainers.image.title="ccbox/rust"

# Timezone passthrough from host
ARG TZ=UTC
ENV TZ="\${TZ}"

ENV DEBIAN_FRONTEND=noninteractive
${NODE_INSTALL}${COMMON_TOOLS}
${NODE_TOOLS_BASE}
# Rust tools (clippy + rustfmt)
RUN rustup component add clippy rustfmt
${ENTRYPOINT_SETUP}
`;
}

function javaDockerfile(): string {
  return `# syntax=docker/dockerfile:1
# ccbox/java - Java (Temurin LTS) + Node.js + Maven
FROM eclipse-temurin:latest

LABEL org.opencontainers.image.title="ccbox/java"

# Timezone passthrough from host
ARG TZ=UTC
ENV TZ="\${TZ}"

ENV DEBIAN_FRONTEND=noninteractive
${NODE_INSTALL}${COMMON_TOOLS}
${NODE_TOOLS_BASE}
# Maven (latest from Apache)
RUN set -eux; \\
    MVN_VER=$(curl -sfL https://api.github.com/repos/apache/maven/releases/latest | jq -r .tag_name | sed 's/maven-//'); \\
    curl -sfL "https://archive.apache.org/dist/maven/maven-3/\${MVN_VER}/binaries/apache-maven-\${MVN_VER}-bin.tar.gz" | tar -xz -C /opt; \\
    ln -s /opt/apache-maven-\${MVN_VER}/bin/mvn /usr/local/bin/mvn
${ENTRYPOINT_SETUP}
`;
}

function webDockerfile(): string {
  return `# syntax=docker/dockerfile:1
# ccbox/web - Node.js + pnpm (fullstack)
FROM ccbox/base

LABEL org.opencontainers.image.title="ccbox/web"

# pnpm (latest)
RUN npm install -g pnpm --force && npm cache clean --force
`;
}

function fullDockerfile(): string {
  return `# syntax=docker/dockerfile:1
# ccbox/full - All languages (Go + Rust + Java + pnpm)
# Layered on ccbox/base for efficient caching
FROM ccbox/base

LABEL org.opencontainers.image.title="ccbox/full"

USER root

# Go (latest) + golangci-lint - auto-detect architecture
RUN set -eux; \\
    GO_ARCH=$(dpkg --print-architecture); \\
    GO_VER=$(curl -fsSL https://go.dev/VERSION?m=text | head -1); \\
    curl -fsSL "https://go.dev/dl/\${GO_VER}.linux-\${GO_ARCH}.tar.gz" | tar -C /usr/local -xzf -; \\
    curl -sSfL https://raw.githubusercontent.com/golangci/golangci-lint/master/install.sh | sh -s -- -b /usr/local/bin
ENV PATH=$PATH:/usr/local/go/bin GOPATH=/home/node/go
ENV PATH=$PATH:$GOPATH/bin

# Rust (latest) + clippy + rustfmt - install for node user
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y \\
    && /root/.cargo/bin/rustup component add clippy rustfmt
ENV PATH="/root/.cargo/bin:$PATH"

# Java (Temurin LTS) + Maven - auto-detect architecture
RUN set -eux; \\
    JAVA_ARCH=$(dpkg --print-architecture | sed 's/amd64/x64/;s/arm64/aarch64/'); \\
    TEMURIN_VER=$(curl -sfL "https://api.adoptium.net/v3/info/available_releases" | jq -r '.most_recent_lts'); \\
    curl -sfL "https://api.adoptium.net/v3/binary/latest/\${TEMURIN_VER}/ga/linux/\${JAVA_ARCH}/jdk/hotspot/normal/eclipse" -o /tmp/jdk.tar.gz; \\
    mkdir -p /usr/lib/jvm && tar -xzf /tmp/jdk.tar.gz -C /usr/lib/jvm; \\
    ln -s /usr/lib/jvm/jdk-* /usr/lib/jvm/temurin; \\
    MVN_VER=$(curl -sfL https://api.github.com/repos/apache/maven/releases/latest | jq -r .tag_name | sed 's/maven-//'); \\
    curl -sfL "https://archive.apache.org/dist/maven/maven-3/\${MVN_VER}/binaries/apache-maven-\${MVN_VER}-bin.tar.gz" | tar -xz -C /opt; \\
    ln -s /opt/apache-maven-\${MVN_VER}/bin/mvn /usr/local/bin/mvn; \\
    rm -f /tmp/jdk.tar.gz
ENV JAVA_HOME=/usr/lib/jvm/temurin PATH=$JAVA_HOME/bin:$PATH

# pnpm (latest)
RUN npm install -g pnpm --force && npm cache clean --force

USER node
`;
}

// Stack to Dockerfile generator mapping
const DOCKERFILE_GENERATORS: Record<LanguageStack, () => string> = {
  [LanguageStack.MINIMAL]: minimalDockerfile,
  [LanguageStack.BASE]: baseDockerfile,
  [LanguageStack.PYTHON]: pythonDockerfile,
  [LanguageStack.GO]: goDockerfile,
  [LanguageStack.RUST]: rustDockerfile,
  [LanguageStack.JAVA]: javaDockerfile,
  [LanguageStack.WEB]: webDockerfile,
  [LanguageStack.FULL]: fullDockerfile,
};

/** Generate Dockerfile content for the given stack. */
export function generateDockerfile(stack: LanguageStack): string {
  const generator = DOCKERFILE_GENERATORS[stack];
  return generator ? generator() : minimalDockerfile();
}

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

# Warn if running as root (legacy/misconfigured setup)
if [[ "$(id -u)" == "0" ]]; then
    echo "[ccbox:WARN] Running as root is not recommended." >&2
    echo "[ccbox:WARN] Container should be started with --user flag for security." >&2
    echo "[ccbox:WARN] Continuing anyway, but file ownership may be incorrect." >&2
fi

# CCO plugin installation (skip for bare mode and minimal stack)
if [[ -n "$CCBOX_BARE_MODE" ]]; then
    _log "Bare mode: vanilla Claude Code (no CCO)"
elif [[ "$CCBOX_STACK" == "minimal" ]]; then
    _log "Minimal stack: vanilla Claude Code (no CCO)"
else
    # Install/update CCO plugin (ensures latest commit each session)
    # Note: Container should be started with --user flag (ccbox CLI does this)
    _log "Installing CCO plugin..."

    # Step 1: Uninstall existing plugin (only if installed)
    if claude plugin list 2>/dev/null | grep -q "cco@ClaudeCodeOptimizer"; then
        _log "Removing existing CCO plugin..."
        claude plugin uninstall cco@ClaudeCodeOptimizer >/dev/null 2>&1 || true
    fi

    # Step 2: Remove marketplace (only if present)
    if claude plugin marketplace list 2>/dev/null | grep -q "ClaudeCodeOptimizer"; then
        _log "Removing existing marketplace..."
        claude plugin marketplace remove ClaudeCodeOptimizer >/dev/null 2>&1 || true
    fi

    # Step 3: Add marketplace repo with full URL
    _log "Adding CCO marketplace..."
    if ! claude plugin marketplace add https://github.com/sungurerdim/ClaudeCodeOptimizer >/dev/null 2>&1; then
        _log_verbose "Marketplace already exists or add failed, continuing..."
    fi

    # Step 4: Install plugin
    _log "Installing CCO plugin..."
    if claude plugin install cco@ClaudeCodeOptimizer >/dev/null 2>&1; then
        _log "CCO plugin ready"
    else
        echo "[ccbox:WARN] CCO plugin installation failed" >&2
    fi

    # Step 5: Fix plugin paths for host compatibility
    # Replace container paths (/home/node/.claude/) with portable paths (~/.claude/)
    # This ensures plugins work on both container and host
    PLUGIN_DIR="/home/node/.claude/plugins"
    if [[ -d "$PLUGIN_DIR" ]]; then
        for json_file in "$PLUGIN_DIR"/*.json; do
            [[ -f "$json_file" ]] || continue
            if grep -q '/home/node/.claude/' "$json_file" 2>/dev/null; then
                sed -i 's|/home/node/.claude/|~/.claude/|g' "$json_file"
                _log_verbose "Fixed paths in $(basename "$json_file")"
            fi
        done
        _log "Plugin paths fixed for host compatibility"
    fi
fi

# Project .claude is mounted directly from host (persistent)
# Claude Code automatically reads project .claude first, then global
if [[ -d "$PWD/.claude" ]]; then
    _log "Project .claude detected (persistent, host-mounted)"
    _log_verbose "Project .claude contents: $(ls -A "$PWD/.claude" 2>/dev/null | tr '\\n' ' ')"
fi

# Runtime config (as node user) - append to existing NODE_OPTIONS (preserves flags from docker run)
# --max-old-space-size: dynamic heap limit (3/4 of available RAM)
# --max-semi-space-size: larger young generation reduces GC pauses for smoother output
export NODE_OPTIONS="\${NODE_OPTIONS:-} --max-old-space-size=$(( $(free -m | awk '/^Mem:/{print $2}') * 3 / 4 )) --max-semi-space-size=64"
export UV_THREADPOOL_SIZE=$(nproc)

# Create Node.js compile cache directory (40% faster subsequent startups)
mkdir -p /home/node/.cache/node-compile 2>/dev/null || true
_log_verbose "NODE_OPTIONS: $NODE_OPTIONS"
_log_verbose "UV_THREADPOOL_SIZE: $UV_THREADPOOL_SIZE"

# Git performance optimizations
git config --global core.fileMode false 2>/dev/null || true
git config --global --add safe.directory '*' 2>/dev/null || true
git config --global core.preloadindex true 2>/dev/null || true
git config --global core.fscache true 2>/dev/null || true
git config --global core.untrackedcache true 2>/dev/null || true
git config --global core.commitgraph true 2>/dev/null || true
git config --global fetch.writeCommitGraph true 2>/dev/null || true
git config --global gc.auto 0 2>/dev/null || true
git config --global credential.helper 'cache --timeout=86400' 2>/dev/null || true

# Create temp directory in cache (exec allowed, ephemeral tmpfs)
mkdir -p /home/node/.cache/tmp 2>/dev/null || true
mkdir -p /home/node/.cache/tmp/.gradle 2>/dev/null || true  # Gradle home
_log_verbose "TMPDIR: /home/node/.cache/tmp"

# Verify claude command exists
if ! command -v claude &>/dev/null; then
    _die "claude command not found in PATH"
fi

_log_verbose "Claude location: $(which claude)"
_log_verbose "Node version: $(node --version 2>/dev/null || echo 'N/A')"
_log_verbose "npm version: $(npm --version 2>/dev/null || echo 'N/A')"

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

# Run Claude Code
if [[ -t 1 ]]; then
    printf '\\e[?2026h' 2>/dev/null || true
    exec $PRIORITY_CMD claude --dangerously-skip-permissions "$@"
else
    exec stdbuf -oL -eL $PRIORITY_CMD claude --dangerously-skip-permissions "$@"
fi
`;
}

/**
 * Write Dockerfile and entrypoint to build directory.
 * Uses OS-agnostic path handling.
 */
export function writeBuildFiles(stack: LanguageStack): string {
  // Use OS-agnostic temp directory
  const buildDir = join(tmpdir(), "ccbox", "build", stack);
  mkdirSync(buildDir, { recursive: true });

  // Write with explicit newline handling (Unix line endings for Dockerfile)
  const dockerfile = generateDockerfile(stack);
  const entrypoint = generateEntrypoint();

  writeFileSync(join(buildDir, "Dockerfile"), dockerfile, { encoding: "utf-8" });
  writeFileSync(join(buildDir, "entrypoint.sh"), entrypoint, { encoding: "utf-8", mode: 0o755 });

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
    "# Clean up and switch back to node user",
    "WORKDIR /home/node/project",
    "USER node",
    ""
  );

  return lines.join("\n");
}

/**
 * Transform slash command to file reference for --print mode compatibility.
 */
export function transformSlashCommand(prompt: string | undefined): string | undefined {
  if (!prompt || !prompt.startsWith("/")) {
    return prompt;
  }

  // Parse: "/cco-config --auto" -> cmd="cco-config", args="--auto"
  const parts = prompt.split(/\s+/, 2);
  const cmdName = parts[0]!.slice(1); // Remove leading "/"
  const cmdArgs = parts[1] ?? "";

  // Skip built-in commands (they work in --print mode)
  const builtinCommands = new Set([
    "compact",
    "context",
    "cost",
    "init",
    "help",
    "clear",
    "pr-comments",
    "release-notes",
    "review",
    "security-review",
    "memory",
    "mcp",
    "permissions",
    "config",
    "vim",
  ]);

  if (builtinCommands.has(cmdName)) {
    return prompt;
  }

  // Transform custom command to file reference
  const cmdPath = `/home/node/.claude/commands/${cmdName}.md`;
  let instruction = `Read the custom command file at ${cmdPath} and execute its instructions.`;
  if (cmdArgs) {
    instruction += ` Arguments: ${cmdArgs}`;
  }

  return instruction;
}

/**
 * Get host UID and GID for --user flag (cross-platform).
 */
export function getHostUserIds(): [number, number] {
  if (platform() === "win32") {
    // Windows: Use node user's UID/GID (1000:1000 in Docker images)
    return [1000, 1000];
  }

  // Linux/macOS: Use actual host UID/GID
  return [process.getuid?.() ?? 1000, process.getgid?.() ?? 1000];
}

/**
 * Get host timezone in IANA format (cross-platform).
 */
export function getHostTimezone(): string {
  // 1. Check TZ environment variable
  const tzEnv = env.TZ;
  if (tzEnv && tzEnv.includes("/")) {
    return tzEnv;
  }

  // 2. Try /etc/timezone (Debian/Ubuntu) - Linux only
  if (platform() !== "win32") {
    try {
      const tzFile = "/etc/timezone";
      if (existsSync(tzFile)) {
        const tz = readFileSync(tzFile, "utf-8").trim();
        if (tz && tz.includes("/")) {
          return tz;
        }
      }
    } catch {
      // Ignore
    }

    // 3. Try /etc/localtime symlink (Linux/macOS)
    try {
      const localtime = "/etc/localtime";
      const target = readlinkSync(localtime);
      if (target.includes("zoneinfo/")) {
        const tz = target.split("zoneinfo/")[1];
        if (tz && tz.includes("/")) {
          return tz;
        }
      }
    } catch {
      // Ignore
    }
  }

  // 4. Fallback to UTC
  return "UTC";
}

/**
 * Get terminal size (cross-platform).
 */
export function getTerminalSize(): { columns: number; lines: number } {
  // Use process.stdout if available, otherwise fallback
  const columns = process.stdout.columns ?? 120;
  const lines = process.stdout.rows ?? 40;
  return { columns, lines };
}

/** Build Claude CLI arguments list. */
export function buildClaudeArgs(options: {
  model?: string;
  debug?: number;
  prompt?: string;
  quiet?: boolean;
  appendSystemPrompt?: string;
  persistentPaths?: string;
}): string[] {
  const args: string[] = ["--dangerously-skip-permissions"];

  if (options.model) {
    args.push("--model", options.model);
  }

  const stream = (options.debug ?? 0) >= 2;
  const verbose = stream || (Boolean(options.prompt) && !options.quiet);

  if (verbose) {
    args.push("--verbose");
  }

  // Build system prompt: always include container awareness, optionally append user's prompt
  const containerPrompt = buildContainerAwarenessPrompt(
    options.persistentPaths ?? "/home/node/project, /home/node/.claude"
  );
  const systemPrompt = options.appendSystemPrompt
    ? `${containerPrompt}\n\n${options.appendSystemPrompt}`
    : containerPrompt;
  args.push("--append-system-prompt", systemPrompt);

  if (options.quiet || options.prompt) {
    args.push("--print");
    if (stream) {
      args.push("--output-format", "stream-json");
    }
  }

  if (options.prompt) {
    args.push(options.prompt);
  }

  return args;
}

/**
 * Generate docker run command with full cleanup on exit.
 * Handles cross-platform path conversion and environment setup.
 */
export function getDockerRunCmd(
  config: Config,
  projectPath: string,
  projectName: string,
  stack: LanguageStack,
  options: {
    bare?: boolean;
    debugLogs?: boolean;
    debug?: number;
    prompt?: string;
    model?: string;
    quiet?: boolean;
    appendSystemPrompt?: string;
    projectImage?: string;
    depsList?: DepsInfo[];
    unrestricted?: boolean;
  } = {}
): string[] {
  const imageName = options.projectImage ?? getImageName(stack);
  const claudeConfig = getClaudeConfigDir(config);
  const prompt = transformSlashCommand(options.prompt);
  const containerName = getContainerName(projectName);
  const dirName = basename(projectPath);
  const dockerProjectPath = resolveForDocker(resolve(projectPath));

  const cmd = ["docker", "run", "--rm"];

  // TTY allocation logic (cross-platform)
  const isInteractive = !prompt && !options.quiet;
  const isTTY = process.stdin.isTTY ?? false;

  if (isInteractive && isTTY) {
    cmd.push("-it");
  } else {
    cmd.push("-i");
  }

  cmd.push("--name", containerName);
  cmd.push("-v", `${dockerProjectPath}:/home/node/${dirName}:rw`);

  const dockerClaudeConfig = resolveForDocker(claudeConfig);

  if (options.bare) {
    addBareModeMounts(cmd, claudeConfig);
  } else {
    cmd.push("-v", `${dockerClaudeConfig}:/home/node/.claude:rw`);
  }

  // Mount ~/.claude.json for MCP config, OAuth tokens, and plugin data
  // Create if not exists so plugin installations persist to host
  const claudeJsonPath = join(dirname(claudeConfig), ".claude.json");
  if (!existsSync(claudeJsonPath)) {
    writeFileSync(claudeJsonPath, "{}", { encoding: "utf-8" });
  }
  const dockerClaudeJson = resolveForDocker(claudeJsonPath);
  cmd.push("-v", `${dockerClaudeJson}:/home/node/.claude.json:rw`);

  // Add container configuration
  addTmpfsMounts(cmd, dirName);
  addUserMapping(cmd);
  addSecurityOptions(cmd);
  addDnsOptions(cmd);
  addBuildEnv(cmd);

  // Resource limits
  if (!options.unrestricted) {
    cmd.push("--cpu-shares=512");
  }

  // Environment variables
  addTerminalEnv(cmd);
  addClaudeEnv(cmd);

  if ((options.debug ?? 0) > 0) {
    cmd.push("-e", `CCBOX_DEBUG=${options.debug}`);
  }

  if (options.unrestricted) {
    cmd.push("-e", "CCBOX_UNRESTRICTED=1");
  }

  if (!options.debugLogs) {
    cmd.push("--tmpfs", "/home/node/.claude/debug:rw,size=512m,mode=0777");
  }

  // Compute persistent paths for container awareness
  const persistentPaths = options.bare
    ? `/home/node/${dirName}`  // bare mode: only project dir is persistent
    : `/home/node/${dirName}, /home/node/.claude`;
  cmd.push("-e", `CCBOX_PERSISTENT_PATHS=${persistentPaths}`);

  // Pass stack info for CCO installation decision
  cmd.push("-e", `CCBOX_STACK=${stack}`);

  addGitEnv(cmd, config);

  cmd.push(imageName);

  // Claude CLI arguments
  const claudeArgs = buildClaudeArgs({
    model: options.model,
    debug: options.debug,
    prompt,
    quiet: options.quiet,
    appendSystemPrompt: options.appendSystemPrompt,
    persistentPaths,
  });
  cmd.push(...claudeArgs);

  return cmd;
}

// Helper functions for docker run command building

function addBareModeMounts(cmd: string[], claudeConfig: string): void {
  const [uid, gid] = getHostUserIds();

  // Base tmpfs mount
  cmd.push("--tmpfs", `/home/node/.claude:rw,size=64m,uid=${uid},gid=${gid},mode=0755`);

  // Mount credential files INTO the tmpfs
  const credentialFiles = [".credentials.json", ".claude.json", "settings.json"];
  for (const f of credentialFiles) {
    const hostFile = join(claudeConfig, f);
    if (existsSync(hostFile)) {
      const dockerPath = resolveForDocker(hostFile);
      cmd.push("-v", `${dockerPath}:/home/node/.claude/${f}:rw`);
    }
  }

  // tmpfs for customization directories
  const userDirs = ["rules", "commands", "agents", "skills"];
  for (const d of userDirs) {
    cmd.push("--tmpfs", `/home/node/.claude/${d}:rw,size=16m,uid=${uid},gid=${gid},mode=0755`);
  }

  // Hide host's CLAUDE.md
  cmd.push("-v", "/dev/null:/home/node/.claude/CLAUDE.md:ro");

  // Signal bare mode
  cmd.push("-e", "CCBOX_BARE_MODE=1");
}

function addGitEnv(cmd: string[], config: Config): void {
  if (config.gitName) {
    cmd.push("-e", `GIT_AUTHOR_NAME=${config.gitName}`);
    cmd.push("-e", `GIT_COMMITTER_NAME=${config.gitName}`);
  }
  if (config.gitEmail) {
    cmd.push("-e", `GIT_AUTHOR_EMAIL=${config.gitEmail}`);
    cmd.push("-e", `GIT_COMMITTER_EMAIL=${config.gitEmail}`);
  }
}

function addTerminalEnv(cmd: string[]): void {
  const term = env.TERM ?? "xterm-256color";
  const colorterm = env.COLORTERM ?? "truecolor";
  cmd.push("-e", `TERM=${term}`);
  cmd.push("-e", `COLORTERM=${colorterm}`);

  const size = getTerminalSize();
  cmd.push("-e", `COLUMNS=${size.columns}`);
  cmd.push("-e", `LINES=${size.lines}`);

  // Passthrough terminal-specific variables
  const passthroughVars = [
    "TERM_PROGRAM",
    "TERM_PROGRAM_VERSION",
    "ITERM_SESSION_ID",
    "ITERM_PROFILE",
    "KITTY_WINDOW_ID",
    "KITTY_PID",
    "WEZTERM_PANE",
    "WEZTERM_UNIX_SOCKET",
    "GHOSTTY_RESOURCES_DIR",
    "ALACRITTY_SOCKET",
    "ALACRITTY_LOG",
    "VSCODE_GIT_IPC_HANDLE",
    "VSCODE_INJECTION",
    "WT_SESSION",
    "WT_PROFILE_ID",
    "KONSOLE_VERSION",
    "KONSOLE_DBUS_SESSION",
    "TMUX",
    "TMUX_PANE",
    "STY",
  ];

  for (const varName of passthroughVars) {
    const value = env[varName];
    if (value) {
      cmd.push("-e", `${varName}=${value}`);
    }
  }
}

function addUserMapping(cmd: string[]): void {
  const [uid, gid] = getHostUserIds();
  cmd.push("--user", `${uid}:${gid}`);
}

function addSecurityOptions(cmd: string[]): void {
  const { capDrop, pidsLimit } = CONTAINER_CONSTRAINTS;
  cmd.push(
    `--cap-drop=${capDrop}`,
    "--security-opt=no-new-privileges",
    `--pids-limit=${pidsLimit}`,
    "--init",
    "--shm-size=256m",
    "--ulimit",
    "nofile=65535:65535",
    "--memory-swappiness=0"
  );
}

function addTmpfsMounts(cmd: string[], dirName: string): void {
  const [uid, gid] = getHostUserIds();
  const { tmpOptions } = CONTAINER_CONSTRAINTS;
  cmd.push(
    "-w",
    `/home/node/${dirName}`,
    "--tmpfs",
    `/tmp:rw,${tmpOptions},size=512m`,
    "--tmpfs",
    `/var/tmp:rw,${tmpOptions},size=256m`,
    "--tmpfs",
    `/home/node/.npm:rw,size=256m,uid=${uid},gid=${gid},mode=0755`,
    "--tmpfs",
    `/home/node/.cache:rw,size=512m,uid=${uid},gid=${gid},mode=0755`
  );
}

function addDnsOptions(cmd: string[]): void {
  cmd.push("--dns-opt", "ndots:1", "--dns-opt", "timeout:1", "--dns-opt", "attempts:1");
}

function addBuildEnv(cmd: string[]): void {
  // Use in-container tmpfs for temp files (exec allowed, no cross-device issues)
  // /home/node/.cache is mounted as tmpfs without noexec
  const tmpPath = "/home/node/.cache/tmp";

  cmd.push(
    // General temp (POSIX standard - used by most tools)
    "-e", `TMPDIR=${tmpPath}`,
    "-e", `TEMP=${tmpPath}`,             // Windows-style (some cross-platform tools)
    "-e", `TMP=${tmpPath}`,              // Alternative

    // Node.js / npm
    "-e", `npm_config_tmp=${tmpPath}`,   // npm temp (node-gyp native builds)

    // Python
    "-e", `PIP_BUILD_DIR=${tmpPath}`,    // pip wheel builds

    // Go
    "-e", `GOTMPDIR=${tmpPath}`,         // Go compiler temp

    // Java / Maven / Gradle
    "-e", `MAVEN_OPTS=-Djava.io.tmpdir=${tmpPath}`,  // Maven temp
    "-e", `GRADLE_USER_HOME=${tmpPath}/.gradle`,     // Gradle home (includes tmp)
    "-e", `_JAVA_OPTIONS=-Djava.io.tmpdir=${tmpPath}`, // Global Java temp fallback
  );
}

function addClaudeEnv(cmd: string[]): void {
  const tz = getHostTimezone();
  cmd.push("-e", `TZ=${tz}`);

  cmd.push(
    "-e",
    "FORCE_COLOR=1",
    "-e",
    "CLAUDE_CONFIG_DIR=/home/node/.claude",
    "-e",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1",
    "-e",
    "DISABLE_AUTOUPDATER=1",
    "-e",
    "PYTHONUNBUFFERED=1",
    "-e",
    "NODE_OPTIONS=--no-warnings --disable-warning=ExperimentalWarning --disable-warning=DeprecationWarning",
    "-e",
    "NODE_NO_READLINE=1",
    "-e",
    "NODE_COMPILE_CACHE=/home/node/.cache/node-compile"
  );
}
