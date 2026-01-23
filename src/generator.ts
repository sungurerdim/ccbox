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
import { resolveForDocker } from "./paths.js";

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
# Ensure node user exists (idempotent - create if missing)
RUN groupadd -g 1000 node 2>/dev/null || true && \\
    useradd -m -s /bin/bash -u 1000 -g 1000 node 2>/dev/null || true

# System packages (minimal but complete)
RUN apt-get update && apt-get install -y --no-install-recommends \\
    git curl ca-certificates bash gcc libc6-dev \\
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

# Cross-platform path compatibility (Windows/macOS/Linux host paths)
# Windows: /{a..z} (all drive letters)  macOS: /Users  Linux: /home already exists
RUN bash -c 'mkdir -p /{a..z} /Users && chown node:node /{a..z} /Users'

# Locale and performance environment
ENV LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 \\
    # Bun/Node.js: production mode for optimized behavior
    NODE_ENV=production \\
    # Git performance: disable advice messages, use parallel index
    GIT_ADVICE=0 \\
    GIT_INDEX_THREADS=0
`;

// LD_PRELOAD path mapping library build
const PATH_MAP_BUILD = `
# Build LD_PRELOAD path mapping library (host path -> container path translation)
COPY pathmap.c /tmp/pathmap.c
RUN gcc -shared -fPIC -O2 -o /usr/local/lib/ccbox-pathmap.so /tmp/pathmap.c -ldl \\
    && rm /tmp/pathmap.c
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

