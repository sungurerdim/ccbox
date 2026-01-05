"""Docker file generation for ccbox.

Dependency direction:
    This module imports from: paths, config
    It may be imported by: cli.py
    It should NOT import from: cli, docker, sleepctl
"""

from __future__ import annotations

import os
import shutil
import sys
from pathlib import Path
from typing import TYPE_CHECKING, Callable

from .config import (
    Config,
    LanguageStack,
    get_claude_config_dir,
    get_container_name,
    get_image_name,
)
from .constants import BUILD_DIR
from .paths import resolve_for_docker

if TYPE_CHECKING:
    from .deps import DepsInfo, DepsMode

# Container user home directory (SSOT - used throughout Dockerfile templates)
CONTAINER_HOME = "/home/node"

# Common system packages (minimal - matches original)
COMMON_TOOLS = """
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
    && curl -sL "https://github.com/mikefarah/yq/releases/latest/download/yq_linux_${YQ_ARCH}" -o /usr/local/bin/yq \\
    && chmod +x /usr/local/bin/yq \\
    # git-delta (syntax-highlighted diffs for better code review)
    && DELTA_VER="0.18.2" \\
    && DELTA_ARCH=$(dpkg --print-architecture) \\
    && curl -sL "https://github.com/dandavison/delta/releases/download/${DELTA_VER}/git-delta_${DELTA_VER}_${DELTA_ARCH}.deb" -o /tmp/delta.deb \\
    && dpkg -i /tmp/delta.deb && rm /tmp/delta.deb

# Locale and performance environment
ENV LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 \\
    # Node.js performance: disable npm funding/update checks, increase GC efficiency
    NODE_ENV=production \\
    NPM_CONFIG_FUND=false \\
    NPM_CONFIG_UPDATE_NOTIFIER=false \\
    # Git performance: disable advice messages, use parallel index
    GIT_ADVICE=0 \\
    GIT_INDEX_THREADS=0
"""

# Node.js installation snippet for non-node base images
NODE_INSTALL = """
# Node.js (current)
RUN curl -fsSL https://deb.nodesource.com/setup_current.x | bash - \\
    && apt-get install -y --no-install-recommends nodejs \\
    && rm -rf /var/lib/apt/lists/*
"""

# Python dev tools (without CCO)
PYTHON_TOOLS_BASE = """
# uv (ultra-fast Python package manager - 10-100x faster than pip)
RUN curl -LsSf https://astral.sh/uv/install.sh | sh
ENV PATH="/root/.local/bin:$PATH"

# Python dev tools (ruff, mypy, pytest) - installed as isolated tools
# Using 'uv tool' avoids PEP 668 externally-managed-environment errors
RUN uv tool install ruff && uv tool install mypy && uv tool install pytest
ENV PATH="/root/.local/bin:$PATH"
"""

# CCO installation (cco package includes cco-install command)
# ARG CCO_CACHE_BUST forces Docker layer cache invalidation
# Post-build: build.py runs `cco-install` to copy rules/agents to host ~/.claude
CCO_INSTALL = f"""
# Claude Code Optimizer (CCO) - fresh install every build (using uv for speed)
# Using 'uv tool' avoids PEP 668 externally-managed-environment errors
# PATH includes both user and root locations (uv uses HOME which varies)
ARG CCO_CACHE_BUST=1
RUN uv tool install --reinstall \\
    git+https://github.com/sungurerdim/ClaudeCodeOptimizer.git \\
    && echo "CCO installed: $(date) [cache_bust=$CCO_CACHE_BUST]"
ENV PATH="{CONTAINER_HOME}/.local/bin:/root/.local/bin:$PATH"
"""

# Claude Code + Node.js dev tools
NODE_TOOLS_BASE = """
# Node.js dev tools (typescript, eslint, vitest) + Claude Code - latest versions
RUN npm config set fund false && npm config set update-notifier false \\
    && npm install -g typescript eslint vitest @anthropic-ai/claude-code --force \\
    && npm cache clean --force
"""

# Entrypoint setup
# Starts as root, entrypoint switches to host UID dynamically (cross-platform)
ENTRYPOINT_SETUP = """
WORKDIR /home/node/project

COPY --chmod=755 entrypoint.sh /usr/local/bin/entrypoint.sh

ENV HOME=/home/node

# Start as root - entrypoint will switch to host user's UID/GID
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
"""


