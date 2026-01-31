/* eslint-disable no-useless-escape -- Dockerfile templates require \$ escapes for shell variables */
/**
 * Dockerfile generation for ccbox.
 *
 * Contains all Dockerfile templates for different language stacks.
 * Separated from generator.ts to reduce file size and improve maintainability.
 */

import { LanguageStack } from "./config.js";

// Common system packages (optimized for minimal size)
// Layer ordering: stable layers first, frequently changing last
const COMMON_TOOLS = `
# Set HOME=/root during build for installer scripts (curl | bash)
# Many installers use $HOME to determine install location
# This ensures consistent behavior - runtime HOME is set in ENTRYPOINT_SETUP
ENV HOME=/root

# System packages - runtime only (no build deps needed - FUSE binary is pre-compiled)
# Note: passwd provides useradd/groupadd (needed on minimal images like eclipse-temurin)
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \\
    --mount=type=cache,target=/var/lib/apt,sharing=locked \\
    apt-get update && apt-get install -y --no-install-recommends \\
    # Essential runtime
    git curl ca-certificates bash openssh-client locales gosu passwd \\
    # Search tools
    ripgrep jq fd-find \\
    # FUSE runtime (only fuse3 needed - binary is pre-compiled)
    fuse3 \\
    # GitHub CLI
    gh \\
    # Core utilities (grep/sed/findutils come with base image)
    procps unzip make tree zip file patch wget vim-tiny \\
    && rm -rf /var/lib/apt/lists/* \\
    # Locale setup
    && sed -i '/en_US.UTF-8/s/^# //g' /etc/locale.gen && locale-gen \\
    # Create fd symlink (Debian package installs as fdfind)
    && ln -s $(which fdfind) /usr/local/bin/fd \\
    # yq (not in apt, install from GitHub - auto-detect architecture)
    && YQ_ARCH=$(dpkg --print-architecture | sed 's/armhf/arm/;s/i386/386/') \\
    && curl -sL "https://github.com/mikefarah/yq/releases/latest/download/yq_linux_\${YQ_ARCH}" -o /usr/local/bin/yq \\
    && chmod +x /usr/local/bin/yq \\
    # git-delta (syntax-highlighted diffs for better code review) - latest from GitHub
    && DELTA_VER=$(curl -sfL https://api.github.com/repos/dandavison/delta/releases/latest | jq -r .tag_name) \\
    && DELTA_ARCH=$(dpkg --print-architecture) \\
    && curl -sL "https://github.com/dandavison/delta/releases/download/\${DELTA_VER}/git-delta_\${DELTA_VER}_\${DELTA_ARCH}.deb" -o /tmp/delta.deb \\
    && dpkg -i /tmp/delta.deb && rm /tmp/delta.deb \\
    # Cleanup unnecessary files (~50MB savings)
    && rm -rf /usr/share/doc/* /usr/share/man/* /var/log/* \\
    && find /usr/share/locale -mindepth 1 -maxdepth 1 ! -name 'en*' -exec rm -rf {} +

# Create ccbox user (uid 1000) with home at /ccbox
# Done after apt-get to ensure useradd/groupadd are available
# Handle existing UID/GID conflicts (e.g., eclipse-temurin has GID 1000)
RUN set -e; \\
    # Remove existing user/group with UID/GID 1000 if not ccbox
    existing_user=\$(getent passwd 1000 | cut -d: -f1 || true); \\
    if [ -n "\$existing_user" ] && [ "\$existing_user" != "ccbox" ]; then \\
        userdel "\$existing_user" 2>/dev/null || true; \\
    fi; \\
    existing_group=\$(getent group 1000 | cut -d: -f1 || true); \\
    if [ -n "\$existing_group" ] && [ "\$existing_group" != "ccbox" ]; then \\
        groupdel "\$existing_group" 2>/dev/null || true; \\
    fi; \\
    # Create ccbox group and user
    getent group ccbox >/dev/null || groupadd -g 1000 ccbox; \\
    getent passwd ccbox >/dev/null || useradd -m -d /ccbox -s /bin/bash -u 1000 -g 1000 ccbox; \\
    mkdir -p /ccbox && chown ccbox:ccbox /ccbox

# Cross-platform path compatibility (Windows/macOS/Linux host paths)
# /{a..z}    — mount points for Docker volumes (D:/x → /d/x)
# /{A..Z}:   — symlinks for Bun direct syscalls (lstat "D:/x" → /D: → /d → /d/x)
# /Users     — macOS home directory mount point
RUN bash -c 'mkdir -p /{a..z} /Users && chown ccbox:ccbox /{a..z} /Users 2>/dev/null || true' \
 && bash -c 'for d in {a..z}; do u=$(echo "$d" | LC_ALL=C tr a-z A-Z); ln -sf /$d /$u: 2>/dev/null || true; done'

# Locale and performance environment
ENV LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 \\
    # Bun/Node.js: production mode for optimized behavior
    NODE_ENV=production \\
    # Git performance: disable advice messages, use parallel index
    GIT_ADVICE=0 \\
    GIT_INDEX_THREADS=0 \\
    # Disk I/O reduction: redirect caches to tmpfs (/tmp is tmpfs at runtime)
    npm_config_cache=/tmp/.npm \\
    YARN_CACHE_FOLDER=/tmp/.yarn \\
    PIP_CACHE_DIR=/tmp/.pip \\
    UV_CACHE_DIR=/tmp/.uv \\
    # Disable analytics/telemetry (reduces disk writes)
    CHECKPOINT_DISABLE=1 \\
    DO_NOT_TRACK=1
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

const FUSE_BUILD = generateFuseBuild();

// fakepath.so - pre-compiled LD_PRELOAD library for Windows path compatibility
// Intercepts getcwd, open, stat, etc. to translate /d/... <-> D:/...
// Pre-compiled like FUSE - no gcc needed at image build time
function generateFakepathBuild(): string {
  return `
