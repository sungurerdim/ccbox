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

// Common system packages (minimal - matches original)
const COMMON_TOOLS = `
# Create ccbox user (uid 1000) with home at /ccbox
RUN groupadd -g 1000 ccbox 2>/dev/null || true && \\
    useradd -m -d /ccbox -s /bin/bash -u 1000 -g 1000 ccbox 2>/dev/null || true

# System packages (minimal but complete)
RUN apt-get update && apt-get install -y --no-install-recommends \\
    git curl ca-certificates bash gcc libc6-dev \\
    python3 python3-pip python3-venv python-is-python3 \\
    ripgrep jq procps openssh-client locales \\
    fd-find gh gosu fuse3 libfuse3-dev pkg-config \\
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

// LD_PRELOAD path mapping library and FUSE filesystem build
const PATH_MAP_BUILD = `
# Build LD_PRELOAD path mapping library (host path -> container path translation)
COPY pathmap.c /tmp/pathmap.c
RUN gcc -shared -fPIC -O2 -o /usr/local/lib/ccbox-pathmap.so /tmp/pathmap.c -ldl \\
    && rm /tmp/pathmap.c

# Build FUSE filesystem for cross-platform path transformation
# FUSE intercepts ALL file operations (including io_uring) at kernel level
COPY ccbox-fuse.c /tmp/ccbox-fuse.c
RUN gcc -Wall -O2 -o /usr/local/bin/ccbox-fuse /tmp/ccbox-fuse.c $(pkg-config fuse3 --cflags --libs) \\
    && rm /tmp/ccbox-fuse.c \\
    && chmod 755 /usr/local/bin/ccbox-fuse \\
    # Enable FUSE allow_other for non-root user access (required for gosu privilege drop)
    && echo 'user_allow_other' >> /etc/fuse.conf
`;

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
${PATH_MAP_BUILD}
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
${PATH_MAP_BUILD}
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
${PATH_MAP_BUILD}
${CLAUDE_CODE_INSTALL}
# Rust tools (clippy + rustfmt)
RUN rustup component add clippy rustfmt
${ENTRYPOINT_SETUP}
`;
}

function javaDockerfile(): string {
  return `# syntax=docker/dockerfile:1
# ccbox/java - Java (Temurin LTS) + Claude Code + Maven
FROM eclipse-temurin:latest

LABEL org.opencontainers.image.title="ccbox/java"

# Timezone passthrough from host
ARG TZ=UTC
ENV TZ="\${TZ}"

ENV DEBIAN_FRONTEND=noninteractive
${COMMON_TOOLS}
${PATH_MAP_BUILD}
${CLAUDE_CODE_INSTALL}
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
# ccbox/web - Node.js + TypeScript + test tools (fullstack)
FROM ccbox/base

LABEL org.opencontainers.image.title="ccbox/web"

# Node.js LTS (for npm-based projects)
RUN curl -fsSL https://deb.nodesource.com/setup_lts.x | bash - \\
    && apt-get install -y --no-install-recommends nodejs \\
    && rm -rf /var/lib/apt/lists/*

# pnpm (via corepack)
RUN corepack enable && corepack prepare pnpm@latest --activate

# Node.js/TypeScript dev tools (typescript, eslint, vitest)
RUN npm install -g typescript eslint vitest @types/node \\
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
# ccbox/dotnet - .NET SDK
FROM ccbox/base

LABEL org.opencontainers.image.title="ccbox/dotnet"

# .NET SDK (latest LTS)
RUN curl -fsSL https://dot.net/v1/dotnet-install.sh | bash -s -- --channel LTS --install-dir /usr/share/dotnet \\
    && ln -s /usr/share/dotnet/dotnet /usr/local/bin/dotnet
ENV DOTNET_ROOT=/usr/share/dotnet
ENV DOTNET_CLI_TELEMETRY_OPTOUT=1
`;
}

function swiftDockerfile(): string {
  return `# syntax=docker/dockerfile:1
# ccbox/swift - Swift
FROM ccbox/base

LABEL org.opencontainers.image.title="ccbox/swift"

# Swift (official release)
RUN SWIFT_ARCH=\$(dpkg --print-architecture | sed 's/amd64/x86_64/;s/arm64/aarch64/') \\
    && SWIFT_VER=\$(curl -sfL https://api.github.com/repos/swiftlang/swift/releases/latest | jq -r .tag_name | sed 's/swift-//;s/-RELEASE//') \\
    && curl -fsSL "https://download.swift.org/swift-\${SWIFT_VER}-release/ubuntu2204/swift-\${SWIFT_VER}-RELEASE/swift-\${SWIFT_VER}-RELEASE-ubuntu22.04.tar.gz" | tar -xz -C /opt \\
    && ln -s /opt/swift-\${SWIFT_VER}-RELEASE-ubuntu22.04/usr/bin/swift /usr/local/bin/swift \\
    && ln -s /opt/swift-\${SWIFT_VER}-RELEASE-ubuntu22.04/usr/bin/swiftc /usr/local/bin/swiftc
`;
}

function dartDockerfile(): string {
  return `# syntax=docker/dockerfile:1
# ccbox/dart - Dart + Flutter CLI
FROM ccbox/base

LABEL org.opencontainers.image.title="ccbox/dart"

# Dart SDK
RUN DART_ARCH=\$(dpkg --print-architecture) \\
    && curl -fsSL "https://storage.googleapis.com/dart-archive/channels/stable/release/latest/sdk/dartsdk-linux-\${DART_ARCH}-release.zip" -o /tmp/dart.zip \\
    && unzip -q /tmp/dart.zip -d /opt && rm /tmp/dart.zip
ENV PATH="/opt/dart-sdk/bin:$PATH"
`;
}