def _minimal_dockerfile() -> str:
    """MINIMAL stack: node:lts-slim + Python (no CCO)."""
    return f"""# syntax=docker/dockerfile:1
# ccbox:minimal - Node.js + Python (no CCO)
FROM node:lts-slim

LABEL org.opencontainers.image.title="ccbox:minimal"

# Timezone passthrough from host
ARG TZ=UTC
ENV TZ="${{TZ}}"

ENV DEBIAN_FRONTEND=noninteractive
{COMMON_TOOLS}
{PYTHON_TOOLS_BASE}
{NODE_TOOLS_BASE}
{ENTRYPOINT_SETUP}
"""


def _base_dockerfile() -> str:
    """BASE stack: minimal + CCO."""
    return f"""# syntax=docker/dockerfile:1
# ccbox:base - minimal + CCO (default)
FROM ccbox:minimal

LABEL org.opencontainers.image.title="ccbox:base"
{CCO_INSTALL}
"""


def _go_dockerfile() -> str:
    """GO stack: golang:latest + Node.js + Python + CCO."""
    return f"""# syntax=docker/dockerfile:1
# ccbox:go - Go + Node.js + Python + CCO
FROM golang:latest

LABEL org.opencontainers.image.title="ccbox:go"

# Timezone passthrough from host
ARG TZ=UTC
ENV TZ="${{TZ}}"

ENV DEBIAN_FRONTEND=noninteractive
{NODE_INSTALL}{COMMON_TOOLS}
{PYTHON_TOOLS_BASE}
{NODE_TOOLS_BASE}
{CCO_INSTALL}
# golangci-lint (latest)
RUN curl -sSfL https://raw.githubusercontent.com/golangci/golangci-lint/master/install.sh | sh -s -- -b /usr/local/bin
{ENTRYPOINT_SETUP}
"""


def _rust_dockerfile() -> str:
    """RUST stack: rust:latest + Node.js + Python + CCO."""
    return f"""# syntax=docker/dockerfile:1
# ccbox:rust - Rust + Node.js + Python + CCO
FROM rust:latest

LABEL org.opencontainers.image.title="ccbox:rust"

# Timezone passthrough from host
ARG TZ=UTC
ENV TZ="${{TZ}}"

ENV DEBIAN_FRONTEND=noninteractive
{NODE_INSTALL}{COMMON_TOOLS}
{PYTHON_TOOLS_BASE}
{NODE_TOOLS_BASE}
{CCO_INSTALL}
# Rust tools (clippy + rustfmt)
RUN rustup component add clippy rustfmt
{ENTRYPOINT_SETUP}
"""


def _java_dockerfile() -> str:
    """JAVA stack: eclipse-temurin:latest + Node.js + Python + CCO."""
    return f"""# syntax=docker/dockerfile:1
# ccbox:java - Java (Temurin LTS) + Node.js + Python + CCO
FROM eclipse-temurin:latest

LABEL org.opencontainers.image.title="ccbox:java"

# Timezone passthrough from host
ARG TZ=UTC
ENV TZ="${{TZ}}"

ENV DEBIAN_FRONTEND=noninteractive
{NODE_INSTALL}{COMMON_TOOLS}
{PYTHON_TOOLS_BASE}
{NODE_TOOLS_BASE}
{CCO_INSTALL}
# Maven (latest from Apache)
RUN set -eux; \\
    MVN_VER=$(curl -sfL https://api.github.com/repos/apache/maven/releases/latest | jq -r .tag_name | sed 's/maven-//'); \\
    curl -sfL "https://archive.apache.org/dist/maven/maven-3/${{MVN_VER}}/binaries/apache-maven-${{MVN_VER}}-bin.tar.gz" | tar -xz -C /opt; \\
    ln -s /opt/apache-maven-${{MVN_VER}}/bin/mvn /usr/local/bin/mvn
{ENTRYPOINT_SETUP}
"""


def _web_dockerfile() -> str:
    """WEB stack: ccbox:base + pnpm (fullstack)."""
    return """# syntax=docker/dockerfile:1
# ccbox:web - Node.js + pnpm + Python + CCO (fullstack)
# Layered on ccbox:base for efficient caching
FROM ccbox:base

LABEL org.opencontainers.image.title="ccbox:web"

# pnpm (latest)
RUN npm install -g pnpm --force && npm cache clean --force
"""