# fakepath.so - LD_PRELOAD library for Windows path compatibility
# Translates paths: getcwd() returns D:/... instead of /d/...
#                   open("D:/...") accesses /d/...
# Pre-compiled binary - no gcc needed (~2GB download savings)
ARG TARGETARCH=amd64
COPY fakepath-amd64.so fakepath-arm64.so /tmp/
RUN if [ "$TARGETARCH" = "arm64" ]; then \\
        cp /tmp/fakepath-arm64.so /usr/lib/fakepath.so; \\
    else \\
        cp /tmp/fakepath-amd64.so /usr/lib/fakepath.so; \\
    fi \\
    && chmod 755 /usr/lib/fakepath.so \\
    && rm -f /tmp/fakepath-*.so
`;
}

const FAKEPATH_BUILD = generateFakepathBuild();

// Python dev tools
// All binaries copied to /usr/local/bin for non-root user access
// HOME=/root is set in base image, so installers use /root/.local
const PYTHON_TOOLS_BASE = `
# Python 3 runtime
RUN apt-get update && apt-get install -y --no-install-recommends \\
    python3 python3-pip python3-venv \\
    && rm -rf /var/lib/apt/lists/* \\
    && ln -sf /usr/bin/python3 /usr/local/bin/python

# uv (ultra-fast Python package manager - 10-100x faster than pip)
# HOME=/root is set in base, so installer will use /root/.local/bin
RUN curl -LsSf https://astral.sh/uv/install.sh | sh \\
    && cp /root/.local/bin/uv /usr/local/bin/uv \\
    && cp /root/.local/bin/uvx /usr/local/bin/uvx \\
    && chmod 755 /usr/local/bin/uv /usr/local/bin/uvx

# ruff (Rust binary - standalone, no Python runtime needed)
RUN uv tool install ruff \\
    && cp /root/.local/bin/ruff /usr/local/bin/ruff \\
    && chmod 755 /usr/local/bin/ruff \\
    && rm -rf /root/.local

# mypy and pytest - system-wide install (uses /usr/bin/python3)
# UV_BREAK_SYSTEM_PACKAGES bypasses PEP 668 externally-managed-environment check
RUN UV_BREAK_SYSTEM_PACKAGES=1 uv pip install --system mypy pytest

# Disable runtime bytecode generation (SSD wear reduction)
ENV PYTHONDONTWRITEBYTECODE=1
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
// NOTE: HOME=/root is set in COMMON_TOOLS for build-time installers
// Runtime HOME is set in entrypoint.sh based on actual user
const ENTRYPOINT_SETUP = `
WORKDIR /ccbox

COPY --chmod=755 entrypoint.sh /usr/local/bin/entrypoint.sh

# Start as root - entrypoint will switch to host user's UID/GID and set HOME
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
`;

// ══════════════════════════════════════════════════════════════════════════════
// Core Language Stack Dockerfiles
// ══════════════════════════════════════════════════════════════════════════════

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
${FAKEPATH_BUILD}
${CLAUDE_CODE_INSTALL}
${ENTRYPOINT_SETUP}
`;
}

function pythonDockerfile(): string {
  return `# syntax=docker/dockerfile:1
# ccbox/python - Python dev tools (ruff, mypy, pytest, uv)
FROM ccbox_base:latest

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
${FAKEPATH_BUILD}
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
${FAKEPATH_BUILD}
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
${FAKEPATH_BUILD}
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
FROM ccbox_base:latest

LABEL org.opencontainers.image.title="ccbox/web"

# Node.js LTS - download binary from nodejs.org (same as official image)
RUN ARCH=\$(dpkg --print-architecture | sed 's/amd64/x64/;s/arm64/arm64/') \\
    && NODE_VER=\$(curl -sfL https://nodejs.org/dist/index.json | jq -r '[.[] | select(.lts != false)][0].version') \\
    && curl -fsSL "https://nodejs.org/dist/\${NODE_VER}/node-\${NODE_VER}-linux-\${ARCH}.tar.gz" | tar -xz -C /usr/local --strip-components=1 \\
    && rm -f /usr/local/CHANGELOG.md /usr/local/LICENSE /usr/local/README.md \\
    && ln -sf /usr/local/bin/node /usr/local/bin/nodejs

# pnpm (via updated corepack to fix signature verification)
# Corepack 0.31.0+ required for npm key rotation compatibility
RUN npm install -g corepack@latest \\
    && corepack enable \\
    && corepack prepare pnpm@latest --activate \\
    && npm cache clean --force

# Bun (fast JavaScript runtime) - install then copy to /usr/local/bin
# HOME=/root is set in base, so installer will use /root/.bun
RUN curl -fsSL https://bun.sh/install | bash \\
    && cp /root/.bun/bin/bun /usr/local/bin/bun \\
    && ln -sf /usr/local/bin/bun /usr/local/bin/bunx \\
    && rm -rf /root/.bun

# Node.js/TypeScript dev tools (typescript, eslint, vitest, prettier)
RUN npm install -g typescript eslint vitest prettier @types/node \\
    && npm cache clean --force
`;
}

function cppDockerfile(): string {
  return `# syntax=docker/dockerfile:1
# ccbox/cpp - C++ + CMake + build tools
FROM ccbox_base:latest

LABEL org.opencontainers.image.title="ccbox/cpp"

# C++ toolchain + CMake + Ninja
RUN apt-get update && apt-get install -y --no-install-recommends \\
    build-essential cmake ninja-build clang clang-format clang-tidy \\
    && rm -rf /var/lib/apt/lists/*

# Conan (C++ package manager)
RUN pip3 install --break-system-packages conan
`;
}

function dotnetDockerfile(): string {
  return `# syntax=docker/dockerfile:1
# ccbox/dotnet - .NET SDK + quality tools
FROM ccbox_base:latest

LABEL org.opencontainers.image.title="ccbox/dotnet"

# .NET SDK (latest LTS) - includes built-in tools: dotnet format, dotnet test
RUN curl -fsSL https://dot.net/v1/dotnet-install.sh | bash -s -- --channel LTS --install-dir /usr/share/dotnet \\
    && ln -s /usr/share/dotnet/dotnet /usr/local/bin/dotnet
ENV DOTNET_ROOT=/usr/share/dotnet
ENV DOTNET_CLI_TELEMETRY_OPTOUT=1

# .NET quality tools - install to /opt then symlink to /usr/local/bin
# (dotnet-format is built-in, add analyzers)
RUN dotnet tool install --tool-path /opt/dotnet-tools dotnet-reportgenerator-globaltool \\
    && dotnet tool install --tool-path /opt/dotnet-tools coverlet.console \\
    && ln -s /opt/dotnet-tools/reportgenerator /usr/local/bin/reportgenerator \\
    && ln -s /opt/dotnet-tools/coverlet /usr/local/bin/coverlet
`;
}

function swiftDockerfile(): string {
  return `# syntax=docker/dockerfile:1
# ccbox/swift - Swift + quality tools
FROM ccbox_base:latest

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
FROM ccbox_base:latest

LABEL org.opencontainers.image.title="ccbox/dart"

# Dart SDK - includes built-in quality tools:
#   dart analyze (linting), dart format (formatting), dart test (testing)
# Note: Dart uses x64 instead of amd64 in download URLs
RUN DART_ARCH=\$(dpkg --print-architecture | sed 's/amd64/x64/') \\
    && curl -fsSL "https://storage.googleapis.com/dart-archive/channels/stable/release/latest/sdk/dartsdk-linux-\${DART_ARCH}-release.zip" -o /tmp/dart.zip \\
    && unzip -q /tmp/dart.zip -d /opt && rm /tmp/dart.zip
ENV PATH="/opt/dart-sdk/bin:\$PATH"

# DCM (Dart Code Metrics) - advanced static analysis
# Use PUB_CACHE to install to accessible location, then symlink
ENV PUB_CACHE=/opt/pub-cache
RUN dart pub global activate dart_code_metrics 2>/dev/null || true \\
    && ln -sf /opt/pub-cache/bin/* /usr/local/bin/ 2>/dev/null || true
`;
}

function luaDockerfile(): string {
  return `# syntax=docker/dockerfile:1
# ccbox/lua - Lua + LuaRocks + quality tools
FROM ccbox_base:latest

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

// ══════════════════════════════════════════════════════════════════════════════
// Combined Language Stack Dockerfiles
// ══════════════════════════════════════════════════════════════════════════════

function jvmDockerfile(): string {
  return `# syntax=docker/dockerfile:1
# ccbox/jvm - Java + Scala + Clojure + Kotlin
FROM ccbox_java:latest

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

function functionalDockerfile(): string {
  return `# syntax=docker/dockerfile:1
# ccbox/functional - Haskell + OCaml + Elixir/Erlang
FROM ccbox_base:latest

LABEL org.opencontainers.image.title="ccbox/functional"

# GHCup (manages GHC, Stack, Cabal for Haskell)
# Install to /opt/ghcup instead of ~/.ghcup for non-root access
ENV GHCUP_INSTALL_BASE_PREFIX=/opt
RUN curl --proto '=https' --tlsv1.2 -sSf https://get-ghcup.haskell.org | \\
    GHCUP_INSTALL_BASE_PREFIX=/opt BOOTSTRAP_HASKELL_NONINTERACTIVE=1 BOOTSTRAP_HASKELL_MINIMAL=1 sh \\
    && /opt/.ghcup/bin/ghcup install ghc --set \\
    && /opt/.ghcup/bin/ghcup install cabal --set \\
    && /opt/.ghcup/bin/ghcup install stack --set \\
    && ln -s /opt/.ghcup/bin/ghc /usr/local/bin/ghc \\
    && ln -s /opt/.ghcup/bin/ghci /usr/local/bin/ghci \\
    && ln -s /opt/.ghcup/bin/cabal /usr/local/bin/cabal \\
    && ln -s /opt/.ghcup/bin/stack /usr/local/bin/stack \\
    && ln -s /opt/.ghcup/bin/ghcup /usr/local/bin/ghcup \\
    && rm -rf /opt/.ghcup/cache /opt/.ghcup/tmp

# opam (OCaml package manager) - use system opam, configure for non-root
RUN apt-get update && apt-get install -y --no-install-recommends \\
    opam bubblewrap \\
    && rm -rf /var/lib/apt/lists/*
# Note: opam init should be run by user at runtime, not during build

# Erlang + Elixir
RUN apt-get update && apt-get install -y --no-install-recommends \\
    erlang elixir \\
    && rm -rf /var/lib/apt/lists/*
# Note: mix local.hex/rebar should be run by user at runtime
`;
}

function scriptingDockerfile(): string {
  return `# syntax=docker/dockerfile:1
# ccbox/scripting - Ruby + PHP + Perl + quality tools (web backends)
FROM ccbox_base:latest

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

function systemsDockerfile(): string {
  return `# syntax=docker/dockerfile:1
# ccbox/systems - C++ + Zig + Nim (systems programming)
# Extends cpp stack - includes CMake, Clang, Conan
FROM ccbox_cpp:latest

LABEL org.opencontainers.image.title="ccbox/systems"

# Zig
RUN ZIG_ARCH=\$(dpkg --print-architecture | sed 's/amd64/x86_64/;s/arm64/aarch64/') \\
    && ZIG_VER=\$(curl -sfL https://ziglang.org/download/index.json | jq -r '.master.version') \\
    && curl -fsSL "https://ziglang.org/builds/zig-linux-\${ZIG_ARCH}-\${ZIG_VER}.tar.xz" | tar -xJ -C /opt \\
    && ln -s /opt/zig-linux-\${ZIG_ARCH}-\${ZIG_VER}/zig /usr/local/bin/zig

# Nim - install then copy binaries (not symlink) to /usr/local/bin
RUN curl -fsSL https://nim-lang.org/choosenim/init.sh | sh -s -- -y \\
    && cp /root/.nimble/bin/nim /usr/local/bin/nim \\
    && cp /root/.nimble/bin/nimble /usr/local/bin/nimble \\
    && chmod 755 /usr/local/bin/nim /usr/local/bin/nimble \\
    && rm -rf /root/.nimble /root/.choosenim
`;
}

// ══════════════════════════════════════════════════════════════════════════════
// Use-Case Stack Dockerfiles
// ══════════════════════════════════════════════════════════════════════════════

function dataDockerfile(): string {
  return `# syntax=docker/dockerfile:1
# ccbox/data - Python + R + Julia (data science)
# Extends python stack - includes uv, ruff, pytest, mypy
FROM ccbox_python:latest

LABEL org.opencontainers.image.title="ccbox/data"

# R + common packages
RUN apt-get update && apt-get install -y --no-install-recommends \\
    r-base r-base-dev \\
    && rm -rf /var/lib/apt/lists/*

# Julia (latest stable) - dynamic version from julialang.org API
# Note: Path uses x64/aarch64 but filename uses x86_64/aarch64
RUN JULIA_PATH_ARCH=\$(dpkg --print-architecture | sed 's/amd64/x64/;s/arm64/aarch64/') \\
    && JULIA_FILE_ARCH=\$(dpkg --print-architecture | sed 's/amd64/x86_64/;s/arm64/aarch64/') \\
    && JULIA_VER=\$(curl -sfL https://julialang-s3.julialang.org/bin/versions.json | jq -r 'to_entries | map(select(.value.stable == true)) | sort_by(.key | split(".") | map(tonumber)) | last | .key') \\
    && JULIA_MINOR=\$(echo \$JULIA_VER | cut -d. -f1-2) \\
    && curl -fsSL "https://julialang-s3.julialang.org/bin/linux/\${JULIA_PATH_ARCH}/\${JULIA_MINOR}/julia-\${JULIA_VER}-linux-\${JULIA_FILE_ARCH}.tar.gz" | tar -xz -C /opt \\
    && ln -s /opt/julia-*/bin/julia /usr/local/bin/julia
