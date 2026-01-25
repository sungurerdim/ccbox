/* eslint-disable no-useless-escape -- Dockerfile templates require \$ escapes for shell variables */
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
import { FUSE_BINARY_AMD64, FUSE_BINARY_ARM64 } from "./fuse-binaries.js";
import { resolveForDocker, normalizeProjectDirName } from "./paths.js";

// Container constraints (SSOT - used for both docker run and prompt generation)
const CONTAINER_CONSTRAINTS = {
  pidsLimit: DEFAULT_PIDS_LIMIT,         // from constants.ts
  capDrop: "ALL",                        // Linux capabilities
  ephemeralPaths: ["/tmp", "/var/tmp", "~/.cache"],
} as const;

/** Generate container awareness prompt with current constraints. */
function buildContainerAwarenessPrompt(persistentPaths: string): string {
  const { pidsLimit } = CONTAINER_CONSTRAINTS;

  // Detect host OS for better guidance
  const hostOS = platform() === "win32" ? "Windows" : platform() === "darwin" ? "macOS" : "Linux";

  return `
[CCBOX CONTAINER ENVIRONMENT]

You are in an isolated Linux container (Debian). The host is ${hostOS}.

CRITICAL RULES:
1. This is LINUX - use bash syntax, forward slashes, no Windows commands
2. Only ${persistentPaths} persist - everything else is deleted on exit
3. No Docker/systemd/GUI available - container has limited capabilities

COMMAND PATTERNS (use these, they work correctly):
  git -C /path status              # NOT: cd /path && git status
  npm --prefix /path install       # NOT: cd /path && npm install
  python3 /path/script.py          # absolute paths always work
  rg "pattern" /path               # ripgrep for fast search

${hostOS === "Windows" ? `WINDOWS HOST: Paths are auto-translated (D:\\\\GitHub\\\\x → /d/GitHub/x)
  NEVER use: cd /d, backslashes, cmd.exe syntax, PowerShell commands
` : ""}
FILESYSTEM:
  PERSISTENT: ${persistentPaths}
    → project files, node_modules/, venv/, target/, .git/ all saved
  EPHEMERAL: /tmp, /root, /etc, /usr, apt packages, global installs
    → lost on exit, use project-local alternatives

AVAILABLE TOOLS:
  git, gh (GitHub CLI), curl, wget, ssh, jq, yq, rg (ripgrep), fd
  python3, pip3, gcc, make + stack-specific tools (node, cargo, go, etc.)

LIMITATIONS:
  ✗ docker, docker-compose, podman (no Docker-in-Docker)
  ✗ systemctl, service (no init system)
  ✗ npm -g, pip install --user (use local: npm install, pip install -t)
  ✗ apt install (lost on exit - most tools pre-installed)
  △ /tmp has noexec - use $TMPDIR for executable temp files
  △ Max ${pidsLimit} processes - avoid excessive parallelism

WHEN SOMETHING FAILS:
  - Path error? Use absolute Linux paths, check translation
  - Command not found? Try: which <cmd>, or use npx/pipx
  - Permission denied? You're 'node' user, not root
  - Can't install? Check if pre-installed or use project-local install
`.trim();
}

// Common system packages (optimized for minimal size)
// Layer ordering: stable layers first, frequently changing last
const COMMON_TOOLS = `
# Create ccbox user (uid 1000) with home at /ccbox
RUN groupadd -g 1000 ccbox 2>/dev/null || true && \\
    useradd -m -d /ccbox -s /bin/bash -u 1000 -g 1000 ccbox 2>/dev/null || true

# System packages - runtime only (no build deps needed - FUSE binary is pre-compiled)
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \\
    --mount=type=cache,target=/var/lib/apt,sharing=locked \\
    apt-get update && apt-get install -y --no-install-recommends \\
    # Essential runtime
    git curl ca-certificates bash openssh-client locales gosu \\
    # Search tools
    ripgrep jq fd-find \\
    # FUSE runtime (only fuse3 needed - binary is pre-compiled)
    fuse3 \\
    # GitHub CLI
    gh \\
    # Core utilities (grep/sed/findutils come with base image)
    procps unzip \\
    && rm -rf /var/lib/apt/lists/* \\
    # Locale setup
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

# Cross-platform path compatibility (Windows/macOS/Linux host paths)
# Windows: /{a..z} (all drive letters)  macOS: /Users  Linux: /home already exists
RUN bash -c 'mkdir -p /{a..z} /Users && chown ccbox:ccbox /{a..z} /Users'

# Locale and performance environment
ENV LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 \\
    # Bun/Node.js: production mode for optimized behavior
    NODE_ENV=production \\
    # Git performance: disable advice messages, use parallel index
    GIT_ADVICE=0 \\
    GIT_INDEX_THREADS=0
`;

// FUSE filesystem - pre-compiled binaries for kernel-level path transformation
// FUSE intercepts ALL file operations including Bun/Zig direct syscalls
// No gcc/build-deps needed - binaries are embedded in ccbox CLI
function generateFuseBuild(): string {
  return `
# Install pre-compiled FUSE binary for kernel-level path transformation
# FUSE works with ALL apps including Bun (which bypasses glibc/LD_PRELOAD)
# Binary is pre-compiled - no gcc needed (~2GB download savings)
# Uses Docker's TARGETARCH for multi-platform builds
ARG TARGETARCH=amd64
COPY ccbox-fuse-amd64 ccbox-fuse-arm64 /tmp/
RUN if [ "$TARGETARCH" = "arm64" ]; then \\
        cp /tmp/ccbox-fuse-arm64 /usr/local/bin/ccbox-fuse; \\
    else \\
        cp /tmp/ccbox-fuse-amd64 /usr/local/bin/ccbox-fuse; \\
    fi \\
    && chmod 755 /usr/local/bin/ccbox-fuse \\
    && echo 'user_allow_other' >> /etc/fuse.conf \\
    && rm -f /tmp/ccbox-fuse-*
`;
}

// Legacy: Keep for reference - C source compilation (requires gcc)
const FUSE_BUILD_FROM_SOURCE = `
# Build FUSE filesystem from source (requires gcc ~2GB)
COPY ccbox-fuse.c /tmp/ccbox-fuse.c
RUN gcc -Wall -O2 -o /usr/local/bin/ccbox-fuse /tmp/ccbox-fuse.c $(pkg-config fuse3 --cflags --libs) \\
    && chmod 755 /usr/local/bin/ccbox-fuse \\
    && echo 'user_allow_other' >> /etc/fuse.conf \\
    && rm /tmp/ccbox-fuse.c \\
    && apt-get purge -y --auto-remove gcc libc6-dev libfuse3-dev pkg-config \\
    && rm -rf /var/lib/apt/lists/*
`;

// Placeholder for backward compatibility
const FUSE_BUILD = generateFuseBuild();

// Python dev tools
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

// Claude Code native binary installation
// Install as root, then move to system-wide location for non-root access
const CLAUDE_CODE_INSTALL = `
# Claude Code (native binary - official installation)
# Install first, then copy to /usr/local/bin for non-root user access
# Note: installer creates symlink, so use cp -L to dereference and copy actual binary
# Also create symlink at /ccbox/.local/bin/claude for native install detection
RUN curl -fsSL https://claude.ai/install.sh | bash -s latest \\
    && cp -L /root/.local/bin/claude /usr/local/bin/claude \\
    && chmod 755 /usr/local/bin/claude \\
    && mkdir -p /ccbox/.local/bin \\
    && ln -s /usr/local/bin/claude /ccbox/.local/bin/claude \\
    && chown -R ccbox:ccbox /ccbox/.local \\
    && rm -rf /root/.local/share/claude /root/.local/bin/claude

# Add /ccbox/.local/bin to PATH for native install detection
ENV PATH="/ccbox/.local/bin:$PATH"
`;

// Entrypoint setup
const ENTRYPOINT_SETUP = `
WORKDIR /ccbox

COPY --chmod=755 entrypoint.sh /usr/local/bin/entrypoint.sh

ENV HOME=/ccbox

# Start as root - entrypoint will switch to host user's UID/GID
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
`;