def _full_dockerfile() -> str:
    """FULL stack: ccbox:base + all languages (Go + Rust + Java + pnpm)."""
    return """# syntax=docker/dockerfile:1
# ccbox:full - All languages (Go + Rust + Java + pnpm)
# Layered on ccbox:base for efficient caching
FROM ccbox:base

LABEL org.opencontainers.image.title="ccbox:full"

USER root

# Go (latest) + golangci-lint - auto-detect architecture
RUN set -eux; \
    GO_ARCH=$(dpkg --print-architecture); \
    GO_VER=$(curl -fsSL https://go.dev/VERSION?m=text | head -1); \
    curl -fsSL "https://go.dev/dl/${GO_VER}.linux-${GO_ARCH}.tar.gz" | tar -C /usr/local -xzf -; \
    curl -sSfL https://raw.githubusercontent.com/golangci/golangci-lint/master/install.sh | sh -s -- -b /usr/local/bin
ENV PATH=$PATH:/usr/local/go/bin GOPATH=/home/node/go
ENV PATH=$PATH:$GOPATH/bin

# Rust (latest) + clippy + rustfmt - install for node user
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y \
    && /root/.cargo/bin/rustup component add clippy rustfmt
ENV PATH="/root/.cargo/bin:$PATH"

# Java (Temurin LTS) + Maven - auto-detect architecture
RUN set -eux; \
    JAVA_ARCH=$(dpkg --print-architecture | sed 's/amd64/x64/;s/arm64/aarch64/'); \
    TEMURIN_VER=$(curl -sfL "https://api.adoptium.net/v3/info/available_releases" | jq -r '.most_recent_lts'); \
    curl -sfL "https://api.adoptium.net/v3/binary/latest/${TEMURIN_VER}/ga/linux/${JAVA_ARCH}/jdk/hotspot/normal/eclipse" -o /tmp/jdk.tar.gz; \
    mkdir -p /usr/lib/jvm && tar -xzf /tmp/jdk.tar.gz -C /usr/lib/jvm; \
    ln -s /usr/lib/jvm/jdk-* /usr/lib/jvm/temurin; \
    MVN_VER=$(curl -sfL https://api.github.com/repos/apache/maven/releases/latest | jq -r .tag_name | sed 's/maven-//'); \
    curl -sfL "https://archive.apache.org/dist/maven/maven-3/${MVN_VER}/binaries/apache-maven-${MVN_VER}-bin.tar.gz" | tar -xz -C /opt; \
    ln -s /opt/apache-maven-${MVN_VER}/bin/mvn /usr/local/bin/mvn; \
    rm -f /tmp/jdk.tar.gz
ENV JAVA_HOME=/usr/lib/jvm/temurin PATH=$JAVA_HOME/bin:$PATH

# pnpm (latest)
RUN npm install -g pnpm --force && npm cache clean --force

USER node
"""


# Stack to Dockerfile generator mapping
DOCKERFILE_GENERATORS: dict[LanguageStack, Callable[[], str]] = {
    LanguageStack.MINIMAL: _minimal_dockerfile,
    LanguageStack.BASE: _base_dockerfile,
    LanguageStack.GO: _go_dockerfile,
    LanguageStack.RUST: _rust_dockerfile,
    LanguageStack.JAVA: _java_dockerfile,
    LanguageStack.WEB: _web_dockerfile,
    LanguageStack.FULL: _full_dockerfile,
}


def generate_dockerfile(stack: LanguageStack) -> str:
    """Generate Dockerfile content for the given stack."""
    generator = DOCKERFILE_GENERATORS.get(stack)
    if generator:
        return generator()
    return _minimal_dockerfile()  # pragma: no cover - fallback for unknown stacks


def _read_entrypoint_from_file() -> str | None:
    """Try to read entrypoint script from package resources.

    Returns script content if available, None if file not found.
    Script file is in scripts/entrypoint.sh for external editing/documentation.
    """
    try:
        # Python 3.9+ with importlib.resources
        import importlib.resources as resources

        try:
            # Python 3.11+ API
            files = resources.files("ccbox.scripts")
            script_path = files.joinpath("entrypoint.sh")
            return script_path.read_text(encoding="utf-8")
        except (AttributeError, FileNotFoundError, TypeError):
            # Fallback for older Python or missing file
            return None
    except ImportError:
        return None


