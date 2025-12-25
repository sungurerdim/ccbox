"""Docker file generation for ccbox."""

from __future__ import annotations

import sys
from pathlib import Path
from typing import TYPE_CHECKING, Callable

from .config import (
    Config,
    LanguageStack,
    get_claude_config_dir,
    get_config_dir,
    get_container_name,
    get_image_name,
)
from .paths import resolve_for_docker

if TYPE_CHECKING:
    from .deps import DepsInfo, DepsMode

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
    && chmod +x /usr/local/bin/yq

ENV LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8
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
# Python dev tools (ruff, mypy, pytest)
RUN pip install --break-system-packages --no-cache-dir ruff mypy pytest
"""

# CCO installation (pip + install to /opt/cco/)
CCO_INSTALL = """
# Claude Code Optimizer (CCO) - install package and files to /opt/cco/
# Files are copied to tmpfs at runtime (no host writes)
USER root
RUN pip install --break-system-packages --no-cache-dir \\
    git+https://github.com/sungurerdim/ClaudeCodeOptimizer.git \\
    && cco-install --dir /opt/cco \\
    && chown -R node:node /opt/cco
USER node
"""

# Claude Code only (no CCO setup)
NODE_TOOLS_BASE = """
# Claude Code
RUN npm config set fund false && npm config set update-notifier false \\
    && npm install -g @anthropic-ai/claude-code --force \\
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
    """MINIMAL stack: node:slim + Python (no CCO)."""
    return f"""# syntax=docker/dockerfile:1
# ccbox:minimal - Node.js + Python (no CCO)
FROM node:slim

LABEL org.opencontainers.image.title="ccbox:minimal"

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


def generate_entrypoint() -> str:
    """Generate entrypoint script with comprehensive debugging support.

    Debug output is controlled by CCBOX_DEBUG environment variable:
    - CCBOX_DEBUG=1: Basic progress messages
    - CCBOX_DEBUG=2: Verbose with environment details

    Mount strategy:
    NORMAL mode (default):
    - Host ~/.claude → /home/node/.claude (rw, fully accessible)
    - CCO files from /opt/cco copied to ~/.claude (merges with host's)
    - CCO CLAUDE.md (if exists) copied to project .claude
    - Project .claude → persistent (rw)

    VANILLA mode (--bare):
    - Host ~/.claude → /home/node/.claude (rw for credentials/settings)
    - tmpfs overlays for rules/commands/agents/skills (host's hidden)
    - CLAUDE.md hidden via /dev/null
    - No CCO injection

    Claude Code reads project .claude first, then falls back to global ~/.claude.
    """
    return """#!/bin/bash

# Debug logging function (outputs to stderr to not interfere with Claude output)
_log() {
    if [[ -n "$CCBOX_DEBUG" ]]; then
        echo "[ccbox] $*" >&2
    fi
}

_log_verbose() {
    if [[ "$CCBOX_DEBUG" == "2" ]]; then
        echo "[ccbox:debug] $*" >&2
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

# Detect host UID/GID from mounted directory
HOST_UID=$(stat -c '%u' "$PWD" 2>/dev/null || stat -f '%u' "$PWD" 2>/dev/null || echo "1000")
HOST_GID=$(stat -c '%g' "$PWD" 2>/dev/null || stat -f '%g' "$PWD" 2>/dev/null || echo "1000")
_log_verbose "Host UID/GID: $HOST_UID/$HOST_GID"

# If root, switch to node user (with optional UID remapping)
if [[ "$(id -u)" == "0" ]]; then
    _log "Running as root, switching to node user..."
    if [[ "$HOST_UID" != "0" && "$HOST_UID" != "1000" ]]; then
        _log "Remapping UID $HOST_UID -> node"
        usermod -u "$HOST_UID" node 2>/dev/null || true
        groupmod -g "$HOST_GID" node 2>/dev/null || true
        chown "$HOST_UID:$HOST_GID" /home/node 2>/dev/null || true
        chown -R "$HOST_UID:$HOST_GID" /home/node/.claude /home/node/.npm /home/node/.config 2>/dev/null || true
    fi
    _log "Switching to node user via gosu..."
    exec gosu node "$0" "$@"
fi

_log "Running as node user (UID: $(id -u))"

# Inject CCO files from image (unless bare mode)
# Host .claude is mounted rw, but rules/commands/agents/skills are tmpfs overlays
if [[ -z "$CCBOX_BARE_MODE" && -d "/opt/cco" ]]; then
    _log "Injecting CCO from image..."
    # Copy all CCO directories to global .claude (tmpfs overlays)
    for dir in rules commands agents skills; do
        if [[ -d "/opt/cco/$dir" ]]; then
            cp -r "/opt/cco/$dir/." "/home/node/.claude/$dir/" 2>/dev/null || true
            _log_verbose "Copied $dir/ to global .claude"
        fi
    done
    # Copy CLAUDE.md template to project .claude (takes precedence over global)
    # Global CLAUDE.md is hidden via /dev/null mount
    if [[ -f "/opt/cco/CLAUDE.md" ]]; then
        mkdir -p "$PWD/.claude" 2>/dev/null || true
        cp "/opt/cco/CLAUDE.md" "$PWD/.claude/CLAUDE.md" 2>/dev/null || true
        _log_verbose "Copied CLAUDE.md to project .claude"
    fi
else
    _log "Bare mode: vanilla Claude Code (no CCO)"
fi

# Project .claude is mounted directly from host (persistent)
# Claude Code automatically reads project .claude first, then global
if [[ -d "$PWD/.claude" ]]; then
    _log "Project .claude detected (persistent, host-mounted)"
    _log_verbose "Project .claude contents: $(ls -A "$PWD/.claude" 2>/dev/null | tr '\\n' ' ')"
fi

# Runtime config (as node user)
export NODE_OPTIONS="--max-old-space-size=$(( $(free -m | awk '/^Mem:/{print $2}') * 3 / 4 ))"
export UV_THREADPOOL_SIZE=$(nproc)
_log_verbose "NODE_OPTIONS: $NODE_OPTIONS"
_log_verbose "UV_THREADPOOL_SIZE: $UV_THREADPOOL_SIZE"

git config --global --add safe.directory '*' 2>/dev/null || true

# Verify claude command exists
if ! command -v claude &>/dev/null; then
    _die "claude command not found in PATH"
fi

_log_verbose "Claude location: $(which claude)"
_log_verbose "Node version: $(node --version 2>/dev/null || echo 'N/A')"
_log_verbose "npm version: $(npm --version 2>/dev/null || echo 'N/A')"

_log "Starting Claude Code..."

# Use stdbuf for unbuffered output in non-TTY mode (--print with pipes)
if [[ -t 1 ]]; then
    exec claude --dangerously-skip-permissions "$@"
else
    exec stdbuf -oL -eL claude --dangerously-skip-permissions "$@"
fi
"""


def write_build_files(stack: LanguageStack) -> Path:
    """Write Dockerfile and entrypoint to build directory."""
    build_dir = get_config_dir() / "build" / stack.value
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


def _build_mount_args(
    project_path: Path,
    dirname: str,
    docker_project_path: str,
    docker_claude_config: str,
    bare: bool,
    deps_list: list[DepsInfo] | None,
) -> list[str]:
    """Build mount arguments for docker run command.

    Args:
        project_path: Path to the project directory.
        dirname: Directory name for workdir.
        docker_project_path: Docker-compatible project path.
        docker_claude_config: Docker-compatible Claude config path.
        bare: If True, use tmpfs overlays for isolation.
        deps_list: List of detected dependencies (for cache mounts).

    Returns:
        List of mount arguments for docker run.
    """
    args = [
        # Project mount (rw)
        "-v",
        f"{docker_project_path}:/home/node/{dirname}:rw",
        # Host .claude directory (rw for full access)
        "-v",
        f"{docker_claude_config}:/home/node/.claude:rw",
    ]

    if bare:
        # Bare/vanilla mode: isolate host customizations, use only credentials/settings
        # tmpfs overlays hide host's rules/commands/agents/skills
        user_dirs = ["rules", "commands", "agents", "skills"]
        for d in user_dirs:
            args.extend(
                ["--tmpfs", f"/home/node/.claude/{d}:rw,size=16m,uid=1000,gid=1000,mode=0755"]
            )
        # Hide host's CLAUDE.md
        args.extend(["-v", "/dev/null:/home/node/.claude/CLAUDE.md:ro"])

    # Add cache volume mounts for package managers
    if deps_list:
        from .deps import get_all_cache_paths

        cache_paths = get_all_cache_paths(deps_list)
        cache_dir = get_config_dir() / "cache"
        cache_dir.mkdir(parents=True, exist_ok=True)

        for cache_name, container_path in cache_paths.items():
            host_cache = cache_dir / cache_name
            host_cache.mkdir(parents=True, exist_ok=True)
            docker_cache_path = resolve_for_docker(host_cache)
            args.extend(["-v", f"{docker_cache_path}:{container_path}:rw"])

    return args


def _build_env_args(
    config: Config,
    bare: bool,
    debug: int,
    debug_logs: bool,
) -> list[str]:
    """Build environment variable arguments for docker run command.

    Args:
        config: ccbox configuration.
        bare: If True, enable bare mode.
        debug: Debug level (0=off, 1=basic, 2=verbose).
        debug_logs: If True, persist debug logs.

    Returns:
        List of environment arguments for docker run.
    """
    args = [
        "-e",
        "TERM=xterm-256color",
        "-e",
        "CLAUDE_CONFIG_DIR=/home/node/.claude",  # Override default ~/.config/claude
        "-e",
        "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1",  # Disable telemetry, error reporting
        "-e",
        "DISABLE_AUTOUPDATER=1",  # Disable auto-updates (use image rebuild)
        "-e",
        "PYTHONUNBUFFERED=1",  # Force unbuffered output for streaming
        "-e",
        "NODE_OPTIONS=--no-warnings",  # Suppress Node.js warnings
    ]

    # Bare mode flag
    if bare:
        args.extend(["-e", "CCBOX_BARE_MODE=1"])

    # Debug mode for entrypoint logging (0=off, 1=basic, 2=verbose)
    if debug > 0:
        args.extend(["-e", f"CCBOX_DEBUG={debug}"])

    # Debug logs: tmpfs by default (ephemeral), persistent with --debug-logs
    if not debug_logs:
        args.extend(["--tmpfs", "/home/node/.claude/debug:rw,size=512m,mode=0777"])

    # Git configuration
    if config.git_name:
        args.extend(["-e", f"GIT_AUTHOR_NAME={config.git_name}"])
        args.extend(["-e", f"GIT_COMMITTER_NAME={config.git_name}"])
    if config.git_email:
        args.extend(["-e", f"GIT_AUTHOR_EMAIL={config.git_email}"])
        args.extend(["-e", f"GIT_COMMITTER_EMAIL={config.git_email}"])

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

    cmd.extend(["--name", container_name])

    # Convert claude config path for Docker mount
    docker_claude_config = resolve_for_docker(claude_config)

    # Build mount arguments
    mount_args = _build_mount_args(
        project_path,
        dirname,
        docker_project_path,
        docker_claude_config,
        bare,
        deps_list,
    )
    cmd.extend(mount_args)

    cmd.extend(
        [
            # Workdir: dynamic based on directory name
            "-w",
            f"/home/node/{dirname}",
            # Temp directories in memory (no disk residue)
            "--tmpfs",
            "/tmp:rw,noexec,nosuid,size=512m",
            "--tmpfs",
            "/var/tmp:rw,noexec,nosuid,size=256m",
            # Security hardening
            "--security-opt=no-new-privileges",  # Prevent privilege escalation
            "--pids-limit=512",  # Fork bomb protection
        ]
    )

    # Build environment arguments
    env_args = _build_env_args(config, bare, debug, debug_logs)
    cmd.extend(env_args)

    cmd.append(image_name)

    # Claude CLI arguments (passed to entrypoint -> claude command)
    # Note: --dangerously-skip-permissions is already in entrypoint.sh
    if model:
        cmd.extend(["--model", model])

    # Derive flags from parameters:
    # - stream: -dd enables stream mode (real-time tool call output)
    # - verbose: required by stream OR when prompt is set (unless quiet)
    stream = debug >= 2
    verbose = stream or (bool(prompt) and not quiet)

    if verbose:
        cmd.append("--verbose")

    if append_system_prompt:
        cmd.extend(["--append-system-prompt", append_system_prompt])

    # Print mode: required for non-interactive usage (prompt or quiet)
    if quiet or prompt:
        cmd.append("--print")
        # Stream mode: use stream-json for real-time output
        if stream:
            cmd.extend(["--output-format", "stream-json"])

    # Prompt: passed as positional argument (Claude Code doesn't have --prompt flag)
    if prompt:
        cmd.append(prompt)

    return cmd