// Claude Code native binary installation
// Install as root, then move to system-wide location for non-root access
const CLAUDE_CODE_INSTALL = `
# Claude Code (native binary - official installation)
# Install first, then move to /usr/local/bin for non-root user access
RUN curl -fsSL https://claude.ai/install.sh | bash -s latest \\
    && mv /root/.local/bin/claude /usr/local/bin/claude \\
    && chmod 755 /usr/local/bin/claude \\
    && rm -rf /root/.local/share/claude
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

# Warn if running as root (legacy/misconfigured setup)
if [[ "$(id -u)" == "0" ]]; then
    echo "[ccbox:WARN] Running as root is not recommended." >&2
    echo "[ccbox:WARN] Container should be started with --user flag for security." >&2
    echo "[ccbox:WARN] Continuing anyway, but file ownership may be incorrect." >&2
fi

# ══════════════════════════════════════════════════════════════════════════════
# LD_PRELOAD path mapping activation
# Transparently maps host paths to container paths in filesystem calls
# This replaces the old symlink-based approach for better reliability
# ══════════════════════════════════════════════════════════════════════════════
if [[ -n "$CCBOX_PATH_MAP" ]]; then
    if [[ -f "/usr/local/lib/ccbox-pathmap.so" ]]; then
        export LD_PRELOAD="/usr/local/lib/ccbox-pathmap.so"
        _log "Path mapping active: $CCBOX_PATH_MAP"
        _log_verbose "LD_PRELOAD: $LD_PRELOAD"
    else
        _log_verbose "Path mapping library not found, skipping LD_PRELOAD"
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

# Run Claude Code
if [[ -t 1 ]]; then
    printf '\\e[?2026h' 2>/dev/null || true
    exec $PRIORITY_CMD claude --dangerously-skip-permissions "$@"
else
    exec stdbuf -oL -eL $PRIORITY_CMD claude --dangerously-skip-permissions "$@"
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
 * Compile: gcc -shared -fPIC -O2 -o ccbox-pathmap.so pathmap.c -ldl
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <dirent.h>
#include <unistd.h>
#include <pthread.h>

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

ORIG_FUNC(int, open, const char *, int, ...)
ORIG_FUNC(int, openat, int, const char *, int, ...)
ORIG_FUNC(FILE *, fopen, const char *, const char *)
ORIG_FUNC(int, stat, const char *, struct stat *)
ORIG_FUNC(int, lstat, const char *, struct stat *)
ORIG_FUNC(int, access, const char *, int)
ORIG_FUNC(DIR *, opendir, const char *)
ORIG_FUNC(int, mkdir, const char *, mode_t)
ORIG_FUNC(int, rmdir, const char *)
ORIG_FUNC(int, chdir, const char *)
ORIG_FUNC(int, unlink, const char *)
ORIG_FUNC(int, rename, const char *, const char *)
ORIG_FUNC(int, chmod, const char *, mode_t)
ORIG_FUNC(char *, realpath, const char *, char *)
ORIG_FUNC(ssize_t, readlink, const char *, char *, size_t)
ORIG_FUNC(int, symlink, const char *, const char *)
ORIG_FUNC(int, link, const char *, const char *)

int open(const char *path, int flags, ...) {
    mode_t mode = 0;
    if (flags & (O_CREAT | O_TMPFILE)) { va_list ap; va_start(ap, flags); mode = va_arg(ap, mode_t); va_end(ap); }
    return get_orig_open()(transform_path(path), flags, mode);
}
int openat(int dirfd, const char *path, int flags, ...) {
    mode_t mode = 0;
    if (flags & (O_CREAT | O_TMPFILE)) { va_list ap; va_start(ap, flags); mode = va_arg(ap, mode_t); va_end(ap); }
    return get_orig_openat()(dirfd, transform_path(path), flags, mode);
}
FILE *fopen(const char *path, const char *mode) { return get_orig_fopen()(transform_path(path), mode); }
int stat(const char *path, struct stat *buf) { return get_orig_stat()(transform_path(path), buf); }
int lstat(const char *path, struct stat *buf) { return get_orig_lstat()(transform_path(path), buf); }
int access(const char *path, int mode) { return get_orig_access()(transform_path(path), mode); }
DIR *opendir(const char *name) { return get_orig_opendir()(transform_path(name)); }
int mkdir(const char *path, mode_t mode) { return get_orig_mkdir()(transform_path(path), mode); }
int rmdir(const char *path) { return get_orig_rmdir()(transform_path(path)); }
int chdir(const char *path) { return get_orig_chdir()(transform_path(path)); }
int unlink(const char *path) { return get_orig_unlink()(transform_path(path)); }
int rename(const char *oldpath, const char *newpath) { return get_orig_rename()(transform_path(oldpath), transform_path2(newpath)); }
int chmod(const char *path, mode_t mode) { return get_orig_chmod()(transform_path(path), mode); }
char *realpath(const char *path, char *resolved_path) { return get_orig_realpath()(transform_path(path), resolved_path); }
ssize_t readlink(const char *path, char *buf, size_t bufsiz) { return get_orig_readlink()(transform_path(path), buf, bufsiz); }
int symlink(const char *target, const char *linkpath) { return get_orig_symlink()(target, transform_path(linkpath)); }
int link(const char *oldpath, const char *newpath) { return get_orig_link()(transform_path(oldpath), transform_path2(newpath)); }
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

  // Project mount (always)
  cmd.push("-v", `${dockerProjectPath}:/home/node/${dirName}:rw`);

  // Claude config mount
  const dockerClaudeConfig = resolveForDocker(claudeConfig);
  if (options.fresh) {
    addFreshModeMounts(cmd, claudeConfig);
  } else {
    cmd.push("-v", `${dockerClaudeConfig}:/home/node/.claude:rw`);
  }

  // Working directory
  cmd.push("-w", `/home/node/${dirName}`);

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
  cmd.push("-e", "HOME=/home/node");
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
    cmd.push("--tmpfs", "/home/node/.claude/debug:rw,size=512m,mode=0777");
  }

  // Persistent paths for container awareness
  const persistentPaths = options.fresh
    ? `/home/node/${dirName}`  // fresh mode: only project dir is persistent
    : `/home/node/${dirName}, /home/node/.claude`;
  cmd.push("-e", `CCBOX_PERSISTENT_PATHS=${persistentPaths}`);

  // LD_PRELOAD path mapping: host paths -> container paths
  // This enables transparent path translation for config files with absolute host paths
  if (!options.fresh) {
    const normalizedHostPath = claudeConfig.replace(/\\/g, "/");
    cmd.push("-e", `CCBOX_PATH_MAP=${normalizedHostPath}:/home/node/.claude`);
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

function addFreshModeMounts(cmd: string[], claudeConfig: string): void {
  const [uid, gid] = getHostUserIds();

  // Base tmpfs mount for .claude directory
  cmd.push("--tmpfs", `/home/node/.claude:rw,size=64m,uid=${uid},gid=${gid},mode=0755`);

  // Mount only credential files from host (auth persists)
  const credentialFiles = [".credentials.json", "settings.json"];
  for (const f of credentialFiles) {
    const hostFile = join(claudeConfig, f);
    if (existsSync(hostFile)) {
      const dockerPath = resolveForDocker(hostFile);
      cmd.push("-v", `${dockerPath}:/home/node/.claude/${f}:rw`);
    }
  }

  // Signal fresh mode
  cmd.push("-e", "CCBOX_FRESH_MODE=1");
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


function addDnsOptions(cmd: string[]): void {
  cmd.push("--dns-opt", "ndots:1", "--dns-opt", "timeout:1", "--dns-opt", "attempts:1");
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