def generate_entrypoint() -> str:
    """Generate entrypoint script with comprehensive debugging support.

    The script content is maintained in scripts/entrypoint.sh for easier
    editing and documentation. Falls back to embedded version if file
    not found in package resources.

    Security model:
    - Container runs as host user via Docker --user flag (Linux/macOS)
    - On Windows, Docker Desktop handles UID/GID automatically
    - no-new-privileges is enabled (no setuid/setgid allowed)
    - All capabilities dropped except minimal set

    Debug output is controlled by CCBOX_DEBUG environment variable:
    - CCBOX_DEBUG=1: Basic progress messages
    - CCBOX_DEBUG=2: Verbose with environment details

    Mount strategy:
    NORMAL mode (default):
    - Host ~/.claude -> /home/node/.claude (rw, fully accessible)
    - CCO files from /opt/cco copied to ~/.claude (merges with host's)
    - CCO CLAUDE.md (if exists) copied to project .claude
    - Project .claude -> persistent (rw)
    - tmpfs for container internals (.npm, .config, .cache)

    VANILLA mode (--bare):
    - Host ~/.claude -> /home/node/.claude (rw for credentials/settings)
    - tmpfs overlays for rules/commands/agents/skills (host's hidden)
    - CLAUDE.md hidden via /dev/null
    - No CCO injection

    Claude Code reads project .claude first, then falls back to global ~/.claude.
    """
    # Try to read from package resources first
    script_content = _read_entrypoint_from_file()
    if script_content:
        return script_content

    # Fallback to embedded script (kept in sync with scripts/entrypoint.sh)
    return """#!/bin/bash

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

# CCO files are installed during 'ccbox build' (not at runtime)
# This keeps container startup fast and predictable
if [[ -n "$CCBOX_BARE_MODE" ]]; then
    _log "Bare mode: vanilla Claude Code (no CCO)"
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
export NODE_OPTIONS="${NODE_OPTIONS:-} --max-old-space-size=$(( $(free -m | awk '/^Mem:/{print $2}') * 3 / 4 )) --max-semi-space-size=64"
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

# Use stdbuf for unbuffered output in non-TTY mode (--print with pipes)
if [[ -t 1 ]]; then
    # TTY mode: Enable synchronized output (mode 2026) if terminal supports it
    # This reduces flickering by batching terminal updates atomically
    # Terminals that don't support it will silently ignore the sequence
    printf '\\e[?2026h' 2>/dev/null || true
    exec $PRIORITY_CMD claude --dangerously-skip-permissions "$@"
else
    exec $PRIORITY_CMD stdbuf -oL -eL claude --dangerously-skip-permissions "$@"
fi
"""


def write_build_files(stack: LanguageStack) -> Path:
    """Write Dockerfile and entrypoint to build directory."""
    build_dir = Path(BUILD_DIR) / stack.value
    build_dir.mkdir(parents=True, exist_ok=True)

    # Write with Unix line endings (open with newline="" to prevent OS conversion)
    for filename, content in [
        ("Dockerfile", generate_dockerfile(stack)),
        ("entrypoint.sh", generate_entrypoint()),
    ]:
        with open(build_dir / filename, "w", encoding="utf-8", newline="\n") as f:
            f.write(content)

    return build_dir


def generate_project_dockerfile(
    base_image: str,
    deps_list: list[DepsInfo],
    deps_mode: DepsMode,
    project_path: Path,
) -> str:
    """Generate project-specific Dockerfile with dependencies.

    Args:
        base_image: Base ccbox image to build on (e.g., ccbox:base).
        deps_list: List of detected dependencies.
        deps_mode: Dependency installation mode (all or prod).
        project_path: Path to project directory (for checking file existence).

    Returns:
        Dockerfile content as string.
    """
    from .deps import get_install_commands

    lines = [
        "# syntax=docker/dockerfile:1",
        "# Project-specific image with dependencies",
        f"FROM {base_image}",
        "",
        "USER root",
        "WORKDIR /tmp/deps",
        "",
    ]

    # Collect candidate dependency files from detected package managers
    candidate_files: set[str] = set()
    for deps in deps_list:
        for f in deps.files:
            # Skip glob patterns
            if "*" not in f:
                candidate_files.add(f)

    # Add common dependency files that may not be in deps_list.files
    common_files = {
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
    }
    candidate_files.update(common_files)

    # Filter to only files that actually exist in the project
    existing_files = {f for f in candidate_files if (project_path / f).exists()}

    # Copy only existing dependency files
    if existing_files:
        lines.append("# Copy dependency files")
        for pattern in sorted(existing_files):
            lines.append(f"COPY {pattern} ./")

    lines.append("")

    # Get install commands
    install_cmds = get_install_commands(deps_list, deps_mode)

    if install_cmds:
        lines.append("# Install dependencies")
        for cmd in install_cmds:
            # Use BuildKit cache mounts for package caches
            lines.append(f"RUN {cmd} || echo 'Warning: {cmd.split()[0]} install failed'")

    lines.extend(
        [
            "",
            "# Clean up and switch back to node user",
            "WORKDIR /home/node/project",
            "USER node",
            "",
        ]
    )

    return "\n".join(lines)