// Dockerfile generators for each stack
function baseDockerfile(): string {
  return `# syntax=docker/dockerfile:1
# ccbox/base - Claude Code (default)
FROM debian:bookworm-slim

LABEL org.opencontainers.image.title="ccbox/base"

# Timezone passthrough from host
ARG TZ=UTC
ENV TZ="\${TZ}"

ENV DEBIAN_FRONTEND=noninteractive
${COMMON_TOOLS}
${FUSE_BUILD}
${CLAUDE_CODE_INSTALL}
${ENTRYPOINT_SETUP}
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
# ccbox/go - Go + Claude Code + golangci-lint
FROM golang:latest

LABEL org.opencontainers.image.title="ccbox/go"

# Timezone passthrough from host
ARG TZ=UTC
ENV TZ="\${TZ}"

ENV DEBIAN_FRONTEND=noninteractive
${COMMON_TOOLS}
${FUSE_BUILD}
${CLAUDE_CODE_INSTALL}
# golangci-lint (latest)
RUN curl -sSfL https://raw.githubusercontent.com/golangci/golangci-lint/master/install.sh | sh -s -- -b /usr/local/bin
${ENTRYPOINT_SETUP}
`;
}

function rustDockerfile(): string {
  return `# syntax=docker/dockerfile:1
# ccbox/rust - Rust + Claude Code + clippy + rustfmt
FROM rust:latest

LABEL org.opencontainers.image.title="ccbox/rust"

# Timezone passthrough from host
ARG TZ=UTC
ENV TZ="\${TZ}"

ENV DEBIAN_FRONTEND=noninteractive
${COMMON_TOOLS}
${FUSE_BUILD}
${CLAUDE_CODE_INSTALL}
# Rust tools (clippy + rustfmt)
RUN rustup component add clippy rustfmt
${ENTRYPOINT_SETUP}
`;
}

function javaDockerfile(): string {
  return `# syntax=docker/dockerfile:1
# ccbox/java - Java (Temurin LTS) + Claude Code + Maven + quality tools
FROM eclipse-temurin:latest

LABEL org.opencontainers.image.title="ccbox/java"

# Timezone passthrough from host
ARG TZ=UTC
ENV TZ="\${TZ}"

ENV DEBIAN_FRONTEND=noninteractive
${COMMON_TOOLS}
${FUSE_BUILD}
${CLAUDE_CODE_INSTALL}
# Maven (latest from Apache)
RUN set -eux; \\
    MVN_VER=$(curl -sfL https://api.github.com/repos/apache/maven/releases/latest | jq -r .tag_name | sed 's/maven-//'); \\
    curl -sfL "https://archive.apache.org/dist/maven/maven-3/\${MVN_VER}/binaries/apache-maven-\${MVN_VER}-bin.tar.gz" | tar -xz -C /opt; \\
    ln -s /opt/apache-maven-\${MVN_VER}/bin/mvn /usr/local/bin/mvn

# Java quality tools (google-java-format for formatting, checkstyle for linting)
RUN GJF_VER=\$(curl -sfL https://api.github.com/repos/google/google-java-format/releases/latest | jq -r .tag_name | sed 's/v//') \\
    && curl -sfL "https://github.com/google/google-java-format/releases/download/v\${GJF_VER}/google-java-format-\${GJF_VER}-all-deps.jar" -o /opt/google-java-format.jar \\
    && echo '#!/bin/bash\\njava -jar /opt/google-java-format.jar "\$@"' > /usr/local/bin/google-java-format \\
    && chmod +x /usr/local/bin/google-java-format \\
    && CS_VER=\$(curl -sfL https://api.github.com/repos/checkstyle/checkstyle/releases/latest | jq -r .tag_name | sed 's/checkstyle-//') \\
    && curl -sfL "https://github.com/checkstyle/checkstyle/releases/download/checkstyle-\${CS_VER}/checkstyle-\${CS_VER}-all.jar" -o /opt/checkstyle.jar \\
    && echo '#!/bin/bash\\njava -jar /opt/checkstyle.jar "\$@"' > /usr/local/bin/checkstyle \\
    && chmod +x /usr/local/bin/checkstyle
${ENTRYPOINT_SETUP}
`;
}

function webDockerfile(): string {
  return `# syntax=docker/dockerfile:1
# ccbox/web - Node.js + Bun + TypeScript + test tools (fullstack)
FROM ccbox/base

LABEL org.opencontainers.image.title="ccbox/web"

# Node.js LTS (for npm-based projects)
RUN curl -fsSL https://deb.nodesource.com/setup_lts.x | bash - \\
    && apt-get install -y --no-install-recommends nodejs \\
    && rm -rf /var/lib/apt/lists/*

# pnpm (via corepack)
RUN corepack enable && corepack prepare pnpm@latest --activate

# Bun (fast JavaScript runtime and package manager)
RUN curl -fsSL https://bun.sh/install | bash \\
    && ln -s /root/.bun/bin/bun /usr/local/bin/bun \\
    && ln -s /root/.bun/bin/bunx /usr/local/bin/bunx

# Node.js/TypeScript dev tools (typescript, eslint, vitest, prettier)
RUN npm install -g typescript eslint vitest prettier @types/node \\
    && npm cache clean --force
`;
}

// ══════════════════════════════════════════════════════════════════════════════
// Extended Stack Dockerfiles
// ══════════════════════════════════════════════════════════════════════════════

function jvmDockerfile(): string {
  return `# syntax=docker/dockerfile:1
# ccbox/jvm - Java + Scala + Clojure + Kotlin
FROM ccbox/java

LABEL org.opencontainers.image.title="ccbox/jvm"

# Scala (sbt)
RUN curl -fsSL "https://github.com/sbt/sbt/releases/download/v1.10.11/sbt-1.10.11.tgz" | tar -xz -C /opt \\
    && ln -s /opt/sbt/bin/sbt /usr/local/bin/sbt

# Clojure CLI
RUN curl -fsSL https://download.clojure.org/install/linux-install.sh | bash

# Kotlin compiler
RUN KOTLIN_VER=\$(curl -sfL https://api.github.com/repos/JetBrains/kotlin/releases/latest | jq -r .tag_name | sed 's/v//') \\
    && curl -fsSL "https://github.com/JetBrains/kotlin/releases/download/v\${KOTLIN_VER}/kotlin-compiler-\${KOTLIN_VER}.zip" -o /tmp/kotlin.zip \\
    && unzip -q /tmp/kotlin.zip -d /opt && rm /tmp/kotlin.zip \\
    && ln -s /opt/kotlinc/bin/kotlin /usr/local/bin/kotlin \\
    && ln -s /opt/kotlinc/bin/kotlinc /usr/local/bin/kotlinc
`;
}

function dotnetDockerfile(): string {
  return `# syntax=docker/dockerfile:1
# ccbox/dotnet - .NET SDK + quality tools
FROM ccbox/base

LABEL org.opencontainers.image.title="ccbox/dotnet"

# .NET SDK (latest LTS) - includes built-in tools: dotnet format, dotnet test
RUN curl -fsSL https://dot.net/v1/dotnet-install.sh | bash -s -- --channel LTS --install-dir /usr/share/dotnet \\
    && ln -s /usr/share/dotnet/dotnet /usr/local/bin/dotnet
ENV DOTNET_ROOT=/usr/share/dotnet
ENV DOTNET_CLI_TELEMETRY_OPTOUT=1

# .NET quality tools (dotnet-format is built-in, add analyzers)
RUN dotnet tool install -g dotnet-reportgenerator-globaltool \\
    && dotnet tool install -g coverlet.console
ENV PATH="\$PATH:/root/.dotnet/tools"
`;
}