`;
}

function aiDockerfile(): string {
  return `# syntax=docker/dockerfile:1
# ccbox/ai - Python + Jupyter + PyTorch + TensorFlow (ML/AI)
# Extends python stack - includes uv, ruff, pytest, mypy
FROM ccbox_python:latest

LABEL org.opencontainers.image.title="ccbox/ai"

# Jupyter + core ML libraries
# Using uv for faster installation
RUN UV_BREAK_SYSTEM_PACKAGES=1 uv pip install --system \\
    jupyter jupyterlab notebook \\
    numpy pandas scipy matplotlib seaborn \\
    scikit-learn \\
    && python -m compileall -q /usr/local/lib/python*/dist-packages 2>/dev/null || true

# PyTorch (CPU version - GPU requires nvidia-docker)
RUN UV_BREAK_SYSTEM_PACKAGES=1 uv pip install --system torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cpu

# TensorFlow (CPU version)
RUN UV_BREAK_SYSTEM_PACKAGES=1 uv pip install --system tensorflow \\
    && rm -rf /root/.cache/uv /root/.cache/pip
`;
}

function mobileDockerfile(): string {
  return `# syntax=docker/dockerfile:1
# ccbox/mobile - Dart + Flutter SDK + Android tools
# Extends dart stack - includes Dart SDK
FROM ccbox_dart:latest