def _transform_slash_command(prompt: str | None) -> str | None:
    """Transform slash command to file reference for --print mode compatibility.

    Claude Code's --print mode doesn't load custom slash commands from
    ~/.claude/commands/. This workaround transforms slash commands into
    explicit file read instructions.

    Args:
        prompt: Original prompt, may start with "/" for slash commands.

    Returns:
        Transformed prompt if slash command detected, otherwise original.

    Example:
        "/cco-config --auto" -> "Read /home/node/.claude/commands/cco-config.md
                                 and execute. Args: --auto"
    """
    if not prompt or not prompt.startswith("/"):
        return prompt

    # Parse: "/cco-config --auto" -> cmd="cco-config", args="--auto"
    parts = prompt.split(maxsplit=1)
    cmd_name = parts[0][1:]  # Remove leading "/"
    cmd_args = parts[1] if len(parts) > 1 else ""

    # Skip built-in commands (they work in --print mode)
    builtin_commands = {
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
    }
    if cmd_name in builtin_commands:
        return prompt

    # Transform custom command to file reference
    cmd_path = f"/home/node/.claude/commands/{cmd_name}.md"
    instruction = f"Read the custom command file at {cmd_path} and execute its instructions."
    if cmd_args:
        instruction += f" Arguments: {cmd_args}"

    return instruction


def _add_bare_mode_mounts(cmd: list[str]) -> None:
    """Add bare/vanilla mode mounts to isolate host customizations."""
    user_dirs = ["rules", "commands", "agents", "skills"]
    for d in user_dirs:
        cmd.extend(["--tmpfs", f"/home/node/.claude/{d}:rw,size=16m,uid=1000,gid=1000,mode=0755"])
    # Hide host's CLAUDE.md
    cmd.extend(["-v", "/dev/null:/home/node/.claude/CLAUDE.md:ro"])
    # Skip CCO injection in entrypoint
    cmd.extend(["-e", "CCBOX_BARE_MODE=1"])


def _add_git_env(cmd: list[str], config: Config) -> None:
    """Add git author/committer environment variables."""
    if config.git_name:
        cmd.extend(["-e", f"GIT_AUTHOR_NAME={config.git_name}"])
        cmd.extend(["-e", f"GIT_COMMITTER_NAME={config.git_name}"])
    if config.git_email:
        cmd.extend(["-e", f"GIT_AUTHOR_EMAIL={config.git_email}"])
        cmd.extend(["-e", f"GIT_COMMITTER_EMAIL={config.git_email}"])