function swiftDockerfile(): string {
  return `# syntax=docker/dockerfile:1
# ccbox/swift - Swift + quality tools
FROM ccbox/base

LABEL org.opencontainers.image.title="ccbox/swift"

# Swift (official release) - includes swift-format built-in
RUN SWIFT_ARCH=\$(dpkg --print-architecture | sed 's/amd64/x86_64/;s/arm64/aarch64/') \\
    && SWIFT_VER=\$(curl -sfL https://api.github.com/repos/swiftlang/swift/releases/latest | jq -r .tag_name | sed 's/swift-//;s/-RELEASE//') \\
    && curl -fsSL "https://download.swift.org/swift-\${SWIFT_VER}-release/ubuntu2204/swift-\${SWIFT_VER}-RELEASE/swift-\${SWIFT_VER}-RELEASE-ubuntu22.04.tar.gz" | tar -xz -C /opt \\
    && ln -s /opt/swift-\${SWIFT_VER}-RELEASE-ubuntu22.04/usr/bin/swift /usr/local/bin/swift \\
    && ln -s /opt/swift-\${SWIFT_VER}-RELEASE-ubuntu22.04/usr/bin/swiftc /usr/local/bin/swiftc \\
    && ln -s /opt/swift-\${SWIFT_VER}-RELEASE-ubuntu22.04/usr/bin/swift-format /usr/local/bin/swift-format 2>/dev/null || true

# SwiftLint (linting)
RUN SWIFTLINT_VER=\$(curl -sfL https://api.github.com/repos/realm/SwiftLint/releases/latest | jq -r .tag_name) \\
    && curl -sfL "https://github.com/realm/SwiftLint/releases/download/\${SWIFTLINT_VER}/swiftlint_linux.zip" -o /tmp/swiftlint.zip \\
    && unzip -q /tmp/swiftlint.zip -d /usr/local/bin && rm /tmp/swiftlint.zip \\
    && chmod +x /usr/local/bin/swiftlint
`;
}

function dartDockerfile(): string {
  return `# syntax=docker/dockerfile:1
# ccbox/dart - Dart + quality tools (built-in: dart analyze, dart format, dart test)
FROM ccbox/base

LABEL org.opencontainers.image.title="ccbox/dart"

# Dart SDK - includes built-in quality tools:
#   dart analyze (linting), dart format (formatting), dart test (testing)
RUN DART_ARCH=\$(dpkg --print-architecture) \\
    && curl -fsSL "https://storage.googleapis.com/dart-archive/channels/stable/release/latest/sdk/dartsdk-linux-\${DART_ARCH}-release.zip" -o /tmp/dart.zip \\
    && unzip -q /tmp/dart.zip -d /opt && rm /tmp/dart.zip
ENV PATH="/opt/dart-sdk/bin:$PATH"

# DCM (Dart Code Metrics) - advanced static analysis
RUN dart pub global activate dart_code_metrics 2>/dev/null || true
ENV PATH="\$PATH:/root/.pub-cache/bin"
`;
}

function luaDockerfile(): string {
  return `# syntax=docker/dockerfile:1
# ccbox/lua - Lua + LuaRocks + quality tools
FROM ccbox/base

LABEL org.opencontainers.image.title="ccbox/lua"

# Lua + LuaRocks
RUN apt-get update && apt-get install -y --no-install-recommends \\
    lua5.4 liblua5.4-dev luarocks \\
    && rm -rf /var/lib/apt/lists/*

# Lua quality tools (luacheck for linting, lua-formatter for formatting)
RUN luarocks install luacheck \\
    && luarocks install --server=https://luarocks.org/dev luaformatter 2>/dev/null || true
`;
}

function cppDockerfile(): string {
  return `# syntax=docker/dockerfile:1
# ccbox/cpp - C++ + CMake + build tools
FROM ccbox/base

LABEL org.opencontainers.image.title="ccbox/cpp"

# C++ toolchain + CMake + Ninja
RUN apt-get update && apt-get install -y --no-install-recommends \\
    build-essential cmake ninja-build clang clang-format clang-tidy \\
    && rm -rf /var/lib/apt/lists/*

# Conan (C++ package manager)
RUN pip3 install --break-system-packages conan
`;
}

function dataDockerfile(): string {
  return `# syntax=docker/dockerfile:1
# ccbox/data - Python + R + Julia (data science)
# Extends python stack - includes uv, ruff, pytest, mypy
FROM ccbox/python

LABEL org.opencontainers.image.title="ccbox/data"

# R + common packages
RUN apt-get update && apt-get install -y --no-install-recommends \\
    r-base r-base-dev \\
    && rm -rf /var/lib/apt/lists/*

# Julia
RUN JULIA_ARCH=\$(dpkg --print-architecture | sed 's/amd64/x64/;s/arm64/aarch64/') \\
    && JULIA_VER=\$(curl -sfL https://api.github.com/repos/JuliaLang/julia/releases/latest | jq -r .tag_name | sed 's/v//') \\
    && JULIA_MINOR=\$(echo \$JULIA_VER | cut -d. -f1-2) \\
    && curl -fsSL "https://julialang-s3.julialang.org/bin/linux/\${JULIA_ARCH}/\${JULIA_MINOR}/julia-\${JULIA_VER}-linux-\${JULIA_ARCH}.tar.gz" | tar -xz -C /opt \\
    && ln -s /opt/julia-\${JULIA_VER}/bin/julia /usr/local/bin/julia
`;
}

function systemsDockerfile(): string {
  return `# syntax=docker/dockerfile:1
# ccbox/systems - C++ + Zig + Nim (systems programming)
# Extends cpp stack - includes CMake, Clang, Conan
FROM ccbox/cpp

LABEL org.opencontainers.image.title="ccbox/systems"

# Zig
RUN ZIG_ARCH=\$(dpkg --print-architecture | sed 's/amd64/x86_64/;s/arm64/aarch64/') \\
    && ZIG_VER=\$(curl -sfL https://ziglang.org/download/index.json | jq -r '.master.version') \\
    && curl -fsSL "https://ziglang.org/builds/zig-linux-\${ZIG_ARCH}-\${ZIG_VER}.tar.xz" | tar -xJ -C /opt \\
    && ln -s /opt/zig-linux-\${ZIG_ARCH}-\${ZIG_VER}/zig /usr/local/bin/zig

# Nim
RUN curl -fsSL https://nim-lang.org/choosenim/init.sh | sh -s -- -y \\
    && ln -s /root/.nimble/bin/nim /usr/local/bin/nim \\
    && ln -s /root/.nimble/bin/nimble /usr/local/bin/nimble
`;
}

function functionalDockerfile(): string {
  return `# syntax=docker/dockerfile:1
# ccbox/functional - Haskell + OCaml + Elixir/Erlang
FROM ccbox/base

LABEL org.opencontainers.image.title="ccbox/functional"

# GHCup (manages GHC, Stack, Cabal for Haskell)
RUN curl --proto '=https' --tlsv1.2 -sSf https://get-ghcup.haskell.org | \\
    BOOTSTRAP_HASKELL_NONINTERACTIVE=1 BOOTSTRAP_HASKELL_MINIMAL=1 sh \\
    && /root/.ghcup/bin/ghcup install ghc --set \\
    && /root/.ghcup/bin/ghcup install cabal --set \\
    && /root/.ghcup/bin/ghcup install stack --set
ENV PATH="/root/.ghcup/bin:/root/.cabal/bin:/root/.local/bin:$PATH"

# opam (OCaml package manager)
RUN apt-get update && apt-get install -y --no-install-recommends \\
    opam bubblewrap \\
    && rm -rf /var/lib/apt/lists/* \\
    && opam init --disable-sandboxing --auto-setup -y \\
    && opam install dune -y

# Erlang + Elixir
RUN apt-get update && apt-get install -y --no-install-recommends \\
    erlang elixir \\
    && rm -rf /var/lib/apt/lists/* \\
    && mix local.hex --force && mix local.rebar --force
`;
}