LABEL org.opencontainers.image.title="ccbox/mobile"

# Flutter SDK (remove .git to save ~100MB)
RUN git clone https://github.com/flutter/flutter.git -b stable /opt/flutter --depth 1 \\
    && rm -rf /opt/flutter/.git \\
    && /opt/flutter/bin/flutter precache \\
    && /opt/flutter/bin/flutter config --no-analytics
ENV PATH="/opt/flutter/bin:$PATH"

# Android command-line tools (for flutter doctor)
# Create man directory first (required by openjdk post-install with --no-install-recommends)
RUN mkdir -p /usr/share/man/man1 \\
    && apt-get update && apt-get install -y --no-install-recommends \\
    openjdk-17-jdk-headless \\
    && rm -rf /var/lib/apt/lists/*
ENV JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64
`;
}

function gameDockerfile(): string {
  return `# syntax=docker/dockerfile:1
# ccbox/game - C++ + SDL2 + Lua + OpenGL (game development)
# Extends cpp stack - includes CMake, Clang, Conan
FROM ccbox_cpp:latest

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
FROM ccbox_web:latest

LABEL org.opencontainers.image.title="ccbox/fullstack"

${PYTHON_TOOLS_BASE}

# Database clients (PostgreSQL, MySQL, SQLite) + Redis CLI
RUN apt-get update && apt-get install -y --no-install-recommends \\
    postgresql-client default-mysql-client sqlite3 redis-tools \\
    && rm -rf /var/lib/apt/lists/*
`;
}

// ══════════════════════════════════════════════════════════════════════════════
// Stack to Dockerfile Generator Mapping
// ══════════════════════════════════════════════════════════════════════════════

/** Mapping of language stacks to their Dockerfile generator functions. */
export const DOCKERFILE_GENERATORS: Record<LanguageStack, () => string> = {
  // Core Language Stacks
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

  // Combined Language Stacks
  [LanguageStack.JVM]: jvmDockerfile,
  [LanguageStack.FUNCTIONAL]: functionalDockerfile,
  [LanguageStack.SCRIPTING]: scriptingDockerfile,
  [LanguageStack.SYSTEMS]: systemsDockerfile,

  // Use-Case Stacks
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

/** Export PYTHON_TOOLS_BASE for use in project Dockerfile generation. */
export { PYTHON_TOOLS_BASE };