def _add_terminal_env(cmd: list[str]) -> None:
    """Passthrough terminal environment variables for clipboard/image support.

    Claude Code uses these to detect terminal capabilities:
    - TERM/COLORTERM: Basic terminal type and color support
    - COLUMNS/LINES: Terminal dimensions for proper layout
    - TERM_PROGRAM: Terminal emulator name (iTerm.app, Apple_Terminal, etc.)
    - Terminal-specific vars: Enable protocol detection (OSC 52, OSC 1337, Kitty graphics)

    Without these, Claude Code can't use terminal-native clipboard/image features.
    """
    # Terminal type with fallbacks (required for basic operation)
    term = os.environ.get("TERM", "xterm-256color")
    colorterm = os.environ.get("COLORTERM", "truecolor")
    cmd.extend(["-e", f"TERM={term}"])
    cmd.extend(["-e", f"COLORTERM={colorterm}"])

    # Terminal dimensions: critical for Claude Code to use full terminal width
    # Docker TTY mode doesn't propagate dimensions automatically
    size = shutil.get_terminal_size(fallback=(120, 40))
    cmd.extend(["-e", f"COLUMNS={size.columns}"])
    cmd.extend(["-e", f"LINES={size.lines}"])

    # Terminal program info (passthrough only if set)
    term_program_vars = [
        "TERM_PROGRAM",  # Terminal emulator (iTerm.app, Apple_Terminal, vscode, etc.)
        "TERM_PROGRAM_VERSION",  # Terminal version
    ]

    # Terminal-specific variables for clipboard/image protocols
    terminal_specific_vars = [
        # iTerm2 (macOS) - OSC 1337 image protocol
        "ITERM_SESSION_ID",
        "ITERM_PROFILE",
        # Kitty - OSC 5522 clipboard, Kitty graphics protocol
        "KITTY_WINDOW_ID",
        "KITTY_PID",
        # WezTerm - supports both OSC 1337 and Kitty protocols
        "WEZTERM_PANE",
        "WEZTERM_UNIX_SOCKET",
        # Ghostty - modern terminal with Kitty protocol support
        "GHOSTTY_RESOURCES_DIR",
        # Alacritty - OSC 52 clipboard
        "ALACRITTY_SOCKET",
        "ALACRITTY_LOG",
        # VS Code integrated terminal
        "VSCODE_GIT_IPC_HANDLE",
        "VSCODE_INJECTION",
        # Windows Terminal
        "WT_SESSION",
        "WT_PROFILE_ID",
        # Konsole
        "KONSOLE_VERSION",
        "KONSOLE_DBUS_SESSION",
        # Tmux/Screen (multiplexers affect protocol support)
        "TMUX",
        "TMUX_PANE",
        "STY",  # Screen session
    ]

    passthrough_vars = term_program_vars + terminal_specific_vars

    for var in passthrough_vars:
        value = os.environ.get(var)
        if value:
            cmd.extend(["-e", f"{var}={value}"])


def _add_security_options(cmd: list[str]) -> None:
    """Add security hardening options to Docker command.

    Security model: Container runs as host user via --user flag, eliminating
    the need for privilege switching (gosu) and enabling no-new-privileges.
    This provides maximum security while maintaining correct file ownership.
    """
    cmd.extend(
        [
            "--cap-drop=ALL",  # Drop all Linux capabilities
            "--security-opt=no-new-privileges",  # Prevent privilege escalation
            "--pids-limit=2048",  # Fork bomb protection (512 too low for heavy agent use)
            "--init",  # Proper signal handling, zombie reaping (tini)
            "--shm-size=256m",  # Shared memory for Node.js/Chrome (default 64MB too small)
            "--ulimit",
            "nofile=65535:65535",  # File descriptor limit for parallel subprocess spawning
            "--memory-swappiness=0",  # Minimize swap usage for better performance
        ]
    )


def _add_tmpfs_mounts(cmd: list[str], dirname: str) -> None:
    """Add tmpfs mounts for workdir and temp directories."""
    cmd.extend(
        [
            "-w",
            f"/home/node/{dirname}",  # Workdir: dynamic based on directory name
            "--tmpfs",
            "/tmp:rw,noexec,nosuid,size=512m",  # Temp directory in memory
            "--tmpfs",
            "/var/tmp:rw,noexec,nosuid,size=256m",  # Var temp in memory
        ]
    )


def _add_dns_options(cmd: list[str]) -> None:
    """Add DNS optimization options to reduce lookup latency."""
    cmd.extend(
        [
            "--dns-opt",
            "ndots:1",  # Reduce lookup attempts (default ndots:5 causes 5+ queries)
            "--dns-opt",
            "timeout:1",
            "--dns-opt",
            "attempts:1",
        ]
    )


def _get_host_user_ids() -> tuple[int, int]:
    """Get host UID and GID for --user flag (cross-platform).

    Returns:
        Tuple of (uid, gid). On Linux/macOS uses actual host IDs.
        On Windows uses 1000:1000 (Docker's default node user).
    """
    if sys.platform == "win32":
        # Windows: Use node user's UID/GID (1000:1000 in Docker images)
        # This ensures Claude Code runs as node, not root
        return (1000, 1000)

    # Linux/macOS: Use actual host UID/GID
    return (os.getuid(), os.getgid())


def _add_user_mapping(cmd: list[str]) -> None:
    """Add --user flag for host UID/GID mapping.

    On Linux/macOS: Maps container user to host user for correct file ownership.
    On Windows: Uses node user (1000:1000) to run as non-root.
    """
    uid, gid = _get_host_user_ids()
    cmd.extend(["--user", f"{uid}:{gid}"])