function scriptingDockerfile(): string {
  return `# syntax=docker/dockerfile:1
# ccbox/scripting - Ruby + PHP + Perl + quality tools (web backends)
FROM ccbox/base

LABEL org.opencontainers.image.title="ccbox/scripting"

# Ruby + Bundler + quality tools (rubocop for linting/formatting)
RUN apt-get update && apt-get install -y --no-install-recommends \\
    ruby ruby-dev ruby-bundler \\
    && rm -rf /var/lib/apt/lists/* \\
    && gem install bundler rubocop --no-document

# PHP + common extensions + Composer + quality tools (php-cs-fixer, phpstan)
RUN apt-get update && apt-get install -y --no-install-recommends \\
    php php-cli php-common php-curl php-json php-mbstring php-xml php-zip \\
    && rm -rf /var/lib/apt/lists/* \\
    && curl -sS https://getcomposer.org/installer | php -- --install-dir=/usr/local/bin --filename=composer \\
    && curl -L https://cs.symfony.com/download/php-cs-fixer-v3.phar -o /usr/local/bin/php-cs-fixer \\
    && chmod +x /usr/local/bin/php-cs-fixer \\
    && curl -L https://github.com/phpstan/phpstan/releases/latest/download/phpstan.phar -o /usr/local/bin/phpstan \\
    && chmod +x /usr/local/bin/phpstan

# Perl + cpanminus + quality tools (Perl::Critic, Perl::Tidy)
RUN apt-get update && apt-get install -y --no-install-recommends \\
    perl cpanminus liblocal-lib-perl \\
    && rm -rf /var/lib/apt/lists/* \\
    && cpanm --notest Perl::Critic Perl::Tidy 2>/dev/null || true
`;
}

function aiDockerfile(): string {
  return `# syntax=docker/dockerfile:1
# ccbox/ai - Python + Jupyter + PyTorch + TensorFlow (ML/AI)
# Extends python stack - includes uv, ruff, pytest, mypy
FROM ccbox/python

LABEL org.opencontainers.image.title="ccbox/ai"

# Jupyter + core ML libraries
# Using uv for faster installation
RUN uv pip install --system \\
    jupyter jupyterlab notebook \\
    numpy pandas scipy matplotlib seaborn \\
    scikit-learn \\
    && python -m compileall -q /usr/local/lib/python*/dist-packages 2>/dev/null || true

# PyTorch (CPU version - GPU requires nvidia-docker)
RUN uv pip install --system torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cpu

# TensorFlow (CPU version)
RUN uv pip install --system tensorflow
`;
}

function mobileDockerfile(): string {
  return `# syntax=docker/dockerfile:1
# ccbox/mobile - Dart + Flutter SDK + Android tools
# Extends dart stack - includes Dart SDK
FROM ccbox/dart

LABEL org.opencontainers.image.title="ccbox/mobile"

# Flutter SDK
RUN git clone https://github.com/flutter/flutter.git -b stable /opt/flutter --depth 1 \\
    && /opt/flutter/bin/flutter precache \\
    && /opt/flutter/bin/flutter config --no-analytics
ENV PATH="/opt/flutter/bin:$PATH"

# Android command-line tools (for flutter doctor)
RUN apt-get update && apt-get install -y --no-install-recommends \\
    openjdk-17-jdk-headless \\
    && rm -rf /var/lib/apt/lists/*
ENV JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64
`;
}

function gameDockerfile(): string {
  return `# syntax=docker/dockerfile:1
# ccbox/game - C++ + SDL2 + Lua + OpenGL (game development)
# Extends cpp stack - includes CMake, Clang, Conan
FROM ccbox/cpp

LABEL org.opencontainers.image.title="ccbox/game"

# SDL2 + OpenGL development libraries
RUN apt-get update && apt-get install -y --no-install-recommends \\
    libsdl2-dev libsdl2-image-dev libsdl2-mixer-dev libsdl2-ttf-dev \\
    libglew-dev libglm-dev libglfw3-dev \\
    libopenal-dev libfreetype-dev \\
    && rm -rf /var/lib/apt/lists/*

# Lua + LuaRocks (for game scripting)
RUN apt-get update && apt-get install -y --no-install-recommends \\
    lua5.4 liblua5.4-dev luarocks \\
    && rm -rf /var/lib/apt/lists/*
`;
}

function fullstackDockerfile(): string {
  return `# syntax=docker/dockerfile:1
# ccbox/fullstack - Node.js + Python + PostgreSQL client
# Extends web stack - includes Node.js, TypeScript, eslint, vitest
FROM ccbox/web

LABEL org.opencontainers.image.title="ccbox/fullstack"

${PYTHON_TOOLS_BASE}

# Database clients (PostgreSQL, MySQL, SQLite)
RUN apt-get update && apt-get install -y --no-install-recommends \\
    postgresql-client default-mysql-client sqlite3 \\
    && rm -rf /var/lib/apt/lists/*

# Redis CLI
RUN apt-get update && apt-get install -y --no-install-recommends \\
    redis-tools \\
    && rm -rf /var/lib/apt/lists/*
`;
}

// Stack to Dockerfile generator mapping
const DOCKERFILE_GENERATORS: Record<LanguageStack, () => string> = {
  // ═══════════════════════════════════════════════════════════════════════════
  // Core Language Stacks
  // ═══════════════════════════════════════════════════════════════════════════
  [LanguageStack.BASE]: baseDockerfile,
  [LanguageStack.PYTHON]: pythonDockerfile,
  [LanguageStack.WEB]: webDockerfile,
  [LanguageStack.GO]: goDockerfile,
  [LanguageStack.RUST]: rustDockerfile,
  [LanguageStack.JAVA]: javaDockerfile,
  [LanguageStack.CPP]: cppDockerfile,
  [LanguageStack.DOTNET]: dotnetDockerfile,
  [LanguageStack.SWIFT]: swiftDockerfile,
  [LanguageStack.DART]: dartDockerfile,
  [LanguageStack.LUA]: luaDockerfile,

  // ═══════════════════════════════════════════════════════════════════════════
  // Combined Language Stacks
  // ═══════════════════════════════════════════════════════════════════════════
  [LanguageStack.JVM]: jvmDockerfile,
  [LanguageStack.FUNCTIONAL]: functionalDockerfile,
  [LanguageStack.SCRIPTING]: scriptingDockerfile,
  [LanguageStack.SYSTEMS]: systemsDockerfile,

  // ═══════════════════════════════════════════════════════════════════════════
  // Use-Case Stacks
  // ═══════════════════════════════════════════════════════════════════════════
  [LanguageStack.DATA]: dataDockerfile,
  [LanguageStack.AI]: aiDockerfile,
  [LanguageStack.MOBILE]: mobileDockerfile,
  [LanguageStack.GAME]: gameDockerfile,
  [LanguageStack.FULLSTACK]: fullstackDockerfile,
};