function luaDockerfile(): string {
  return `# syntax=docker/dockerfile:1
# ccbox/lua - Lua + LuaRocks
FROM ccbox/base

LABEL org.opencontainers.image.title="ccbox/lua"

# Lua + LuaRocks
RUN apt-get update && apt-get install -y --no-install-recommends \\
    lua5.4 liblua5.4-dev luarocks \\
    && rm -rf /var/lib/apt/lists/*
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
# ccbox/scripting - Ruby + PHP + Perl (web backends)
FROM ccbox/base

LABEL org.opencontainers.image.title="ccbox/scripting"

# Ruby + Bundler
RUN apt-get update && apt-get install -y --no-install-recommends \\
    ruby ruby-dev ruby-bundler \\
    && rm -rf /var/lib/apt/lists/* \\
    && gem install bundler --no-document

# PHP + common extensions + Composer
RUN apt-get update && apt-get install -y --no-install-recommends \\
    php php-cli php-common php-curl php-json php-mbstring php-xml php-zip \\
    && rm -rf /var/lib/apt/lists/* \\
    && curl -sS https://getcomposer.org/installer | php -- --install-dir=/usr/local/bin --filename=composer

# Perl + cpanminus
RUN apt-get update && apt-get install -y --no-install-recommends \\
    perl cpanminus liblocal-lib-perl \\
    && rm -rf /var/lib/apt/lists/*
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

# ══════════════════════════════════════════════════════════════════════════════
# FUSE Filesystem Setup (must run as root)
# FUSE provides kernel-level path transformation that works with io_uring
# This is required because Bun runtime uses io_uring which bypasses LD_PRELOAD
# ══════════════════════════════════════════════════════════════════════════════
if [[ -n "$CCBOX_FUSE_SOURCE" && -n "$CCBOX_FUSE_TARGET" ]]; then
    if [[ "$(id -u)" != "0" ]]; then
        _die "FUSE mount requires root privileges. Container must start as root."
    fi

    _log "Setting up FUSE filesystem..."
    _log_verbose "Source: $CCBOX_FUSE_SOURCE"
    _log_verbose "Target: $CCBOX_FUSE_TARGET"

    # Create target directory (must exist before FUSE mount)
    mkdir -p "$CCBOX_FUSE_TARGET"
    if [[ ! -d "$CCBOX_FUSE_TARGET" ]]; then
        _die "Failed to create mount point: $CCBOX_FUSE_TARGET"
    fi
    _log_verbose "Created mount point: $CCBOX_FUSE_TARGET"

    # Build pathmap argument from CCBOX_PATH_MAP
    FUSE_PATHMAP=""
    if [[ -n "$CCBOX_PATH_MAP" ]]; then
        FUSE_PATHMAP="$CCBOX_PATH_MAP"
        _log_verbose "Path mappings: $FUSE_PATHMAP"
    fi

    # Mount FUSE filesystem with allow_other and uid/gid override for non-root user access
    if [[ -x "/usr/local/bin/ccbox-fuse" ]]; then
        # Build FUSE options - uid/gid override makes files appear owned by container user
        FUSE_OPTS="source=$CCBOX_FUSE_SOURCE,allow_other"
        if [[ -n "$CCBOX_UID" ]]; then
            FUSE_OPTS="$FUSE_OPTS,uid=$CCBOX_UID"
        fi
        if [[ -n "$CCBOX_GID" ]]; then
            FUSE_OPTS="$FUSE_OPTS,gid=$CCBOX_GID"
        fi
        if [[ -n "$FUSE_PATHMAP" ]]; then
            FUSE_OPTS="$FUSE_OPTS,pathmap=$FUSE_PATHMAP"
        fi

        /usr/local/bin/ccbox-fuse -o "$FUSE_OPTS" "$CCBOX_FUSE_TARGET" &
        FUSE_PID=$!
        sleep 0.5  # Wait for FUSE to initialize

        # Verify mount
        if mountpoint -q "$CCBOX_FUSE_TARGET" 2>/dev/null; then
            _log "FUSE mounted at $CCBOX_FUSE_TARGET (PID: $FUSE_PID)"
        else
            _die "FUSE mount failed at $CCBOX_FUSE_TARGET"
        fi
    else
        _log "ccbox-fuse not found, falling back to direct mount"
        # Fallback: bind mount without transformation
        mount --bind "$CCBOX_FUSE_SOURCE" "$CCBOX_FUSE_TARGET" || true
    fi

    # Set ownership for non-root user (only the mount point, not recursively through FUSE)
    # FUSE provides access via allow_other option - don't chown host files through FUSE
    if [[ -n "$CCBOX_UID" && -n "$CCBOX_GID" ]]; then
        chown "$CCBOX_UID:$CCBOX_GID" /ccbox 2>/dev/null || true
        chown "$CCBOX_UID:$CCBOX_GID" "$CCBOX_FUSE_TARGET" 2>/dev/null || true
    fi

    # Debug: Test FUSE write permissions
    if [[ "$CCBOX_DEBUG" -ge 2 ]]; then
        _log_verbose "Testing FUSE write permissions..."
        # Test as root
        if echo "root-test" > "$CCBOX_FUSE_TARGET/.ccbox-write-test" 2>/dev/null; then
            _log_verbose "Root write to FUSE: OK"
            rm -f "$CCBOX_FUSE_TARGET/.ccbox-write-test"
        else
            _log_verbose "Root write to FUSE: FAILED"
        fi
        # Test as target user
        if gosu $CCBOX_UID:$CCBOX_GID touch "$CCBOX_FUSE_TARGET/.ccbox-user-test" 2>/dev/null; then
            _log_verbose "User write to FUSE: OK"
            gosu $CCBOX_UID:$CCBOX_GID rm -f "$CCBOX_FUSE_TARGET/.ccbox-user-test" 2>/dev/null
        else
            _log_verbose "User write to FUSE: FAILED (errno: $?)"
            _log_verbose "FUSE target permissions: $(ls -la $CCBOX_FUSE_TARGET 2>&1 | head -3)"
            _log_verbose "Source mount permissions: $(ls -la /mnt/host-claude 2>&1 | head -3)"
        fi
    fi
fi

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
fi

# ══════════════════════════════════════════════════════════════════════════════
# Cross-platform path compatibility (additional layers)
# 1. LD_PRELOAD: intercepts syscalls and normalizes backslashes to forward slashes
# 2. Symlinks: creates Windows-style path structure (e.g., /c/Users/... -> /ccbox/...)
# 3. Node.js preload: monkey-patches path.isAbsolute() to recognize Windows paths
# 4. Orphan cleanup: removes .orphaned_at markers that prevent plugin loading
# This ensures Claude Code tools work with paths stored in JSON configs (plugins, etc.)
# ══════════════════════════════════════════════════════════════════════════════
if [[ -n "$CCBOX_PATH_MAP" ]]; then
    # Layer 1: LD_PRELOAD for syscall interception
    if [[ -f "/usr/local/lib/ccbox-pathmap.so" ]]; then
        export LD_PRELOAD="/usr/local/lib/ccbox-pathmap.so"
        _log "Path mapping active: $CCBOX_PATH_MAP"
        _log_verbose "LD_PRELOAD: $LD_PRELOAD"
    fi

    # Layer 2: Node.js preload for Windows path compatibility
    # Patches path and fs modules to transform Windows paths to container paths
    PRELOAD_SCRIPT="/tmp/ccbox-path-preload.js"
    cat > "\$PRELOAD_SCRIPT" << 'PRELOAD_EOF'
// ccbox path compatibility preload
// Transforms Windows paths (C:/...) to container paths (/ccbox/.claude/...)
(function() {
    const path = require('path');
    const fs = require('fs');

    // Build path mappings from CCBOX_PATH_MAP
    const pathMappings = [];
    (process.env.CCBOX_PATH_MAP || '').split(';').forEach(mapping => {
        const match = mapping.match(/^([A-Za-z]):(.*):(\/.*)$/);
        if (match) {
            pathMappings.push({
                pattern: new RegExp('^' + match[1] + ':' + match[2].replace(/\//g, '[\\\\/]'), 'i'),
                target: match[3]
            });
        }
    });

    // Transform Windows path to container path
    function transformPath(p) {
        if (typeof p !== 'string') return p;
        const normalized = p.replace(/\\\\/g, '/');
        for (const m of pathMappings) {
            if (m.pattern.test(normalized)) {
                return normalized.replace(m.pattern, m.target);
            }
        }
        return p;
    }

    // Patch path module
    const origIsAbsolute = path.isAbsolute;
    path.isAbsolute = p => (typeof p === 'string' && /^[A-Za-z]:[\\\\/]/.test(p)) || origIsAbsolute(p);

    const origResolve = path.resolve;
    path.resolve = (...args) => origResolve(...args.map(transformPath));

    const origNormalize = path.normalize;
    path.normalize = p => origNormalize(transformPath(p));

    const origJoin = path.join;
    path.join = (...args) => origJoin(...args.map(transformPath));

    // Patch fs module - wrap functions that take path as first argument
    const fsFuncs = [
        'access', 'appendFile', 'chmod', 'chown', 'copyFile', 'lchmod', 'lchown',
        'lutimes', 'link', 'lstat', 'mkdir', 'mkdtemp', 'open', 'opendir',
        'readdir', 'readFile', 'readlink', 'realpath', 'rename', 'rm', 'rmdir',
        'stat', 'symlink', 'truncate', 'unlink', 'utimes', 'writeFile',
        'accessSync', 'appendFileSync', 'chmodSync', 'chownSync', 'copyFileSync',
        'lchmodSync', 'lchownSync', 'lutimesSync', 'linkSync', 'lstatSync',
        'mkdirSync', 'mkdtempSync', 'openSync', 'opendirSync', 'readdirSync',
        'readFileSync', 'readlinkSync', 'realpathSync', 'renameSync', 'rmSync',
        'rmdirSync', 'statSync', 'symlinkSync', 'truncateSync', 'unlinkSync',
        'utimesSync', 'writeFileSync', 'existsSync', 'exists'
    ];

    fsFuncs.forEach(name => {
        if (typeof fs[name] === 'function') {
            const orig = fs[name];
            fs[name] = function(p, ...rest) {
                return orig.call(this, transformPath(p), ...rest);
            };
        }
    });

    // Handle fs.promises
    if (fs.promises) {
        const promiseFuncs = [
            'access', 'appendFile', 'chmod', 'chown', 'copyFile', 'lchmod',
            'lchown', 'lutimes', 'link', 'lstat', 'mkdir', 'mkdtemp', 'open',
            'opendir', 'readdir', 'readFile', 'readlink', 'realpath', 'rename',
            'rm', 'rmdir', 'stat', 'symlink', 'truncate', 'unlink', 'utimes',
            'writeFile'
        ];
        promiseFuncs.forEach(name => {
            if (typeof fs.promises[name] === 'function') {
                const orig = fs.promises[name];
                fs.promises[name] = function(p, ...rest) {
                    return orig.call(this, transformPath(p), ...rest);
                };
            }
        });
    }
})();
PRELOAD_EOF
    chmod 644 "\$PRELOAD_SCRIPT"
    export NODE_OPTIONS="\${NODE_OPTIONS:-} --require=\$PRELOAD_SCRIPT"
    _log_verbose "Node.js path preload: \$PRELOAD_SCRIPT"

    # Layer 3: Clean orphaned plugin markers
    # Claude Code marks plugins as "orphaned" for cleanup, but these markers
    # persist on host and prevent plugins from loading in containers.
    # Remove .orphaned_at files to restore plugin functionality.
    if [[ -d "/ccbox/.claude/plugins/cache" ]]; then
        _orphan_count=$(find /ccbox/.claude/plugins/cache -name ".orphaned_at" -type f 2>/dev/null | wc -l)
        if [[ "$_orphan_count" -gt 0 ]]; then
            find /ccbox/.claude/plugins/cache -name ".orphaned_at" -type f -exec rm -f {} + 2>/dev/null || true
            _log "Cleaned $_orphan_count orphaned plugin marker(s)"
        fi
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
mkdir -p /ccbox/.cache/node-compile 2>/dev/null || true
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
 * Generate pathmap.c content for LD_PRELOAD path mapping library.
 * This is embedded for compiled binary compatibility.
 */
function generatePathmapC(): string {
  return `/**
 * ccbox-pathmap: LD_PRELOAD path mapping library
 * Intercepts filesystem calls and transparently maps host paths to container paths.
 * Supports both modern (statx, *at syscalls) and legacy (stat64, __xstat) interfaces.
 * Compile: gcc -shared -fPIC -O2 -o ccbox-pathmap.so pathmap.c -ldl
 */
#define _GNU_SOURCE
// Note: We don't define _FILE_OFFSET_BITS=64 to allow explicit 64-bit function interception
// Applications using LFS will call the 64-bit versions which we intercept separately

#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/statfs.h>
#include <sys/statvfs.h>
#include <dirent.h>
#include <unistd.h>
#include <pthread.h>
#include <ftw.h>
#include <glob.h>
#include <wordexp.h>
#include <libgen.h>
#include <limits.h>
#include <utime.h>
#include <sys/time.h>
#include <sys/xattr.h>

// Forward declare statx for older systems
#ifndef STATX_BASIC_STATS
struct statx;
#endif

#define MAX_MAPPINGS 16
#define MAX_PATH_LEN 4096

typedef struct { char *from; char *to; size_t from_len; size_t to_len; } PathMapping;
static PathMapping g_mappings[MAX_MAPPINGS];
static int g_mapping_count = 0;
static int g_initialized = 0;
static pthread_once_t g_init_once = PTHREAD_ONCE_INIT;
static __thread char g_path_buf[MAX_PATH_LEN];
static __thread char g_path_buf2[MAX_PATH_LEN];

static void normalize_path(char *path) { for (char *p = path; *p; p++) if (*p == '\\\\') *p = '/'; }

static int path_prefix_matches(const char *prefix, size_t prefix_len, const char *path) {
    if (strncmp(prefix, path, prefix_len) != 0) return 0;
    char next = path[prefix_len];
    return (next == '\\0' || next == '/');
}

static void parse_mappings(void) {
    const char *env = getenv("CCBOX_PATH_MAP");
    if (!env || !*env) return;
    char *env_copy = strdup(env);
    if (!env_copy) return;
    char *saveptr = NULL;
    char *mapping = strtok_r(env_copy, ";", &saveptr);
    while (mapping && g_mapping_count < MAX_MAPPINGS) {
        char *sep = NULL;
        if (mapping[0] && mapping[1] == ':' && (mapping[2] == '/' || mapping[2] == '\\\\'))
            sep = strchr(mapping + 2, ':');
        else sep = strchr(mapping, ':');
        if (sep) {
            *sep = '\\0';
            char *from = mapping, *to = sep + 1;
            if (*from && *to) {
                PathMapping *m = &g_mappings[g_mapping_count];
                m->from = strdup(from); m->to = strdup(to);
                if (m->from && m->to) {
                    normalize_path(m->from);
                    m->from_len = strlen(m->from);
                    while (m->from_len > 1 && m->from[m->from_len - 1] == '/') m->from[--m->from_len] = '\\0';
                    m->to_len = strlen(m->to);
                    while (m->to_len > 1 && m->to[m->to_len - 1] == '/') m->to[--m->to_len] = '\\0';
                    g_mapping_count++;
                }
            }
        }
        mapping = strtok_r(NULL, ";", &saveptr);
    }
    free(env_copy);
}

static void do_init(void) { if (g_initialized) return; g_initialized = 1; parse_mappings(); }
__attribute__((constructor)) static void pathmap_init(void) { pthread_once(&g_init_once, do_init); }
static inline void ensure_init(void) { if (__builtin_expect(!g_initialized, 0)) pthread_once(&g_init_once, do_init); }

static const char *transform_path_buf(const char *path, char *buf, size_t bufsize) {
    if (!path || !*path) return path;
    ensure_init();
    if (g_mapping_count == 0) return path;
    size_t path_len = strlen(path);
    if (path_len >= bufsize - 1) return path;
    char normalized[MAX_PATH_LEN];
    memcpy(normalized, path, path_len + 1);
    normalize_path(normalized);
    for (int i = 0; i < g_mapping_count; i++) {
        PathMapping *m = &g_mappings[i];
        if (path_prefix_matches(m->from, m->from_len, normalized)) {
            const char *suffix = normalized + m->from_len;
            size_t suffix_len = strlen(suffix);
            if (m->to_len + suffix_len >= bufsize) return path;
            memcpy(buf, m->to, m->to_len);
            memcpy(buf + m->to_len, suffix, suffix_len + 1);
            return buf;
        }
    }
    if (memchr(path, '\\\\', path_len)) { memcpy(buf, normalized, path_len + 1); return buf; }
    return path;
}

static const char *transform_path(const char *path) { return transform_path_buf(path, g_path_buf, sizeof(g_path_buf)); }
static const char *transform_path2(const char *path) { return transform_path_buf(path, g_path_buf2, sizeof(g_path_buf2)); }

#define ORIG_FUNC(ret, name, ...) \\
    static ret (*orig_##name)(__VA_ARGS__) = NULL; \\
    static inline ret (*get_orig_##name(void))(__VA_ARGS__) { \\
        if (__builtin_expect(!orig_##name, 0)) orig_##name = dlsym(RTLD_NEXT, #name); \\
        return orig_##name; \\
    }

// ═══════════════════════════════════════════════════════════════════════════
// Core filesystem functions
// ═══════════════════════════════════════════════════════════════════════════
ORIG_FUNC(int, open, const char *, int, ...)
ORIG_FUNC(int, open64, const char *, int, ...)
ORIG_FUNC(int, openat, int, const char *, int, ...)
ORIG_FUNC(int, openat64, int, const char *, int, ...)
ORIG_FUNC(int, creat, const char *, mode_t)
ORIG_FUNC(int, creat64, const char *, mode_t)
ORIG_FUNC(FILE *, fopen, const char *, const char *)
ORIG_FUNC(FILE *, fopen64, const char *, const char *)
ORIG_FUNC(FILE *, freopen, const char *, const char *, FILE *)
ORIG_FUNC(FILE *, freopen64, const char *, const char *, FILE *)
ORIG_FUNC(int, stat, const char *, struct stat *)
ORIG_FUNC(int, stat64, const char *, struct stat64 *)
ORIG_FUNC(int, lstat, const char *, struct stat *)
ORIG_FUNC(int, lstat64, const char *, struct stat64 *)
ORIG_FUNC(int, access, const char *, int)
ORIG_FUNC(int, euidaccess, const char *, int)
ORIG_FUNC(int, eaccess, const char *, int)
ORIG_FUNC(DIR *, opendir, const char *)
ORIG_FUNC(int, mkdir, const char *, mode_t)
ORIG_FUNC(int, rmdir, const char *)
ORIG_FUNC(int, chdir, const char *)
ORIG_FUNC(int, unlink, const char *)
ORIG_FUNC(int, remove, const char *)
ORIG_FUNC(int, rename, const char *, const char *)
ORIG_FUNC(int, chmod, const char *, mode_t)
ORIG_FUNC(int, chown, const char *, uid_t, gid_t)
ORIG_FUNC(int, lchown, const char *, uid_t, gid_t)
ORIG_FUNC(int, truncate, const char *, off_t)
ORIG_FUNC(int, truncate64, const char *, off64_t)
ORIG_FUNC(char *, realpath, const char *, char *)
ORIG_FUNC(char *, canonicalize_file_name, const char *)
ORIG_FUNC(ssize_t, readlink, const char *, char *, size_t)
ORIG_FUNC(int, symlink, const char *, const char *)
ORIG_FUNC(int, link, const char *, const char *)
ORIG_FUNC(int, mknod, const char *, mode_t, dev_t)
ORIG_FUNC(int, mkfifo, const char *, mode_t)
ORIG_FUNC(int, chroot, const char *)
ORIG_FUNC(int, utime, const char *, const struct utimbuf *)
ORIG_FUNC(int, utimes, const char *, const struct timeval *)
ORIG_FUNC(int, lutimes, const char *, const struct timeval *)
ORIG_FUNC(int, statfs, const char *, struct statfs *)
ORIG_FUNC(int, statfs64, const char *, struct statfs64 *)
ORIG_FUNC(int, statvfs, const char *, struct statvfs *)
ORIG_FUNC(int, statvfs64, const char *, struct statvfs64 *)
ORIG_FUNC(long, pathconf, const char *, int)
ORIG_FUNC(int, setxattr, const char *, const char *, const void *, size_t, int)
ORIG_FUNC(int, lsetxattr, const char *, const char *, const void *, size_t, int)
ORIG_FUNC(ssize_t, getxattr, const char *, const char *, void *, size_t)
ORIG_FUNC(ssize_t, lgetxattr, const char *, const char *, void *, size_t)
ORIG_FUNC(ssize_t, listxattr, const char *, char *, size_t)
ORIG_FUNC(ssize_t, llistxattr, const char *, char *, size_t)
ORIG_FUNC(int, removexattr, const char *, const char *)
ORIG_FUNC(int, lremovexattr, const char *, const char *)

// ═══════════════════════════════════════════════════════════════════════════
// Modern *at() syscalls (Linux 2.6.16+)
// ═══════════════════════════════════════════════════════════════════════════
ORIG_FUNC(int, faccessat, int, const char *, int, int)
ORIG_FUNC(int, fstatat, int, const char *, struct stat *, int)
ORIG_FUNC(int, fstatat64, int, const char *, struct stat64 *, int)
ORIG_FUNC(int, unlinkat, int, const char *, int)
ORIG_FUNC(int, mkdirat, int, const char *, mode_t)
ORIG_FUNC(int, mknodat, int, const char *, mode_t, dev_t)
ORIG_FUNC(int, mkfifoat, int, const char *, mode_t)
ORIG_FUNC(int, renameat, int, const char *, int, const char *)
ORIG_FUNC(int, renameat2, int, const char *, int, const char *, unsigned int)
ORIG_FUNC(int, linkat, int, const char *, int, const char *, int)
ORIG_FUNC(int, symlinkat, const char *, int, const char *)
ORIG_FUNC(ssize_t, readlinkat, int, const char *, char *, size_t)
ORIG_FUNC(int, fchmodat, int, const char *, mode_t, int)
ORIG_FUNC(int, fchownat, int, const char *, uid_t, gid_t, int)
ORIG_FUNC(int, utimensat, int, const char *, const struct timespec *, int)
ORIG_FUNC(int, futimesat, int, const char *, const struct timeval *)

// ═══════════════════════════════════════════════════════════════════════════
// glibc internal stat wrappers (older glibc < 2.33)
// ═══════════════════════════════════════════════════════════════════════════
ORIG_FUNC(int, __xstat, int, const char *, struct stat *)
ORIG_FUNC(int, __lxstat, int, const char *, struct stat *)
ORIG_FUNC(int, __xstat64, int, const char *, struct stat64 *)
ORIG_FUNC(int, __lxstat64, int, const char *, struct stat64 *)
ORIG_FUNC(int, __fxstatat, int, int, const char *, struct stat *, int)
ORIG_FUNC(int, __fxstatat64, int, int, const char *, struct stat64 *, int)

// ═══════════════════════════════════════════════════════════════════════════
// statx (Linux 4.11+, glibc 2.28+) - modern stat replacement
// ═══════════════════════════════════════════════════════════════════════════
ORIG_FUNC(int, statx, int, const char *, int, unsigned int, struct statx *)

// ═══════════════════════════════════════════════════════════════════════════
// Exec and process functions
// ═══════════════════════════════════════════════════════════════════════════
ORIG_FUNC(int, execve, const char *, char *const[], char *const[])
ORIG_FUNC(int, execv, const char *, char *const[])
ORIG_FUNC(int, execvp, const char *, char *const[])
ORIG_FUNC(int, execvpe, const char *, char *const[], char *const[])
ORIG_FUNC(int, execl, const char *, const char *, ...)
ORIG_FUNC(int, execlp, const char *, const char *, ...)
ORIG_FUNC(int, execle, const char *, const char *, ...)

// ═══════════════════════════════════════════════════════════════════════════
// Directory scanning functions
// Note: scandir64 has different callback signatures (dirent64 vs dirent), so we only intercept scandir
// ═══════════════════════════════════════════════════════════════════════════
typedef int (*scandir_filter_t)(const struct dirent *);
typedef int (*scandir_compar_t)(const struct dirent **, const struct dirent **);
ORIG_FUNC(int, scandir, const char *, struct dirent ***, scandir_filter_t, scandir_compar_t)

// File tree walk (ftw/nftw) - function pointer callbacks not easily interceptable
// but we can still intercept the initial path
// Note: We only intercept non-64 versions because 64-bit versions have different callback signatures
typedef int (*ftw_fn_t)(const char *, const struct stat *, int);
typedef int (*nftw_fn_t)(const char *, const struct stat *, int, struct FTW *);
ORIG_FUNC(int, ftw, const char *, ftw_fn_t, int)
ORIG_FUNC(int, nftw, const char *, nftw_fn_t, int, int)

// ═══════════════════════════════════════════════════════════════════════════
// Dynamic linking
// ═══════════════════════════════════════════════════════════════════════════
ORIG_FUNC(void *, dlopen, const char *, int)

// ═══════════════════════════════════════════════════════════════════════════
// JSON content transformation for plugin config files
// Intercepts read() to transform Windows paths at runtime (no file modification)
// ═══════════════════════════════════════════════════════════════════════════
#define MAX_FD_TRACK 1024
static char *g_fd_paths[MAX_FD_TRACK];
static pthread_mutex_t g_fd_mutex = PTHREAD_MUTEX_INITIALIZER;

// Debug mode - set CCBOX_PATHMAP_DEBUG=1 to enable verbose logging
static int debug_enabled(void) {
    static int cached = -1;
    if (cached < 0) cached = getenv("CCBOX_PATHMAP_DEBUG") != NULL;
    return cached;
}
#define DEBUG_LOG(fmt, ...) do { if (debug_enabled()) fprintf(stderr, "[pathmap] " fmt "\\n", ##__VA_ARGS__); } while(0)

// Check if file needs path transformation
// Transform all JSON files under .claude directory to support future config files
static int needs_path_transform(const char *path) {
    if (!path) return 0;
    // Check if path is under .claude directory and is a JSON file
    const char *claude_dir = strstr(path, ".claude");
    if (!claude_dir) return 0;
    // Check for .json extension
    size_t len = strlen(path);
    if (len < 5) return 0;
    return strcmp(path + len - 5, ".json") == 0;
}

static void track_fd(int fd, const char *path) {
    if (fd < 0 || fd >= MAX_FD_TRACK) return;
    pthread_mutex_lock(&g_fd_mutex);
    if (g_fd_paths[fd]) { free(g_fd_paths[fd]); g_fd_paths[fd] = NULL; }
    if (needs_path_transform(path)) {
        g_fd_paths[fd] = strdup(path);
    }
    pthread_mutex_unlock(&g_fd_mutex);
}

static void untrack_fd(int fd) {
    if (fd < 0 || fd >= MAX_FD_TRACK) return;
    pthread_mutex_lock(&g_fd_mutex);
    if (g_fd_paths[fd]) { free(g_fd_paths[fd]); g_fd_paths[fd] = NULL; }
    pthread_mutex_unlock(&g_fd_mutex);
}

static int is_tracked_fd(int fd) {
    if (fd < 0 || fd >= MAX_FD_TRACK) return 0;
    pthread_mutex_lock(&g_fd_mutex);
    int result = g_fd_paths[fd] != NULL;
    pthread_mutex_unlock(&g_fd_mutex);
    return result;
}

// Transform Windows paths in JSON: C:\\\\Users\\\\... -> /ccbox/.claude/...
// Returns new length (may be shorter than original)
static ssize_t transform_json_paths(char *buf, ssize_t len) {
    if (!buf || len <= 0 || g_mapping_count == 0) {
        DEBUG_LOG("transform_json_paths: early return (buf=%p, len=%zd, g_mapping_count=%d)", buf, len, g_mapping_count);
        return len;
    }
    ensure_init();
    DEBUG_LOG("transform_json_paths: processing %zd bytes with %d mappings", len, g_mapping_count);
    for (int m = 0; m < g_mapping_count; m++) {
        DEBUG_LOG("  mapping[%d]: from='%s' to='%s'", m, g_mappings[m].from ? g_mappings[m].from : "(null)", g_mappings[m].to ? g_mappings[m].to : "(null)");
    }

    char *work = malloc(len * 2 + 1);
    if (!work) return len;

    size_t wi = 0;
    for (ssize_t i = 0; i < len && buf[i]; i++) {
        // Match Windows path: X:\\\\ (JSON-escaped backslashes)
        if (i + 3 < len &&
            ((buf[i] >= 'A' && buf[i] <= 'Z') || (buf[i] >= 'a' && buf[i] <= 'z')) &&
            buf[i+1] == ':' && buf[i+2] == '\\\\' && buf[i+3] == '\\\\') {

            char drive = buf[i] | 0x20;  // lowercase
            DEBUG_LOG("Found potential Windows path at pos %zd: '%c:%c%c' (drive=%c)", i, buf[i], buf[i+2], buf[i+3], drive);

            for (int m = 0; m < g_mapping_count; m++) {
                DEBUG_LOG("  checking mapping[%d]: from[0]='%c' vs drive='%c'", m, g_mappings[m].from ? g_mappings[m].from[0] : '?', drive);
                if (g_mappings[m].from && (g_mappings[m].from[0] | 0x20) == drive) {
                    DEBUG_LOG("  MATCH! Replacing prefix '%s' with: '%s'", g_mappings[m].from, g_mappings[m].to);
                    // Copy container target path
                    for (const char *t = g_mappings[m].to; *t && wi < (size_t)(len * 2); ) work[wi++] = *t++;
                    i += 2;  // Skip X:

                    // Skip the mapping prefix (e.g., \\\\Users\\\\Sungur\\\\.claude)
                    // from='C:/Users/Sungur/.claude' -> need to skip 'Users\\\\Sungur\\\\.claude'
                    const char *from_suffix = g_mappings[m].from + 2;  // Skip "X:"
                    if (*from_suffix == '/') from_suffix++;  // Skip leading /
                    DEBUG_LOG("  Skipping prefix suffix: '%s'", from_suffix);

                    // Skip the initial \\\\ in buffer (after X:)
                    if (i + 1 < len && buf[i] == '\\\\' && buf[i+1] == '\\\\') {
                        i += 2;
                        DEBUG_LOG("  Skipped initial \\\\\\\\ at pos %zd", i-2);
                    }

                    // Match and skip the prefix in the buffer (with \\\\ separators)
                    while (*from_suffix && i < len) {
                        if (*from_suffix == '/') {
                            // Expect \\\\ in buffer
                            if (i + 1 < len && buf[i] == '\\\\' && buf[i+1] == '\\\\') {
                                i += 2;
                                from_suffix++;
                            } else {
                                break;  // Mismatch
                            }
                        } else {
                            // Match regular character (case-insensitive)
                            if ((buf[i] | 0x20) == (*from_suffix | 0x20)) {
                                i++;
                                from_suffix++;
                            } else {
                                break;  // Mismatch
                            }
                        }
                    }
                    DEBUG_LOG("  After prefix skip, i=%zd, remaining from_suffix='%s'", i, from_suffix);

                    // Continue through remaining path: convert \\\\ to / and copy other chars
                    // Stop at JSON string terminators: " , } ] or whitespace
                    while (i < len && buf[i] != '"' && buf[i] != ',' && buf[i] != '}' && buf[i] != ']' && buf[i] != ' ' && buf[i] != '\\n' && buf[i] != '\\r' && buf[i] != '\\t') {
                        if (i + 1 < len && buf[i] == '\\\\' && buf[i+1] == '\\\\') {
                            work[wi++] = '/';
                            i += 2;
                        } else {
                            work[wi++] = buf[i++];
                        }
                    }
                    i--;  // Back up for outer loop increment
                    DEBUG_LOG("  After conversion, i=%zd, wi=%zu", i, wi);
                    goto next;
                }
            }
        }
        work[wi++] = buf[i];
        next:;
    }
    work[wi] = 0;
    DEBUG_LOG("transform done: wi=%zu, len=%zd, will_copy=%d", wi, len, (ssize_t)wi <= len);
    if ((ssize_t)wi <= len) {
        DEBUG_LOG("copying transformed result back to buffer");
        memcpy(buf, work, wi + 1);
        free(work);
        return (ssize_t)wi;
    } else {
        DEBUG_LOG("NOT copying - result too long!");
        free(work);
        return len;
    }
}

// Reverse transform: Linux paths -> Windows paths for writing back
// /ccbox/.claude/... -> C:\\\\Users\\\\...
static void reverse_transform_json_paths(char *buf, ssize_t *len) {
    if (!buf || !len || *len <= 0 || g_mapping_count == 0) return;
    ensure_init();

    // Find the longest target path for buffer sizing
    size_t max_expansion = 0;
    for (int m = 0; m < g_mapping_count; m++) {
        if (g_mappings[m].from && g_mappings[m].to) {
            size_t from_len = strlen(g_mappings[m].from);
            size_t to_len = strlen(g_mappings[m].to);
            if (from_len > to_len) max_expansion += from_len - to_len;
        }
    }

    char *work = malloc(*len * 3 + max_expansion * 100 + 1);
    if (!work) return;

    size_t wi = 0;
    for (ssize_t i = 0; i < *len && buf[i]; i++) {
        int matched = 0;
        // Check each mapping's target (Linux) path
        for (int m = 0; m < g_mapping_count && !matched; m++) {
            if (!g_mappings[m].to || !g_mappings[m].from) continue;
            size_t to_len = strlen(g_mappings[m].to);
            if (to_len == 0) continue;

            // Match Linux path at current position
            if (strncmp(&buf[i], g_mappings[m].to, to_len) == 0) {
                char drive = g_mappings[m].from[0];
                // Write Windows drive: X:\\\\
                work[wi++] = (drive >= 'a' && drive <= 'z') ? drive - 32 : drive;
                work[wi++] = ':';
                work[wi++] = '\\\\';
                work[wi++] = '\\\\';

                i += to_len;
                // Convert remaining / to \\\\ in path
                while (i < *len && buf[i] && buf[i] != '"' && buf[i] != ',' && buf[i] != '}') {
                    if (buf[i] == '/') {
                        work[wi++] = '\\\\';
                        work[wi++] = '\\\\';
                    } else {
                        work[wi++] = buf[i];
                    }
                    i++;
                }
                i--; // Back up for outer loop increment
                matched = 1;
            }
        }
        if (!matched) work[wi++] = buf[i];
    }
    work[wi] = 0;
    memcpy(buf, work, wi + 1);
    *len = (ssize_t)wi;
    free(work);
}

// ═══════════════════════════════════════════════════════════════════════════
// Write wrappers for reverse JSON path transformation
// ═══════════════════════════════════════════════════════════════════════════
ORIG_FUNC(ssize_t, write, int, const void *, size_t)
ssize_t write(int fd, const void *buf, size_t count) {
    if (is_tracked_fd(fd) && buf && count > 0) {
        char *copy = malloc(count * 3 + 1);
        if (copy) {
            memcpy(copy, buf, count);
            copy[count] = 0;
            ssize_t new_len = (ssize_t)count;
            reverse_transform_json_paths(copy, &new_len);
            ssize_t result = get_orig_write()(fd, copy, (size_t)new_len);
            free(copy);
            return result;
        }
    }
    return get_orig_write()(fd, buf, count);
}

ORIG_FUNC(ssize_t, pwrite, int, const void *, size_t, off_t)
ssize_t pwrite(int fd, const void *buf, size_t count, off_t offset) {
    if (is_tracked_fd(fd) && buf && count > 0) {
        char *copy = malloc(count * 3 + 1);
        if (copy) {
            memcpy(copy, buf, count);
            copy[count] = 0;
            ssize_t new_len = (ssize_t)count;
            reverse_transform_json_paths(copy, &new_len);
            ssize_t result = get_orig_pwrite()(fd, copy, (size_t)new_len, offset);
            free(copy);
            return result;
        }
    }
    return get_orig_pwrite()(fd, buf, count, offset);
}

ORIG_FUNC(ssize_t, pwrite64, int, const void *, size_t, off64_t)
ssize_t pwrite64(int fd, const void *buf, size_t count, off64_t offset) {
    if (is_tracked_fd(fd) && buf && count > 0) {
        char *copy = malloc(count * 3 + 1);
        if (copy) {
            memcpy(copy, buf, count);
            copy[count] = 0;
            ssize_t new_len = (ssize_t)count;
            reverse_transform_json_paths(copy, &new_len);
            ssize_t result = get_orig_pwrite64()(fd, copy, (size_t)new_len, offset);
            free(copy);
            return result;
        }
    }
    return get_orig_pwrite64()(fd, buf, count, offset);
}

// writev - scatter/gather write
ORIG_FUNC(ssize_t, writev, int, const struct iovec *, int)
ssize_t writev(int fd, const struct iovec *iov, int iovcnt) {
    if (is_tracked_fd(fd) && iov && iovcnt > 0) {
        struct iovec *new_iov = malloc(sizeof(struct iovec) * iovcnt);
        char **copies = malloc(sizeof(char *) * iovcnt);
        if (new_iov && copies) {
            for (int i = 0; i < iovcnt; i++) {
                copies[i] = malloc(iov[i].iov_len * 3 + 1);
                if (copies[i]) {
                    memcpy(copies[i], iov[i].iov_base, iov[i].iov_len);
                    copies[i][iov[i].iov_len] = 0;
                    ssize_t new_len = (ssize_t)iov[i].iov_len;
                    reverse_transform_json_paths(copies[i], &new_len);
                    new_iov[i].iov_base = copies[i];
                    new_iov[i].iov_len = (size_t)new_len;
                } else {
                    new_iov[i] = iov[i];
                }
            }
            ssize_t result = get_orig_writev()(fd, new_iov, iovcnt);
            for (int i = 0; i < iovcnt; i++) if (copies[i]) free(copies[i]);
            free(copies);
            free(new_iov);
            return result;
        }
        if (new_iov) free(new_iov);
        if (copies) free(copies);
    }
    return get_orig_writev()(fd, iov, iovcnt);
}

ORIG_FUNC(ssize_t, pwritev, int, const struct iovec *, int, off_t)
ssize_t pwritev(int fd, const struct iovec *iov, int iovcnt, off_t offset) {
    if (is_tracked_fd(fd) && iov && iovcnt > 0) {
        struct iovec *new_iov = malloc(sizeof(struct iovec) * iovcnt);
        char **copies = malloc(sizeof(char *) * iovcnt);
        if (new_iov && copies) {
            for (int i = 0; i < iovcnt; i++) {
                copies[i] = malloc(iov[i].iov_len * 3 + 1);
                if (copies[i]) {
                    memcpy(copies[i], iov[i].iov_base, iov[i].iov_len);
                    copies[i][iov[i].iov_len] = 0;
                    ssize_t new_len = (ssize_t)iov[i].iov_len;
                    reverse_transform_json_paths(copies[i], &new_len);
                    new_iov[i].iov_base = copies[i];
                    new_iov[i].iov_len = (size_t)new_len;
                } else {
                    new_iov[i] = iov[i];
                }
            }
            ssize_t result = get_orig_pwritev()(fd, new_iov, iovcnt, offset);
            for (int i = 0; i < iovcnt; i++) if (copies[i]) free(copies[i]);
            free(copies);
            free(new_iov);
            return result;
        }
        if (new_iov) free(new_iov);
        if (copies) free(copies);
    }
    return get_orig_pwritev()(fd, iov, iovcnt, offset);
}

// fwrite wrapper
ORIG_FUNC(size_t, fwrite, const void *, size_t, size_t, FILE *)
size_t fwrite(const void *ptr, size_t size, size_t nmemb, FILE *stream) {
    if (stream) {
        int fd = fileno(stream);
        if (fd >= 0 && is_tracked_fd(fd) && ptr && size * nmemb > 0) {
            size_t total = size * nmemb;
            char *copy = malloc(total * 3 + 1);
            if (copy) {
                memcpy(copy, ptr, total);
                copy[total] = 0;
                ssize_t new_len = (ssize_t)total;
                reverse_transform_json_paths(copy, &new_len);
                size_t result = get_orig_fwrite()(copy, 1, (size_t)new_len, stream);
                free(copy);
                return (result == (size_t)new_len) ? nmemb : result / size;
            }
        }
    }
    return get_orig_fwrite()(ptr, size, nmemb, stream);
}

// fputs wrapper
ORIG_FUNC(int, fputs, const char *, FILE *)
int fputs(const char *s, FILE *stream) {
    if (stream && s) {
        int fd = fileno(stream);
        if (fd >= 0 && is_tracked_fd(fd)) {
            size_t len = strlen(s);
            char *copy = malloc(len * 3 + 1);
            if (copy) {
                memcpy(copy, s, len + 1);
                ssize_t new_len = (ssize_t)len;
                reverse_transform_json_paths(copy, &new_len);
                int result = get_orig_fputs()(copy, stream);
                free(copy);
                return result;
            }
        }
    }
    return get_orig_fputs()(s, stream);
}

// fputc wrapper (single char, unlikely to need transform but for completeness)
ORIG_FUNC(int, fputc, int, FILE *)
int fputc(int c, FILE *stream) {
    return get_orig_fputc()(c, stream);
}

// putc wrapper
ORIG_FUNC(int, putc, int, FILE *)
int putc(int c, FILE *stream) {
    return get_orig_putc()(c, stream);
}

// fprintf would need va_list handling - skip for now as it's complex
// Most JSON writes use fwrite/write anyway

// ═══════════════════════════════════════════════════════════════════════════
// Core filesystem function implementations
// ═══════════════════════════════════════════════════════════════════════════
int open(const char *path, int flags, ...) {
    mode_t mode = 0;
    if (flags & (O_CREAT | O_TMPFILE)) { va_list ap; va_start(ap, flags); mode = va_arg(ap, mode_t); va_end(ap); }
    int fd = get_orig_open()(transform_path(path), flags, mode);
    if (fd >= 0) track_fd(fd, path);
    return fd;
}
int open64(const char *path, int flags, ...) {
    mode_t mode = 0;
    if (flags & (O_CREAT | O_TMPFILE)) { va_list ap; va_start(ap, flags); mode = va_arg(ap, mode_t); va_end(ap); }
    int fd = get_orig_open64()(transform_path(path), flags, mode);
    if (fd >= 0) track_fd(fd, path);
    return fd;
}
int openat(int dirfd, const char *path, int flags, ...) {
    mode_t mode = 0;
    if (flags & (O_CREAT | O_TMPFILE)) { va_list ap; va_start(ap, flags); mode = va_arg(ap, mode_t); va_end(ap); }
    return get_orig_openat()(dirfd, transform_path(path), flags, mode);
}
int openat64(int dirfd, const char *path, int flags, ...) {
    mode_t mode = 0;
    if (flags & (O_CREAT | O_TMPFILE)) { va_list ap; va_start(ap, flags); mode = va_arg(ap, mode_t); va_end(ap); }
    return get_orig_openat64()(dirfd, transform_path(path), flags, mode);
}
int creat(const char *path, mode_t mode) { return get_orig_creat()(transform_path(path), mode); }
int creat64(const char *path, mode_t mode) { return get_orig_creat64()(transform_path(path), mode); }

// FILE* based I/O with tracking for JSON transformation
FILE *fopen(const char *path, const char *mode) {
    FILE *f = get_orig_fopen()(transform_path(path), mode);
    if (f) { int fd = fileno(f); if (fd >= 0) track_fd(fd, path); }
    return f;
}
FILE *fopen64(const char *path, const char *mode) {
    FILE *f = get_orig_fopen64()(transform_path(path), mode);
    if (f) { int fd = fileno(f); if (fd >= 0) track_fd(fd, path); }
    return f;
}
FILE *freopen(const char *path, const char *mode, FILE *stream) {
    if (stream) { int fd = fileno(stream); if (fd >= 0) untrack_fd(fd); }
    FILE *f = get_orig_freopen()(transform_path(path), mode, stream);
    if (f) { int fd = fileno(f); if (fd >= 0) track_fd(fd, path); }
    return f;
}
FILE *freopen64(const char *path, const char *mode, FILE *stream) {
    if (stream) { int fd = fileno(stream); if (fd >= 0) untrack_fd(fd); }
    FILE *f = get_orig_freopen64()(transform_path(path), mode, stream);
    if (f) { int fd = fileno(f); if (fd >= 0) track_fd(fd, path); }
    return f;
}

// fread wrapper for JSON transformation
ORIG_FUNC(size_t, fread, void *, size_t, size_t, FILE *)
size_t fread(void *ptr, size_t size, size_t nmemb, FILE *stream) {
    size_t result = get_orig_fread()(ptr, size, nmemb, stream);
    if (result > 0 && stream) {
        int fd = fileno(stream);
        if (fd >= 0 && is_tracked_fd(fd)) {
            transform_json_paths((char *)ptr, result * size);
        }
    }
    return result;
}
int stat(const char *path, struct stat *buf) { return get_orig_stat()(transform_path(path), buf); }
int stat64(const char *path, struct stat64 *buf) { return get_orig_stat64()(transform_path(path), buf); }
int lstat(const char *path, struct stat *buf) { return get_orig_lstat()(transform_path(path), buf); }
int lstat64(const char *path, struct stat64 *buf) { return get_orig_lstat64()(transform_path(path), buf); }
int access(const char *path, int mode) { return get_orig_access()(transform_path(path), mode); }
int euidaccess(const char *path, int mode) { return get_orig_euidaccess()(transform_path(path), mode); }
int eaccess(const char *path, int mode) { return get_orig_eaccess()(transform_path(path), mode); }
DIR *opendir(const char *name) { return get_orig_opendir()(transform_path(name)); }
int mkdir(const char *path, mode_t mode) { return get_orig_mkdir()(transform_path(path), mode); }
int rmdir(const char *path) { return get_orig_rmdir()(transform_path(path)); }
int chdir(const char *path) { return get_orig_chdir()(transform_path(path)); }
int unlink(const char *path) { return get_orig_unlink()(transform_path(path)); }
int remove(const char *path) { return get_orig_remove()(transform_path(path)); }
int rename(const char *oldpath, const char *newpath) { return get_orig_rename()(transform_path(oldpath), transform_path2(newpath)); }
int chmod(const char *path, mode_t mode) { return get_orig_chmod()(transform_path(path), mode); }
int chown(const char *path, uid_t owner, gid_t group) { return get_orig_chown()(transform_path(path), owner, group); }
int lchown(const char *path, uid_t owner, gid_t group) { return get_orig_lchown()(transform_path(path), owner, group); }
int truncate(const char *path, off_t length) { return get_orig_truncate()(transform_path(path), length); }
int truncate64(const char *path, off64_t length) { return get_orig_truncate64()(transform_path(path), length); }
char *realpath(const char *path, char *resolved_path) { return get_orig_realpath()(transform_path(path), resolved_path); }
char *canonicalize_file_name(const char *name) { return get_orig_canonicalize_file_name()(transform_path(name)); }
ssize_t readlink(const char *path, char *buf, size_t bufsiz) { return get_orig_readlink()(transform_path(path), buf, bufsiz); }
int symlink(const char *target, const char *linkpath) { return get_orig_symlink()(target, transform_path(linkpath)); }
int link(const char *oldpath, const char *newpath) { return get_orig_link()(transform_path(oldpath), transform_path2(newpath)); }
int mknod(const char *path, mode_t mode, dev_t dev) { return get_orig_mknod()(transform_path(path), mode, dev); }
int mkfifo(const char *path, mode_t mode) { return get_orig_mkfifo()(transform_path(path), mode); }
int chroot(const char *path) { return get_orig_chroot()(transform_path(path)); }
int statfs(const char *path, struct statfs *buf) { return get_orig_statfs()(transform_path(path), buf); }
int statfs64(const char *path, struct statfs64 *buf) { return get_orig_statfs64()(transform_path(path), buf); }
int statvfs(const char *path, struct statvfs *buf) { return get_orig_statvfs()(transform_path(path), buf); }
int statvfs64(const char *path, struct statvfs64 *buf) { return get_orig_statvfs64()(transform_path(path), buf); }
long pathconf(const char *path, int name) { return get_orig_pathconf()(transform_path(path), name); }

// Time modification
int utime(const char *path, const struct utimbuf *times) { return get_orig_utime()(transform_path(path), times); }
int utimes(const char *path, const struct timeval times[2]) { return get_orig_utimes()(transform_path(path), times); }
int lutimes(const char *path, const struct timeval times[2]) { return get_orig_lutimes()(transform_path(path), times); }

// Extended attributes
int setxattr(const char *path, const char *name, const void *value, size_t size, int flags) { return get_orig_setxattr()(transform_path(path), name, value, size, flags); }
int lsetxattr(const char *path, const char *name, const void *value, size_t size, int flags) { return get_orig_lsetxattr()(transform_path(path), name, value, size, flags); }
ssize_t getxattr(const char *path, const char *name, void *value, size_t size) { return get_orig_getxattr()(transform_path(path), name, value, size); }
ssize_t lgetxattr(const char *path, const char *name, void *value, size_t size) { return get_orig_lgetxattr()(transform_path(path), name, value, size); }
ssize_t listxattr(const char *path, char *list, size_t size) { return get_orig_listxattr()(transform_path(path), list, size); }
ssize_t llistxattr(const char *path, char *list, size_t size) { return get_orig_llistxattr()(transform_path(path), list, size); }
int removexattr(const char *path, const char *name) { return get_orig_removexattr()(transform_path(path), name); }
int lremovexattr(const char *path, const char *name) { return get_orig_lremovexattr()(transform_path(path), name); }

// ═══════════════════════════════════════════════════════════════════════════
// Modern *at() syscall implementations
// ═══════════════════════════════════════════════════════════════════════════
int faccessat(int dirfd, const char *path, int mode, int flags) { return get_orig_faccessat()(dirfd, transform_path(path), mode, flags); }
int fstatat(int dirfd, const char *path, struct stat *buf, int flags) { return get_orig_fstatat()(dirfd, transform_path(path), buf, flags); }
int fstatat64(int dirfd, const char *path, struct stat64 *buf, int flags) { return get_orig_fstatat64()(dirfd, transform_path(path), buf, flags); }
int unlinkat(int dirfd, const char *path, int flags) { return get_orig_unlinkat()(dirfd, transform_path(path), flags); }
int mkdirat(int dirfd, const char *path, mode_t mode) { return get_orig_mkdirat()(dirfd, transform_path(path), mode); }
int mknodat(int dirfd, const char *path, mode_t mode, dev_t dev) { return get_orig_mknodat()(dirfd, transform_path(path), mode, dev); }
int mkfifoat(int dirfd, const char *path, mode_t mode) { return get_orig_mkfifoat()(dirfd, transform_path(path), mode); }
int renameat(int olddirfd, const char *oldpath, int newdirfd, const char *newpath) { return get_orig_renameat()(olddirfd, transform_path(oldpath), newdirfd, transform_path2(newpath)); }
int renameat2(int olddirfd, const char *oldpath, int newdirfd, const char *newpath, unsigned int flags) { return get_orig_renameat2()(olddirfd, transform_path(oldpath), newdirfd, transform_path2(newpath), flags); }
int linkat(int olddirfd, const char *oldpath, int newdirfd, const char *newpath, int flags) { return get_orig_linkat()(olddirfd, transform_path(oldpath), newdirfd, transform_path2(newpath), flags); }
int symlinkat(const char *target, int newdirfd, const char *linkpath) { return get_orig_symlinkat()(target, newdirfd, transform_path(linkpath)); }
ssize_t readlinkat(int dirfd, const char *path, char *buf, size_t bufsiz) { return get_orig_readlinkat()(dirfd, transform_path(path), buf, bufsiz); }
int fchmodat(int dirfd, const char *path, mode_t mode, int flags) { return get_orig_fchmodat()(dirfd, transform_path(path), mode, flags); }
int fchownat(int dirfd, const char *path, uid_t owner, gid_t group, int flags) { return get_orig_fchownat()(dirfd, transform_path(path), owner, group, flags); }
int utimensat(int dirfd, const char *path, const struct timespec times[2], int flags) { return get_orig_utimensat()(dirfd, transform_path(path), times, flags); }
int futimesat(int dirfd, const char *path, const struct timeval times[2]) { return get_orig_futimesat()(dirfd, transform_path(path), times); }

// ═══════════════════════════════════════════════════════════════════════════
// glibc internal stat wrappers (older glibc < 2.33)
// ═══════════════════════════════════════════════════════════════════════════
int __xstat(int ver, const char *path, struct stat *buf) { return get_orig___xstat()(ver, transform_path(path), buf); }
int __lxstat(int ver, const char *path, struct stat *buf) { return get_orig___lxstat()(ver, transform_path(path), buf); }
int __xstat64(int ver, const char *path, struct stat64 *buf) { return get_orig___xstat64()(ver, transform_path(path), buf); }
int __lxstat64(int ver, const char *path, struct stat64 *buf) { return get_orig___lxstat64()(ver, transform_path(path), buf); }
int __fxstatat(int ver, int dirfd, const char *path, struct stat *buf, int flags) { return get_orig___fxstatat()(ver, dirfd, transform_path(path), buf, flags); }
int __fxstatat64(int ver, int dirfd, const char *path, struct stat64 *buf, int flags) { return get_orig___fxstatat64()(ver, dirfd, transform_path(path), buf, flags); }

// ═══════════════════════════════════════════════════════════════════════════
// statx - modern stat replacement (glibc 2.28+)
// ═══════════════════════════════════════════════════════════════════════════
int statx(int dirfd, const char *path, int flags, unsigned int mask, struct statx *buf) { return get_orig_statx()(dirfd, transform_path(path), flags, mask, buf); }

// ═══════════════════════════════════════════════════════════════════════════
// Exec and process functions
// ═══════════════════════════════════════════════════════════════════════════
int execve(const char *path, char *const argv[], char *const envp[]) { return get_orig_execve()(transform_path(path), argv, envp); }
int execv(const char *path, char *const argv[]) { return get_orig_execv()(transform_path(path), argv); }
int execvp(const char *file, char *const argv[]) { return get_orig_execvp()(transform_path(file), argv); }
int execvpe(const char *file, char *const argv[], char *const envp[]) { return get_orig_execvpe()(transform_path(file), argv, envp); }
// Note: execl, execlp, execle are variadic and internally call execv/execve, so they're covered

// ═══════════════════════════════════════════════════════════════════════════
// Directory scanning
// ═══════════════════════════════════════════════════════════════════════════
int scandir(const char *dirp, struct dirent ***namelist, scandir_filter_t filter, scandir_compar_t compar) { return get_orig_scandir()(transform_path(dirp), namelist, filter, compar); }

// File tree walk
int ftw(const char *dirpath, ftw_fn_t fn, int nopenfd) { return get_orig_ftw()(transform_path(dirpath), fn, nopenfd); }
int nftw(const char *dirpath, nftw_fn_t fn, int nopenfd, int flags) { return get_orig_nftw()(transform_path(dirpath), fn, nopenfd, flags); }

// ═══════════════════════════════════════════════════════════════════════════
// Dynamic linking
// ═══════════════════════════════════════════════════════════════════════════
void *dlopen(const char *filename, int flags) { return get_orig_dlopen()(filename ? transform_path(filename) : NULL, flags); }

// ═══════════════════════════════════════════════════════════════════════════
// File descriptor cleanup
// ═══════════════════════════════════════════════════════════════════════════
ORIG_FUNC(int, close, int)
int close(int fd) {
    untrack_fd(fd);
    return get_orig_close()(fd);
}

ORIG_FUNC(int, fclose, FILE *)
int fclose(FILE *stream) {
    if (stream) { int fd = fileno(stream); if (fd >= 0) untrack_fd(fd); }
    return get_orig_fclose()(stream);
}

// ═══════════════════════════════════════════════════════════════════════════
// Low-level read wrappers for JSON transformation
// ═══════════════════════════════════════════════════════════════════════════
ORIG_FUNC(ssize_t, read, int, void *, size_t)
ssize_t read(int fd, void *buf, size_t count) {
    ssize_t result = get_orig_read()(fd, buf, count);
    if (result > 0 && is_tracked_fd(fd)) result = transform_json_paths((char *)buf, result);
    return result;
}

ORIG_FUNC(ssize_t, pread, int, void *, size_t, off_t)
ssize_t pread(int fd, void *buf, size_t count, off_t offset) {
    ssize_t result = get_orig_pread()(fd, buf, count, offset);
    if (result > 0 && is_tracked_fd(fd)) result = transform_json_paths((char *)buf, result);
    return result;
}

ORIG_FUNC(ssize_t, pread64, int, void *, size_t, off64_t)
ssize_t pread64(int fd, void *buf, size_t count, off64_t offset) {
    ssize_t result = get_orig_pread64()(fd, buf, count, offset);
    if (result > 0 && is_tracked_fd(fd)) result = transform_json_paths((char *)buf, result);
    return result;
}

// readv - scatter/gather I/O
ORIG_FUNC(ssize_t, readv, int, const struct iovec *, int)
ssize_t readv(int fd, const struct iovec *iov, int iovcnt) {
    ssize_t result = get_orig_readv()(fd, iov, iovcnt);
    if (result > 0 && is_tracked_fd(fd)) {
        for (int i = 0; i < iovcnt && iov[i].iov_base; i++) {
            transform_json_paths((char *)iov[i].iov_base, iov[i].iov_len);
        }
    }
    return result;
}

ORIG_FUNC(ssize_t, preadv, int, const struct iovec *, int, off_t)
ssize_t preadv(int fd, const struct iovec *iov, int iovcnt, off_t offset) {
    ssize_t result = get_orig_preadv()(fd, iov, iovcnt, offset);
    if (result > 0 && is_tracked_fd(fd)) {
        for (int i = 0; i < iovcnt && iov[i].iov_base; i++) {
            transform_json_paths((char *)iov[i].iov_base, iov[i].iov_len);
        }
    }
    return result;
}

// ═══════════════════════════════════════════════════════════════════════════
// stdio stream read wrappers for JSON transformation
// ═══════════════════════════════════════════════════════════════════════════

// fgets - line reading
ORIG_FUNC(char *, fgets, char *, int, FILE *)
char *fgets(char *s, int size, FILE *stream) {
    char *result = get_orig_fgets()(s, size, stream);
    if (result && stream) {
        int fd = fileno(stream);
        if (fd >= 0 && is_tracked_fd(fd)) transform_json_paths(s, strlen(s));
    }
    return result;
}

// getline/getdelim - dynamic line reading
ORIG_FUNC(ssize_t, getline, char **, size_t *, FILE *)
ssize_t getline(char **lineptr, size_t *n, FILE *stream) {
    ssize_t result = get_orig_getline()(lineptr, n, stream);
    if (result > 0 && stream && lineptr && *lineptr) {
        int fd = fileno(stream);
        if (fd >= 0 && is_tracked_fd(fd)) transform_json_paths(*lineptr, result);
    }
    return result;
}

ORIG_FUNC(ssize_t, getdelim, char **, size_t *, int, FILE *)
ssize_t getdelim(char **lineptr, size_t *n, int delim, FILE *stream) {
    ssize_t result = get_orig_getdelim()(lineptr, n, delim, stream);
    if (result > 0 && stream && lineptr && *lineptr) {
        int fd = fileno(stream);
        if (fd >= 0 && is_tracked_fd(fd)) transform_json_paths(*lineptr, result);
    }
    return result;
}

// __fread_chk - fortified fread (glibc security feature)
ORIG_FUNC(size_t, __fread_chk, void *, size_t, size_t, size_t, FILE *)
size_t __fread_chk(void *ptr, size_t ptrlen, size_t size, size_t nmemb, FILE *stream) {
    size_t result = get_orig___fread_chk()(ptr, ptrlen, size, nmemb, stream);
    if (result > 0 && stream) {
        int fd = fileno(stream);
        if (fd >= 0 && is_tracked_fd(fd)) transform_json_paths((char *)ptr, result * size);
    }
    return result;
}

// __read_chk - fortified read
ORIG_FUNC(ssize_t, __read_chk, int, void *, size_t, size_t)
ssize_t __read_chk(int fd, void *buf, size_t nbytes, size_t buflen) {
    ssize_t result = get_orig___read_chk()(fd, buf, nbytes, buflen);
    if (result > 0 && is_tracked_fd(fd)) transform_json_paths((char *)buf, result);
    return result;
}

// __pread_chk - fortified pread
ORIG_FUNC(ssize_t, __pread_chk, int, void *, size_t, off_t, size_t)
ssize_t __pread_chk(int fd, void *buf, size_t nbytes, off_t offset, size_t buflen) {
    ssize_t result = get_orig___pread_chk()(fd, buf, nbytes, offset, buflen);
    if (result > 0 && is_tracked_fd(fd)) transform_json_paths((char *)buf, result);
    return result;
}

// __pread64_chk - fortified pread64
ORIG_FUNC(ssize_t, __pread64_chk, int, void *, size_t, off64_t, size_t)
ssize_t __pread64_chk(int fd, void *buf, size_t nbytes, off64_t offset, size_t buflen) {
    ssize_t result = get_orig___pread64_chk()(fd, buf, nbytes, offset, buflen);
    if (result > 0 && is_tracked_fd(fd)) transform_json_paths((char *)buf, result);
    return result;
}

// __fgets_chk - fortified fgets
ORIG_FUNC(char *, __fgets_chk, char *, size_t, int, FILE *)
char *__fgets_chk(char *s, size_t slen, int size, FILE *stream) {
    char *result = get_orig___fgets_chk()(s, slen, size, stream);
    if (result && stream) {
        int fd = fileno(stream);
        if (fd >= 0 && is_tracked_fd(fd)) transform_json_paths(s, strlen(s));
    }
    return result;
}
`;
}

/**
 * Generate ccbox-fuse.c content for FUSE filesystem.
 * This is embedded for compiled binary compatibility.
 */
function generateCcboxFuseC(): string {
  return `/**
 * ccbox-fuse: FUSE filesystem for transparent cross-platform path mapping
 * Provides kernel-level path transformation that works with io_uring
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

static size_t transform_to_container(char *buf, size_t len) {
    if (!buf || len == 0 || mapping_count == 0) return len;
    char *work = malloc(len * 2 + 1);
    if (!work) return len;
    size_t wi = 0, i = 0;
    while (i < len && buf[i]) {
        int matched = 0;
        if (i + 2 < len && isalpha(buf[i]) && buf[i+1] == ':') {
            char drive = tolower(buf[i]);
            for (int m = 0; m < mapping_count && !matched; m++) {
                if (mappings[m].drive == drive) {
                    memcpy(work + wi, mappings[m].to, mappings[m].to_len);
                    wi += mappings[m].to_len;
                    i += 2;
                    while (i < len && buf[i] != '"' && buf[i] != ',' && buf[i] != '}') {
                        if (buf[i] == '\\\\') { work[wi++] = '/'; i++; if (i < len && buf[i] == '\\\\') i++; }
                        else work[wi++] = buf[i++];
                    }
                    matched = 1;
                }
            }
        }
        if (!matched) work[wi++] = buf[i++];
    }
    work[wi] = '\\0';
    if (wi <= len) { memcpy(buf, work, wi + 1); free(work); return wi; }
    free(work);
    return len;
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
        size_t newlen = transform_to_container(filebuf, nread);
        if ((size_t)offset >= newlen) { free(filebuf); return 0; }
        size_t tocopy = newlen - offset;
        if (tocopy > size) tocopy = size;
        memcpy(buf, filebuf + offset, tocopy);
        free(filebuf);
        return tocopy;
    }
    ssize_t res = pread(fd, buf, size, offset);
    return res == -1 ? -errno : res;
}

static int ccbox_write(const char *path, const char *buf, size_t size, off_t offset, struct fuse_file_info *fi) {
    (void)path;
    ssize_t res = pwrite(fi->fh, buf, size, offset);
    return res == -1 ? -errno : res;
}

static int ccbox_release(const char *path, struct fuse_file_info *fi) { (void)path; close(fi->fh); return 0; }
static int ccbox_access(const char *path, int mask) { char fpath[MAX_PATH_LEN]; get_source_path(fpath, path, sizeof(fpath)); return access(fpath, mask) == -1 ? -errno : 0; }
static int ccbox_mkdir(const char *path, mode_t mode) { char fpath[MAX_PATH_LEN]; get_source_path(fpath, path, sizeof(fpath)); return mkdir(fpath, mode) == -1 ? -errno : 0; }
static int ccbox_unlink(const char *path) { char fpath[MAX_PATH_LEN]; get_source_path(fpath, path, sizeof(fpath)); return unlink(fpath) == -1 ? -errno : 0; }
static int ccbox_rmdir(const char *path) { char fpath[MAX_PATH_LEN]; get_source_path(fpath, path, sizeof(fpath)); return rmdir(fpath) == -1 ? -errno : 0; }
static int ccbox_create(const char *path, mode_t mode, struct fuse_file_info *fi) { char fpath[MAX_PATH_LEN]; get_source_path(fpath, path, sizeof(fpath)); int fd = open(fpath, fi->flags, mode); if (fd == -1) return -errno; fi->fh = fd; return 0; }
static int ccbox_truncate(const char *path, off_t size, struct fuse_file_info *fi) { char fpath[MAX_PATH_LEN]; get_source_path(fpath, path, sizeof(fpath)); return (fi ? ftruncate(fi->fh, size) : truncate(fpath, size)) == -1 ? -errno : 0; }
static int ccbox_utimens(const char *path, const struct timespec ts[2], struct fuse_file_info *fi) { (void)fi; char fpath[MAX_PATH_LEN]; get_source_path(fpath, path, sizeof(fpath)); return utimensat(0, fpath, ts, AT_SYMLINK_NOFOLLOW) == -1 ? -errno : 0; }
static int ccbox_chmod(const char *path, mode_t mode, struct fuse_file_info *fi) { (void)fi; char fpath[MAX_PATH_LEN]; get_source_path(fpath, path, sizeof(fpath)); return chmod(fpath, mode) == -1 ? -errno : 0; }
static int ccbox_chown(const char *path, uid_t uid, gid_t gid, struct fuse_file_info *fi) { (void)fi; char fpath[MAX_PATH_LEN]; get_source_path(fpath, path, sizeof(fpath)); return lchown(fpath, uid, gid) == -1 ? -errno : 0; }
static int ccbox_rename(const char *from, const char *to, unsigned int flags) { if (flags) return -EINVAL; char ff[MAX_PATH_LEN], ft[MAX_PATH_LEN]; get_source_path(ff, from, sizeof(ff)); get_source_path(ft, to, sizeof(ft)); return rename(ff, ft) == -1 ? -errno : 0; }

static const struct fuse_operations ccbox_oper = {
    .getattr = ccbox_getattr, .readdir = ccbox_readdir, .open = ccbox_open, .read = ccbox_read,
    .write = ccbox_write, .release = ccbox_release, .access = ccbox_access, .mkdir = ccbox_mkdir,
    .unlink = ccbox_unlink, .rmdir = ccbox_rmdir, .create = ccbox_create, .truncate = ccbox_truncate,
    .utimens = ccbox_utimens, .chmod = ccbox_chmod, .chown = ccbox_chown, .rename = ccbox_rename,
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

  // Copy pathmap.c for LD_PRELOAD library build
  const pathmapSrc = join(__dirname, "..", "native", "pathmap.c");
  let pathmapContent: string;
  if (existsSync(pathmapSrc)) {
    pathmapContent = readFileSync(pathmapSrc, "utf-8");
  } else {
    // Fallback to embedded version when running from compiled binary
    pathmapContent = generatePathmapC();
  }
  writeFileSync(join(buildDir, "pathmap.c"), pathmapContent, { encoding: "utf-8" });

  // Copy ccbox-fuse.c for FUSE filesystem build
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

  // Project mount (always)
  cmd.push("-v", `${dockerProjectPath}:/ccbox/${dirName}:rw`);

  // Claude config mount
  // - Base image: minimal mount (only credentials + settings for vanilla experience)
  // - Fresh mode: same as base (explicit --fresh flag)
  // - Other images: full .claude mount via FUSE for path transformation
  const dockerClaudeConfig = resolveForDocker(claudeConfig);
  const isBaseImage = stack === "base";
  const useMinimalMount = options.fresh || isBaseImage;

  if (useMinimalMount) {
    addMinimalMounts(cmd, claudeConfig);
  } else {
    // Mount to staging location - FUSE will mount at final location
    // This enables kernel-level path transformation for io_uring
    cmd.push("-v", `${dockerClaudeConfig}:/mnt/host-claude:rw`);
    cmd.push("-e", "CCBOX_FUSE_SOURCE=/mnt/host-claude");
    cmd.push("-e", "CCBOX_FUSE_TARGET=/ccbox/.claude");
  }

  // Working directory
  cmd.push("-w", `/ccbox/${dirName}`);

  // User mapping
  addUserMapping(cmd);

  // Security options
  addSecurityOptions(cmd);
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
  // This allows container to start as root for FUSE setup, then drop to non-root via gosu
  cmd.push("-e", `CCBOX_UID=${uid}`);
  cmd.push("-e", `CCBOX_GID=${gid}`);
}

function addSecurityOptions(cmd: string[]): void {
  const { capDrop, pidsLimit } = CONTAINER_CONSTRAINTS;
  cmd.push(
    `--cap-drop=${capDrop}`,
    // FUSE requires SYS_ADMIN capability and /dev/fuse device access
    // This is needed for kernel-level path transformation (bypasses io_uring)
    "--cap-add=SYS_ADMIN",
    // SETUID and SETGID are required for gosu to switch users
    "--cap-add=SETUID",
    "--cap-add=SETGID",
    // CHOWN is needed for ownership changes
    "--cap-add=CHOWN",
    // DAC_OVERRIDE allows root to bypass file permission checks (needed for mkdir)
    "--cap-add=DAC_OVERRIDE",
    // FOWNER allows root to change file ownership
    "--cap-add=FOWNER",
    "--device=/dev/fuse",
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
    "DISABLE_AUTOUPDATER=1",
    // Runtime configuration
    "-e",
    "PYTHONUNBUFFERED=1",
    "-e",
    "NODE_OPTIONS=--no-warnings --disable-warning=ExperimentalWarning --disable-warning=DeprecationWarning",
    "-e",
    "NODE_NO_READLINE=1",
    "-e",
    "NODE_COMPILE_CACHE=/ccbox/.cache/node-compile"
  );
}