def _get_host_timezone() -> str:
    """Detect host timezone in IANA format (cross-platform).

    Detection order:
    1. TZ environment variable (if set)
    2. /etc/timezone file (Debian/Ubuntu)
    3. /etc/localtime symlink target (Linux/macOS)
    4. Fallback to UTC

    Returns:
        IANA timezone string (e.g., "Europe/Istanbul", "America/New_York")
    """
    # 1. Check TZ environment variable
    tz_env = os.environ.get("TZ")
    if tz_env and "/" in tz_env:  # IANA format has slash
        return tz_env

    # 2. Try /etc/timezone (Debian/Ubuntu)
    try:
        tz_file = Path("/etc/timezone")
        if tz_file.exists():
            tz = tz_file.read_text().strip()
            if tz and "/" in tz:
                return tz
    except (OSError, PermissionError):
        pass

    # 3. Try /etc/localtime symlink (Linux/macOS)
    try:
        localtime = Path("/etc/localtime")
        if localtime.is_symlink():
            target = os.readlink(localtime)
            # Extract timezone from path like /usr/share/zoneinfo/Europe/Istanbul
            if "zoneinfo/" in target:
                tz = target.split("zoneinfo/", 1)[1]
                if "/" in tz:
                    return tz
    except (OSError, PermissionError):
        pass

    # 4. Fallback to UTC
    return "UTC"


def _add_claude_env(cmd: list[str]) -> None:
    """Add Claude Code environment variables."""
    # Timezone passthrough from host (cross-platform detection)
    tz = _get_host_timezone()
    cmd.extend(["-e", f"TZ={tz}"])

    cmd.extend(
        [
            "-e",
            "FORCE_COLOR=1",  # Ensure ANSI colors enabled (fallback for TTY detection)
            "-e",
            "CLAUDE_CONFIG_DIR=/home/node/.claude",  # Override default ~/.config/claude
            "-e",
            "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1",  # Disable telemetry
            "-e",
            "DISABLE_AUTOUPDATER=1",  # Disable auto-updates (use image rebuild)
            "-e",
            "PYTHONUNBUFFERED=1",  # Force unbuffered output for streaming
            "-e",
            # Node.js optimizations: suppress warnings, reduce GC pauses
            "NODE_OPTIONS=--no-warnings --disable-warning=ExperimentalWarning "
            "--disable-warning=DeprecationWarning",
            "-e",
            "NODE_NO_READLINE=1",  # Reduce readline interference for cleaner output
            "-e",
            # Node.js 22+: compile cache for 40% faster subsequent startups
            "NODE_COMPILE_CACHE=/home/node/.cache/node-compile",
        ]
    )


def _build_claude_args(
    *,
    model: str | None,
    debug: int,
    prompt: str | None,
    quiet: bool,
    append_system_prompt: str | None,
) -> list[str]:
    """Build Claude CLI arguments list."""
    # CRITICAL: Always pass --dangerously-skip-permissions here (not just in entrypoint)
    # This ensures bypass works even with old/cached images that may have different entrypoints
    args: list[str] = ["--dangerously-skip-permissions"]

    if model:
        args.extend(["--model", model])

    # Derive flags from parameters:
    # - stream: -dd enables stream mode (real-time tool call output)
    # - verbose: required by stream OR when prompt is set (unless quiet)
    stream = debug >= 2
    verbose = stream or (bool(prompt) and not quiet)

    if verbose:
        args.append("--verbose")

    if append_system_prompt:
        args.extend(["--append-system-prompt", append_system_prompt])

    # Print mode: required for non-interactive usage (prompt or quiet)
    if quiet or prompt:
        args.append("--print")
        # Stream mode: use stream-json for real-time output
        if stream:
            args.extend(["--output-format", "stream-json"])

    # Prompt: passed as positional argument (Claude Code doesn't have --prompt flag)
    if prompt:
        args.append(prompt)

    return args