/** Generate Dockerfile content for the given stack. */
export function generateDockerfile(stack: LanguageStack): string {
  const generator = DOCKERFILE_GENERATORS[stack];
  return generator ? generator() : baseDockerfile();
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

# Ensure critical directories are writable by the target user
if [[ "$(id -u)" == "0" && -n "$CCBOX_UID" && -n "$CCBOX_GID" ]]; then
    # Fix ownership of directories that may have been created by root during image build
    for dir in /ccbox/.cache /ccbox/.npm /ccbox/.local; do
        if [[ -d "$dir" ]]; then
            chown -R "$CCBOX_UID:$CCBOX_GID" "$dir" 2>/dev/null || true
        fi
    done
    # Create tmp directory for gosu user
    mkdir -p /ccbox/.cache/tmp 2>/dev/null || true
    chown -R "$CCBOX_UID:$CCBOX_GID" /ccbox/.cache/tmp 2>/dev/null || true

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
    local fuse_opts="source=$tmp_source,allow_other"
    [[ -n "$CCBOX_UID" ]] && fuse_opts="$fuse_opts,uid=$CCBOX_UID"
    [[ -n "$CCBOX_GID" ]] && fuse_opts="$fuse_opts,gid=$CCBOX_GID"
    [[ -n "$CCBOX_PATH_MAP" ]] && fuse_opts="$fuse_opts,pathmap=$CCBOX_PATH_MAP"

    _log_verbose "FUSE ($label): $tmp_source -> $mount_point (in-place overlay)"

    # Mount FUSE over original path (in-place overlay)
    nohup /usr/local/bin/ccbox-fuse -f -o "$fuse_opts" "$mount_point" </dev/null >/dev/null 2>&1 &
    local fuse_pid=$!
    sleep 0.5  # Wait for FUSE to initialize

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
    # Running as root - switch to non-root user via gosu
    _log_verbose "Switching to UID:$CCBOX_UID GID:$CCBOX_GID"
    EXEC_PREFIX="gosu $CCBOX_UID:$CCBOX_GID"
fi

# Run Claude Code
if [[ -t 1 ]]; then
    printf '\\e[?2026h' 2>/dev/null || true
    exec $EXEC_PREFIX $PRIORITY_CMD claude --dangerously-skip-permissions "$@"
else
    exec $EXEC_PREFIX stdbuf -oL -eL $PRIORITY_CMD claude --dangerously-skip-permissions "$@"
fi
`;
}
/* eslint-enable no-useless-escape */


/**
 * Generate ccbox-fuse.c content for FUSE filesystem.
 * This is embedded for compiled binary compatibility.
 * FUSE provides kernel-level path transformation that works with direct syscalls (Bun/Zig).
 */
function generateCcboxFuseC(): string {
  return `/**
 * ccbox-fuse: FUSE filesystem for transparent cross-platform path mapping
 * Provides kernel-level path transformation that works with io_uring and direct syscalls
 * This is REQUIRED for Bun-based Claude Code which bypasses glibc
 * Compile: gcc -Wall -O2 -o ccbox-fuse ccbox-fuse.c $(pkg-config fuse3 --cflags --libs)
 */
#define FUSE_USE_VERSION 31
#include <fuse3/fuse.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <fcntl.h>
#include <sys/stat.h>
#include <sys/statvfs.h>
#include <dirent.h>
#include <errno.h>
#include <ctype.h>
#include <limits.h>
#include <stddef.h>

#define MAX_MAPPINGS 32
#define MAX_PATH_LEN 4096

typedef struct {
    char *from, *to;
    size_t from_len, to_len;
    char drive;
    int is_unc, is_wsl;
} PathMapping;

static char *source_dir = NULL;
static PathMapping mappings[MAX_MAPPINGS];
static int mapping_count = 0;

static char *normalize_path(const char *path) {
    if (!path) return NULL;
    char *norm = strdup(path);
    if (!norm) return NULL;
    for (char *p = norm; *p; p++) if (*p == '\\\\') *p = '/';
    if (norm[0] && norm[1] == ':') norm[0] = tolower(norm[0]);
    size_t len = strlen(norm);
    while (len > 1 && norm[len-1] == '/') norm[--len] = '\\0';
    return norm;
}

static int needs_transform(const char *path) {
    if (!path || mapping_count == 0) return 0;
    const char *dot = strrchr(path, '.');
    return dot && strcasecmp(dot, ".json") == 0;
}

static void get_source_path(char *dest, const char *path, size_t destsize) {
    snprintf(dest, destsize, "%s%s", source_dir, path);
}

/* Transform Windows paths in JSON content to Linux paths */
/* Returns new buffer that caller must free, or NULL if no transform needed */
static char *transform_to_container_alloc(const char *buf, size_t len, size_t *newlen) {
    if (!buf || len == 0 || mapping_count == 0) { *newlen = len; return NULL; }
    char *work = malloc(len * 2 + 1);
    if (!work) { *newlen = len; return NULL; }
    size_t wi = 0, i = 0;
    int any_transform = 0;
    while (i < len && buf[i]) {
        int matched = 0;
        /* Check for drive letter pattern like C: or D: */
        if (i + 2 < len && isalpha(buf[i]) && buf[i+1] == ':') {
            char drive = tolower(buf[i]);
            for (int m = 0; m < mapping_count && !matched; m++) {
                if (mappings[m].drive == drive) {
                    /* Extract the full path after drive letter for comparison */
                    char pathbuf[MAX_PATH_LEN];
                    size_t pi = 0, ti = i + 2;
                    while (ti < len && buf[ti] != '"' && buf[ti] != ',' && buf[ti] != '}' && pi < MAX_PATH_LEN - 1) {
                        if (buf[ti] == '\\\\') { pathbuf[pi++] = '/'; ti++; if (ti < len && buf[ti] == '\\\\') ti++; }
                        else pathbuf[pi++] = buf[ti++];
                    }
                    pathbuf[pi] = '\\0';

                    /* Check if path starts with the mapped from-path (after drive letter) */
                    /* from is like "c:/Users/Sungur/.claude", so skip first 2 chars (c:) */
                    const char *from_path = mappings[m].from + 2;
                    size_t from_path_len = mappings[m].from_len - 2;

                    if (strncmp(pathbuf, from_path, from_path_len) == 0) {
                        /* Full prefix match - replace with to path */
                        memcpy(work + wi, mappings[m].to, mappings[m].to_len);
                        wi += mappings[m].to_len;
                        /* Copy remainder after the matched prefix */
                        const char *remainder = pathbuf + from_path_len;
                        size_t rem_len = strlen(remainder);
                        memcpy(work + wi, remainder, rem_len);
                        wi += rem_len;
                        i = ti;
                        matched = 1;
                        any_transform = 1;
                    }
                }
            }
        }
        if (!matched) work[wi++] = buf[i++];
    }
    work[wi] = '\\0';
    if (!any_transform) { free(work); *newlen = len; return NULL; }
    *newlen = wi;
    return work;
}

/* Transform Linux paths in JSON content to Windows paths (reverse transform for writes) */
/* Converts /ccbox/... paths back to C:\\\\Users\\\\... format for host filesystem */
static char *transform_to_host_alloc(const char *buf, size_t len, size_t *newlen) {
    if (!buf || len == 0 || mapping_count == 0) { *newlen = len; return NULL; }
    /* Allocate extra space for backslash escaping (worst case: each / becomes \\\\) */
    char *work = malloc(len * 4 + 1);
    if (!work) { *newlen = len; return NULL; }
    size_t wi = 0, i = 0;
    int any_transform = 0;

    while (i < len) {
        int matched = 0;
        /* Check for Linux path that matches a mapping's "to" path */
        for (int m = 0; m < mapping_count && !matched; m++) {
            size_t to_len = mappings[m].to_len;
            if (i + to_len <= len && strncmp(buf + i, mappings[m].to, to_len) == 0) {
                /* Check it's a proper path boundary */
                char next = (i + to_len < len) ? buf[i + to_len] : '\\0';
                if (next == '\\0' || next == '/' || next == '"' || next == ',' || next == '}' || next == ']') {
                    /* Write the Windows path with JSON-escaped backslashes */
                    const char *from = mappings[m].from;
                    for (size_t j = 0; j < mappings[m].from_len; j++) {
                        if (from[j] == '/') {
                            work[wi++] = '\\\\';
                            work[wi++] = '\\\\';
                        } else {
                            work[wi++] = from[j];
                        }
                    }
                    i += to_len;
                    matched = 1;
                    any_transform = 1;

                    /* Copy remainder path with JSON-escaped backslashes */
                    while (i < len && buf[i] != '"' && buf[i] != ',' && buf[i] != '}' && buf[i] != ']' && !isspace(buf[i])) {
                        if (buf[i] == '/') {
                            work[wi++] = '\\\\';
                            work[wi++] = '\\\\';
                        } else {
                            work[wi++] = buf[i];
                        }
                        i++;
                    }
                }
            }
        }
        if (!matched) work[wi++] = buf[i++];
    }
    work[wi] = '\\0';
    if (!any_transform) { free(work); *newlen = len; return NULL; }
    *newlen = wi;
    return work;
}

static int ccbox_getattr(const char *path, struct stat *stbuf, struct fuse_file_info *fi) {
    (void)fi;
    char fpath[MAX_PATH_LEN];
    get_source_path(fpath, path, sizeof(fpath));
    return lstat(fpath, stbuf) == -1 ? -errno : 0;
}

static int ccbox_readdir(const char *path, void *buf, fuse_fill_dir_t filler, off_t offset, struct fuse_file_info *fi, enum fuse_readdir_flags flags) {
    (void)offset; (void)fi; (void)flags;
    char fpath[MAX_PATH_LEN];
    get_source_path(fpath, path, sizeof(fpath));
    DIR *dp = opendir(fpath);
    if (!dp) return -errno;
    struct dirent *de;
    while ((de = readdir(dp))) {
        struct stat st = {0};
        st.st_ino = de->d_ino;
        st.st_mode = de->d_type << 12;
        if (filler(buf, de->d_name, &st, 0, 0)) break;
    }
    closedir(dp);
    return 0;
}

static int ccbox_open(const char *path, struct fuse_file_info *fi) {
    char fpath[MAX_PATH_LEN];
    get_source_path(fpath, path, sizeof(fpath));
    int fd = open(fpath, fi->flags);
    if (fd == -1) return -errno;
    fi->fh = fd;
    return 0;
}

static int ccbox_read(const char *path, char *buf, size_t size, off_t offset, struct fuse_file_info *fi) {
    int fd = fi->fh;
    if (needs_transform(path)) {
        struct stat st;
        if (fstat(fd, &st) == -1) return -errno;
        size_t filesize = st.st_size;
        if (filesize == 0) return 0;
        char *filebuf = malloc(filesize + 1);
        if (!filebuf) return -ENOMEM;
        ssize_t nread = pread(fd, filebuf, filesize, 0);
        if (nread == -1) { free(filebuf); return -errno; }
        filebuf[nread] = '\\0';

        /* Transform paths - may return new buffer if transform happened */
        size_t newlen;
        char *transformed = transform_to_container_alloc(filebuf, nread, &newlen);
        char *result = transformed ? transformed : filebuf;

        if ((size_t)offset >= newlen) {
            if (transformed) free(transformed);
            free(filebuf);
            return 0;
        }
        size_t tocopy = newlen - offset;
        if (tocopy > size) tocopy = size;
        memcpy(buf, result + offset, tocopy);
        if (transformed) free(transformed);
        free(filebuf);
        return tocopy;
    }
    ssize_t res = pread(fd, buf, size, offset);
    return res == -1 ? -errno : res;
}

static int ccbox_write(const char *path, const char *buf, size_t size, off_t offset, struct fuse_file_info *fi) {
    if (needs_transform(path)) {
        /* For JSON files, transform Linux paths back to Windows paths */
        size_t newlen;
        char *transformed = transform_to_host_alloc(buf, size, &newlen);
        if (transformed) {
            /* Write transformed content - handle offset by reading existing, merging, writing */
            if (offset == 0) {
                /* Simple case: writing from beginning */
                ssize_t res = pwrite(fi->fh, transformed, newlen, 0);
                /* Truncate file to new size in case new content is shorter */
                if (res >= 0) ftruncate(fi->fh, newlen);
                free(transformed);
                return res == -1 ? -errno : (int)size;
            } else {
                /* Complex case: writing at offset - need to merge with existing content */
                struct stat st;
                if (fstat(fi->fh, &st) == -1) { free(transformed); return -errno; }
                size_t filesize = st.st_size;
                size_t total = (offset + newlen > filesize) ? offset + newlen : filesize;
                char *merged = malloc(total);
                if (!merged) { free(transformed); return -ENOMEM; }
                /* Read existing content */
                pread(fi->fh, merged, filesize, 0);
                /* Overlay transformed content at offset */
                memcpy(merged + offset, transformed, newlen);
                /* Write back */
                ssize_t res = pwrite(fi->fh, merged, total, 0);
                if (res >= 0) ftruncate(fi->fh, total);
                free(merged);
                free(transformed);
                return res == -1 ? -errno : (int)size;
            }
        }
    }
    ssize_t res = pwrite(fi->fh, buf, size, offset);
    return res == -1 ? -errno : res;
}

static int ccbox_release(const char *path, struct fuse_file_info *fi) { (void)path; close(fi->fh); return 0; }
static int ccbox_flush(const char *path, struct fuse_file_info *fi) { (void)path; return close(dup(fi->fh)) == -1 ? -errno : 0; }
static int ccbox_fsync(const char *path, int isdatasync, struct fuse_file_info *fi) { (void)path; return (isdatasync ? fdatasync(fi->fh) : fsync(fi->fh)) == -1 ? -errno : 0; }
static int ccbox_statfs(const char *path, struct statvfs *stbuf) { char fpath[MAX_PATH_LEN]; get_source_path(fpath, path, sizeof(fpath)); return statvfs(fpath, stbuf) == -1 ? -errno : 0; }
static int ccbox_access(const char *path, int mask) { char fpath[MAX_PATH_LEN]; get_source_path(fpath, path, sizeof(fpath)); return access(fpath, mask) == -1 ? -errno : 0; }
static int ccbox_mkdir(const char *path, mode_t mode) {
    struct fuse_context *ctx = fuse_get_context();
    char fpath[MAX_PATH_LEN];
    get_source_path(fpath, path, sizeof(fpath));
    if (mkdir(fpath, mode) == -1) return -errno;
    // Set ownership to calling process (not FUSE daemon)
    chown(fpath, ctx->uid, ctx->gid);
    return 0;
}
static int ccbox_unlink(const char *path) { char fpath[MAX_PATH_LEN]; get_source_path(fpath, path, sizeof(fpath)); return unlink(fpath) == -1 ? -errno : 0; }
static int ccbox_rmdir(const char *path) { char fpath[MAX_PATH_LEN]; get_source_path(fpath, path, sizeof(fpath)); return rmdir(fpath) == -1 ? -errno : 0; }
static int ccbox_create(const char *path, mode_t mode, struct fuse_file_info *fi) {
    struct fuse_context *ctx = fuse_get_context();
    char fpath[MAX_PATH_LEN];
    get_source_path(fpath, path, sizeof(fpath));
    int fd = open(fpath, fi->flags, mode);
    if (fd == -1) return -errno;
    fi->fh = fd;
    // Set ownership to calling process (not FUSE daemon)
    fchown(fd, ctx->uid, ctx->gid);
    return 0;
}
static int ccbox_truncate(const char *path, off_t size, struct fuse_file_info *fi) { char fpath[MAX_PATH_LEN]; get_source_path(fpath, path, sizeof(fpath)); return (fi ? ftruncate(fi->fh, size) : truncate(fpath, size)) == -1 ? -errno : 0; }
static int ccbox_utimens(const char *path, const struct timespec ts[2], struct fuse_file_info *fi) { (void)fi; char fpath[MAX_PATH_LEN]; get_source_path(fpath, path, sizeof(fpath)); return utimensat(0, fpath, ts, AT_SYMLINK_NOFOLLOW) == -1 ? -errno : 0; }
static int ccbox_chmod(const char *path, mode_t mode, struct fuse_file_info *fi) { (void)fi; char fpath[MAX_PATH_LEN]; get_source_path(fpath, path, sizeof(fpath)); return chmod(fpath, mode) == -1 ? -errno : 0; }
static int ccbox_chown(const char *path, uid_t uid, gid_t gid, struct fuse_file_info *fi) { (void)fi; char fpath[MAX_PATH_LEN]; get_source_path(fpath, path, sizeof(fpath)); return lchown(fpath, uid, gid) == -1 ? -errno : 0; }
static int ccbox_rename(const char *from, const char *to, unsigned int flags) { if (flags) return -EINVAL; char ff[MAX_PATH_LEN], ft[MAX_PATH_LEN]; get_source_path(ff, from, sizeof(ff)); get_source_path(ft, to, sizeof(ft)); return rename(ff, ft) == -1 ? -errno : 0; }
static int ccbox_symlink(const char *target, const char *linkpath) {
    struct fuse_context *ctx = fuse_get_context();
    char fpath[MAX_PATH_LEN];
    get_source_path(fpath, linkpath, sizeof(fpath));
    if (symlink(target, fpath) == -1) return -errno;
    // Set ownership to calling process (not FUSE daemon)
    lchown(fpath, ctx->uid, ctx->gid);
    return 0;
}
static int ccbox_readlink(const char *path, char *buf, size_t size) { char fpath[MAX_PATH_LEN]; get_source_path(fpath, path, sizeof(fpath)); ssize_t res = readlink(fpath, buf, size - 1); if (res == -1) return -errno; buf[res] = '\\0'; return 0; }
static int ccbox_link(const char *from, const char *to) { char ff[MAX_PATH_LEN], ft[MAX_PATH_LEN]; get_source_path(ff, from, sizeof(ff)); get_source_path(ft, to, sizeof(ft)); return link(ff, ft) == -1 ? -errno : 0; }

static const struct fuse_operations ccbox_oper = {
    .getattr = ccbox_getattr, .readdir = ccbox_readdir, .open = ccbox_open, .read = ccbox_read,
    .write = ccbox_write, .release = ccbox_release, .flush = ccbox_flush, .fsync = ccbox_fsync,
    .statfs = ccbox_statfs, .access = ccbox_access, .mkdir = ccbox_mkdir, .unlink = ccbox_unlink,
    .rmdir = ccbox_rmdir, .create = ccbox_create, .truncate = ccbox_truncate, .utimens = ccbox_utimens,
    .chmod = ccbox_chmod, .chown = ccbox_chown, .rename = ccbox_rename, .symlink = ccbox_symlink,
    .readlink = ccbox_readlink, .link = ccbox_link,
};

static void add_mapping(const char *from, const char *to) {
    if (mapping_count >= MAX_MAPPINGS) return;
    PathMapping *m = &mappings[mapping_count];
    m->from = normalize_path(from);
    m->to = normalize_path(to);
    if (!m->from || !m->to) { free(m->from); free(m->to); return; }
    m->from_len = strlen(m->from);
    m->to_len = strlen(m->to);
    m->drive = (m->from[0] && m->from[1] == ':') ? tolower(m->from[0]) : 0;
    m->is_unc = m->from[0] == '/' && m->from[1] == '/';
    m->is_wsl = strncmp(m->from, "/mnt/", 5) == 0 && isalpha(m->from[5]);
    if (m->is_wsl) m->drive = tolower(m->from[5]);
    mapping_count++;
}

static void parse_pathmap(const char *pathmap) {
    if (!pathmap || !*pathmap) return;
    char *copy = strdup(pathmap);
    if (!copy) return;
    char *saveptr = NULL, *mapping = strtok_r(copy, ";", &saveptr);
    while (mapping) {
        char *sep = mapping;
        /* Skip drive letter in Windows path (e.g., C:/...) */
        if (sep[0] && sep[1] == ':') sep += 2;
        sep = strchr(sep, ':');
        if (sep) { *sep = '\\0'; add_mapping(mapping, sep + 1); }
        mapping = strtok_r(NULL, ";", &saveptr);
    }
    free(copy);
}

struct ccbox_config { char *source; char *pathmap; };

static struct fuse_opt ccbox_opts[] = {
    {"source=%s", offsetof(struct ccbox_config, source), 0},
    {"pathmap=%s", offsetof(struct ccbox_config, pathmap), 0},
    FUSE_OPT_END
};

int main(int argc, char *argv[]) {
    struct fuse_args args = FUSE_ARGS_INIT(argc, argv);
    struct ccbox_config conf = {0};
    if (fuse_opt_parse(&args, &conf, ccbox_opts, NULL) == -1) return 1;
    if (!conf.source) { fprintf(stderr, "Error: source not specified\\n"); return 1; }
    source_dir = conf.source;
    size_t slen = strlen(source_dir);
    while (slen > 1 && source_dir[slen-1] == '/') source_dir[--slen] = '\\0';
    if (conf.pathmap) parse_pathmap(conf.pathmap);
    fuse_opt_add_arg(&args, "-o");
    fuse_opt_add_arg(&args, "default_permissions");
    if (getuid() == 0) { fuse_opt_add_arg(&args, "-o"); fuse_opt_add_arg(&args, "allow_other"); }
    int ret = fuse_main(args.argc, args.argv, &ccbox_oper, NULL);
    fuse_opt_free_args(&args);
    return ret;
}
`;
}

/**
 * Write Dockerfile and entrypoint to build directory.
 * Uses OS-agnostic path handling.
 * @param targetArch - Target architecture (amd64 or arm64). If not specified, uses host arch.
 */
export function writeBuildFiles(stack: LanguageStack, targetArch?: string): string {
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
  let fuseContent: string;
  if (existsSync(fuseSrc)) {
    fuseContent = readFileSync(fuseSrc, "utf-8");
  } else {
    // Fallback to embedded version when running from compiled binary
    fuseContent = generateCcboxFuseC();
  }
  writeFileSync(join(buildDir, "ccbox-fuse.c"), fuseContent, { encoding: "utf-8" });

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

/**
 * Fix MSYS path translation for slash commands on Windows Git Bash.
 *
 * Git Bash (MSYS2) translates Unix paths like /command to C:/Program Files/Git/command.
 * This function reverses that translation for slash commands.
 *
 * All slash commands are passed directly to Claude Code - it handles both
 * built-in commands (/compact, /doctor, etc.) and custom commands.
 */
export function transformSlashCommand(prompt: string | undefined): string | undefined {
  if (!prompt) {
    return prompt;
  }

  // Fix MSYS path translation: /command -> C:/Program Files/Git/command
  // This happens when running ccbox from Git Bash on Windows
  const msysPrefix = "C:/Program Files/Git/";
  if (prompt.startsWith(msysPrefix)) {
    prompt = "/" + prompt.slice(msysPrefix.length);
  }

  return prompt;
}

/**
 * Get host UID and GID for container user mapping (cross-platform).
 *
 * Platform behavior:
 * - **Windows**: Docker Desktop uses a Linux VM. Files created in bind mounts
 *   appear as the container user (ccbox/1000:1000). Windows doesn't have Unix
 *   UID/GID concepts, so we use the container's default user ID.
 * - **macOS**: Docker Desktop uses a Linux VM with osxfs/gRPC FUSE for file
 *   sharing. It automatically maps the host user to container UID via
 *   user namespace remapping. We use actual host UID for consistency.
 * - **Linux**: Native Docker uses the host kernel. UID/GID directly affect
 *   file ownership on bind mounts. We use actual host UID/GID to ensure
 *   created files are owned by the host user.
 *
 * @returns Tuple of [uid, gid] to use for container processes.
 */
export function getHostUserIds(): [number, number] {
  if (platform() === "win32") {
    // Windows: No native UID/GID. Docker Desktop maps to container's default user.
    // Use 1000:1000 (ccbox user created in Dockerfile)
    return [1000, 1000];
  }

  // Linux/macOS: Use actual host UID/GID for proper file ownership
  // Fallback to 1000 if process.getuid() is unavailable (shouldn't happen on Unix)
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

  // 2. Use JavaScript Intl API (works on all platforms including Windows)
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (tz && tz.includes("/")) {
      return tz;
    }
  } catch {
    // Ignore
  }

  // 3. Try /etc/timezone (Debian/Ubuntu) - Linux only
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

    // 4. Try /etc/localtime symlink (Linux/macOS)
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

  // 5. Fallback to UTC
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
    options.persistentPaths ?? "/ccbox/project, /ccbox/.claude"
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
 * Two mount modes:
 * - Normal: full ~/.claude mount
 * - Fresh (--fresh): only credentials, clean slate for customizations
 */
export function getDockerRunCmd(
  config: Config,
  projectPath: string,
  projectName: string,
  stack: LanguageStack,
  options: {
    fresh?: boolean;
    ephemeralLogs?: boolean;
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
  // Normalize directory name for cross-platform compatibility
  // Preserves unicode/special chars but applies NFC normalization and removes control chars
  const dirName = normalizeProjectDirName(basename(projectPath));
  const dockerProjectPath = resolveForDocker(resolve(projectPath));

  const cmd = ["docker", "run", "--rm"];

  // TTY allocation logic (cross-platform)
  // Interactive mode requires TTY for Claude Code's input handling
  const isInteractive = !prompt && !options.quiet;
  const isTTY = process.stdin.isTTY ?? false;

  if (isInteractive && isTTY) {
    // Use -it for interactive mode (requires proper TTY)
    // On Windows: use Windows Terminal (wt.exe) for best compatibility
    cmd.push("-it");
  } else if (isInteractive) {
    // Interactive but no TTY detected - still try with -it
    // This handles edge cases where TTY detection fails
    cmd.push("-it");
  } else {
    // Non-interactive (prompt mode) - stdin only
    cmd.push("-i");
  }

  cmd.push("--name", containerName);

  // Project mount (always) - includes project .claude if exists
  cmd.push("-v", `${dockerProjectPath}:/ccbox/${dirName}:rw`);

  // Claude config mount
  // - Base image: minimal mount (only credentials + settings for vanilla experience)
  // - Fresh mode: same as base (explicit --fresh flag)
  // - Other images: full .claude mount with FUSE in-place overlay for path transformation
  const dockerClaudeConfig = resolveForDocker(claudeConfig);
  const isBaseImage = stack === "base";
  const useMinimalMount = options.fresh || isBaseImage;

  if (useMinimalMount) {
    addMinimalMounts(cmd, claudeConfig);
  } else {
    // Mount global .claude directly - FUSE does in-place overlay in entrypoint
    // No .claude-source needed - FUSE uses bind mount trick inside container
    cmd.push("-v", `${dockerClaudeConfig}:/ccbox/.claude:rw`);

    // FUSE device access for kernel-level path transformation
    // Windows Docker Desktop requires --privileged for /dev/fuse access
    // Linux/macOS can use --device /dev/fuse with SYS_ADMIN capability
    if (platform() === "win32") {
      cmd.push("--privileged");
    } else {
      cmd.push("--device", "/dev/fuse");
    }
  }

  // Working directory
  cmd.push("-w", `/ccbox/${dirName}`);

  // User mapping
  addUserMapping(cmd);

  // Security options (skip if already privileged)
  if (platform() !== "win32" || useMinimalMount) {
    addSecurityOptions(cmd);
  }
  addDnsOptions(cmd);

  // Resource limits
  if (!options.unrestricted) {
    cmd.push("--cpu-shares=512");
  }

  // Environment variables
  // HOME = project directory, CLAUDE_CONFIG_DIR = global config
  cmd.push("-e", `HOME=/ccbox/${dirName}`);
  cmd.push("-e", "CLAUDE_CONFIG_DIR=/ccbox/.claude");
  addTerminalEnv(cmd);
  addClaudeEnv(cmd);

  if ((options.debug ?? 0) > 0) {
    cmd.push("-e", `CCBOX_DEBUG=${options.debug}`);
  }

  if (options.unrestricted) {
    cmd.push("-e", "CCBOX_UNRESTRICTED=1");
  }

  // Debug logs: ephemeral if requested, otherwise normal (persisted to host)
  if (options.ephemeralLogs) {
    cmd.push("--tmpfs", "/ccbox/.claude/debug:rw,size=512m,mode=0777");
  }

  // Persistent paths for container awareness
  // Base image and fresh mode: only project dir persists (.claude is ephemeral)
  // Other images: both project and .claude persist
  const persistentPaths = (options.fresh || isBaseImage)
    ? `/ccbox/${dirName}`
    : `/ccbox/${dirName}, /ccbox/.claude`;
  cmd.push("-e", `CCBOX_PERSISTENT_PATHS=${persistentPaths}`);

  // LD_PRELOAD path mapping: host paths -> container paths
  // This enables transparent path translation for config files with absolute host paths
  // Maps both project directory and .claude config for full host compatibility
  const pathMappings: string[] = [];

  // Always map project directory
  pathMappings.push(`${dockerProjectPath}:/ccbox/${dirName}`);

  // Map .claude config (unless fresh/base image mode)
  if (!options.fresh && !isBaseImage) {
    const normalizedClaudePath = claudeConfig.replace(/\\/g, "/");
    pathMappings.push(`${normalizedClaudePath}:/ccbox/.claude`);
  }

  if (pathMappings.length > 0) {
    cmd.push("-e", `CCBOX_PATH_MAP=${pathMappings.join(";")}`);
  }

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

/**
 * Add minimal mounts for vanilla Claude Code experience.
 * Used for base image and --fresh mode.
 * Only mounts auth + settings files - no plugins/rules/commands.
 */
function addMinimalMounts(cmd: string[], claudeConfig: string): void {
  const [uid, gid] = getHostUserIds();

  // Ephemeral .claude directory (tmpfs, lost on container exit)
  cmd.push("--tmpfs", `/ccbox/.claude:rw,size=64m,uid=${uid},gid=${gid},mode=0755`);

  // Mount only essential files for auth and preferences
  const essentialFiles = [".credentials.json", "settings.json", "settings.local.json"];
  for (const f of essentialFiles) {
    const hostFile = join(claudeConfig, f);
    if (existsSync(hostFile)) {
      const dockerPath = resolveForDocker(hostFile);
      cmd.push("-v", `${dockerPath}:/ccbox/.claude/${f}:rw`);
    }
  }

  // Signal minimal mount mode
  cmd.push("-e", "CCBOX_MINIMAL_MOUNT=1");
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
  // Pass UID/GID as environment variables instead of --user flag
  // Container starts as root for setup, then drops to non-root user via gosu
  cmd.push("-e", `CCBOX_UID=${uid}`);
  cmd.push("-e", `CCBOX_GID=${gid}`);
}

function addSecurityOptions(cmd: string[]): void {
  const { capDrop, pidsLimit } = CONTAINER_CONSTRAINTS;
  cmd.push(
    `--cap-drop=${capDrop}`,
    // Minimal capabilities for user switching, file ownership, and FUSE
    "--cap-add=SETUID",     // gosu: change user ID
    "--cap-add=SETGID",     // gosu: change group ID
    "--cap-add=CHOWN",      // entrypoint: change file ownership
    "--cap-add=SYS_ADMIN",  // FUSE: mount filesystem in userspace
    `--pids-limit=${pidsLimit}`,
    "--init",
    "--shm-size=256m",
    "--ulimit",
    "nofile=65535:65535",
    "--memory-swappiness=0"
  );
}


function addDnsOptions(cmd: string[]): void {
  cmd.push("--dns-opt", "ndots:1", "--dns-opt", "timeout:1", "--dns-opt", "attempts:1");
}


function addClaudeEnv(cmd: string[]): void {
  const tz = getHostTimezone();
  cmd.push("-e", `TZ=${tz}`);

  cmd.push(
    "-e",
    "FORCE_COLOR=1",
    // Claude Code configuration (CLAUDE_CONFIG_DIR set in generateRunCommand)
    "-e",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1",
    "-e",
    "CLAUDE_CODE_HIDE_ACCOUNT_INFO=1",
    "-e",
    "CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL=1",
    "-e",
    "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=85",
    "-e",
    "CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR=1",
    "-e",
    "FORCE_AUTOUPDATE_PLUGINS=true",
    "-e",
    "DISABLE_AUTOUPDATER=0",
    // Runtime configuration
    "-e",
    "PYTHONUNBUFFERED=1",
    // Bun runtime settings (Claude Code uses Bun)
    "-e",
    "DO_NOT_TRACK=1",  // Disable Bun telemetry/crash reports
    "-e",
    "BUN_RUNTIME_TRANSPILER_CACHE_PATH=0"  // Disable cache (Docker ephemeral filesystem)
  );
}