def get_docker_run_cmd(
    config: Config,
    project_path: Path,
    project_name: str,
    stack: LanguageStack,
    *,
    bare: bool = False,
    debug_logs: bool = False,
    debug: int = 0,
    prompt: str | None = None,
    model: str | None = None,
    quiet: bool = False,
    append_system_prompt: str | None = None,
    project_image: str | None = None,
    deps_list: list[DepsInfo] | None = None,
    unrestricted: bool = False,
) -> list[str]:
    """Generate docker run command with full cleanup on exit.

    Args:
        config: ccbox configuration.
        project_path: Path to the project directory.
        project_name: Name of the project.
        stack: Language stack to use.
        bare: Vanilla mode - fresh Claude Code with NO host config mounted.
            Only .credentials.json is mounted (read-only) for authentication.
            Creates ephemeral tmpfs for .claude directory (all changes lost on exit).
            Use this to test vanilla Claude Code without CCO rules/commands/settings.
        debug_logs: If True, persist debug logs; otherwise use tmpfs (ephemeral).
        debug: Debug level (0=off, 1=basic, 2=verbose+stream).
        prompt: Initial prompt (enables --print, implies --verbose unless quiet).
        model: Model to use (e.g., opus, sonnet, haiku).
        quiet: Quiet mode (enables --print, shows only Claude's responses).
        append_system_prompt: Custom instructions to append to Claude's system prompt.
        project_image: Project-specific image with deps (overrides stack image).
        deps_list: List of detected dependencies (for cache mounts).
        unrestricted: If True, remove CPU/priority limits for full performance.

    Raises:
        ConfigPathError: If claude_config_dir path validation fails.

    Derived flags:
        - verbose: enabled when prompt is set (unless quiet) or debug >= 2
        - stream: enabled when debug >= 2 (uses --output-format=stream-json)
    """
    # Use project-specific image if available, otherwise stack image
    image_name = project_image if project_image else get_image_name(stack)
    claude_config = get_claude_config_dir(config)

    # Transform slash commands for --print mode compatibility
    prompt = _transform_slash_command(prompt)

    # Use centralized container naming with unique suffix
    container_name = get_container_name(project_name)

    # Use directory name (not full path) for workdir
    dirname = project_path.name

    # Convert path to Docker-compatible format (handles Windows/WSL paths)
    docker_project_path = resolve_for_docker(project_path)

    cmd = [
        "docker",
        "run",
        "--rm",  # Remove container on exit
    ]

    # TTY allocation logic:
    # - Interactive mode (no prompt): need TTY for Claude's TUI
    # - Print mode (prompt/quiet): no TTY needed, just pipe output
    # Windows quirk: -t without proper TTY can open separate window
    is_interactive = prompt is None and not quiet

    if is_interactive and sys.stdin.isatty():
        cmd.append("-it")  # Interactive TTY
    else:
        cmd.append("-i")  # Interactive only (no TTY)

    cmd.extend(
        [
            "--name",
            container_name,
            # Mounts: project (rw)
            "-v",
            f"{docker_project_path}:/home/node/{dirname}:rw",
        ]
    )

    # Convert claude config path for Docker mount
    docker_claude_config = resolve_for_docker(claude_config)

    # Mount host .claude directory (rw for full access)
    cmd.extend(["-v", f"{docker_claude_config}:/home/node/.claude:rw"])

    if bare:
        _add_bare_mode_mounts(cmd)

    # Add container configuration
    _add_tmpfs_mounts(cmd, dirname)
    _add_user_mapping(cmd)  # --user for correct file ownership (Linux/macOS)
    _add_security_options(cmd)
    _add_dns_options(cmd)

    # Resource limits: soft limits that only activate under contention
    # --cpu-shares=512 (default 1024): lower priority when competing for CPU
    # Note: No memory limit - allows large project builds (webpack, tsc, next build)
    if not unrestricted:
        cmd.extend(["--cpu-shares=512"])

    # Environment variables
    _add_terminal_env(cmd)
    _add_claude_env(cmd)

    # Debug mode for entrypoint logging (0=off, 1=basic, 2=verbose)
    if debug > 0:
        cmd.extend(["-e", f"CCBOX_DEBUG={debug}"])

    # Unrestricted mode: disable nice/ionice in entrypoint
    if unrestricted:
        cmd.extend(["-e", "CCBOX_UNRESTRICTED=1"])

    # Debug logs: tmpfs by default (ephemeral), persistent with --debug-logs
    if not debug_logs:
        cmd.extend(["--tmpfs", "/home/node/.claude/debug:rw,size=512m,mode=0777"])

    _add_git_env(cmd, config)

    cmd.append(image_name)

    # Claude CLI arguments (passed to entrypoint -> claude command)
    claude_args = _build_claude_args(
        model=model,
        debug=debug,
        prompt=prompt,
        quiet=quiet,
        append_system_prompt=append_system_prompt,
    )
    cmd.extend(claude_args)

    return cmd
