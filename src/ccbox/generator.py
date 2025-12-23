"""Docker file generation for ccbox."""

from __future__ import annotations

from pathlib import Path
from typing import Callable

from .config import (
    Config,
    LanguageStack,
    get_claude_config_dir,
    get_config_dir,
    get_container_name,
    get_image_name,
)

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

# CCO installation (pip only - cco-install runs at runtime via entrypoint)
CCO_INSTALL = """
# Claude Code Optimizer (CCO) - install package only
# cco-install runs at container start because ~/.claude is mounted from host
# Must run as root for system-wide installation (USER node set by minimal base)
USER root
RUN pip install --break-system-packages --no-cache-dir \\
    git+https://github.com/sungurerdim/ClaudeCodeOptimizer.git
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
    """Generate entrypoint script."""
    return """#!/bin/bash
# ccbox entrypoint - cross-platform UID handling
set -e

# Detect UID/GID from project directory (PWD = mounted host directory)
HOST_UID=$(stat -c '%u' "$PWD" 2>/dev/null || stat -f '%u' "$PWD" 2>/dev/null || echo "1000")
HOST_GID=$(stat -c '%g' "$PWD" 2>/dev/null || stat -f '%g' "$PWD" 2>/dev/null || echo "1000")

# Switch to host user if running as root
if [[ "$(id -u)" == "0" && "$HOST_UID" != "0" ]]; then
    usermod -u "$HOST_UID" node 2>/dev/null || true
    groupmod -g "$HOST_GID" node 2>/dev/null || true
    chown -R "$HOST_UID:$HOST_GID" /home/node 2>/dev/null || true
    exec gosu node "$0" "$@"
fi

# Runtime config
TOTAL_MEM=$(free -m | awk '/^Mem:/{print $2}')
export NODE_OPTIONS="--max-old-space-size=$((TOTAL_MEM * 3 / 4))"
export UV_THREADPOOL_SIZE=$(nproc)
git config --global --add safe.directory '*' 2>/dev/null || true

exec claude --dangerously-skip-permissions "$@"
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


def get_docker_run_cmd(
    config: Config,
    project_path: Path,
    project_name: str,
    stack: LanguageStack,
    *,
    bare: bool = False,
    debug_logs: bool = False,
    prompt: str | None = None,
    model: str | None = None,
    quiet: bool = False,
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
        prompt: Initial prompt to send to Claude (enables --print mode).
        model: Model to use (e.g., opus, sonnet, haiku).
        quiet: Quiet mode (enables --print, shows only Claude's responses).

    Raises:
        ConfigPathError: If claude_config_dir path validation fails.
    """
    image_name = get_image_name(stack)
    claude_config = get_claude_config_dir(config)

    # Use centralized container naming with unique suffix
    container_name = get_container_name(project_name)

    # Use directory name (not full path) for workdir
    dirname = project_path.name

    cmd = [
        "docker",
        "run",
        "--rm",  # Remove container on exit
        "-it",  # Interactive TTY
        "--name",
        container_name,
        # Mounts: project (rw)
        "-v",
        f"{project_path}:/home/node/{dirname}:rw",
    ]

    if bare:
        # Bare mode: mount only essential files (no CCO rules/commands/agents)
        # This provides vanilla Claude Code experience with host auth/settings
        bare_files = [".credentials.json", ".claude.json", "settings.json"]
        for filename in bare_files:
            filepath = claude_config / filename
            if filepath.exists():
                cmd.extend(["-v", f"{filepath}:/home/node/.claude/{filename}:rw"])
    else:
        # Normal mode: full rw mount (host settings persist)
        cmd.extend(["-v", f"{claude_config}:/home/node/.claude:rw"])

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
            # Environment
            "-e",
            "TERM=xterm-256color",
            "-e",
            "CLAUDE_CONFIG_DIR=/home/node/.claude",
            "-e",
            "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1",  # Disable telemetry, error reporting
            "-e",
            "DISABLE_AUTOUPDATER=1",  # Disable auto-updates (use image rebuild)
        ]
    )

    # Debug logs: tmpfs by default (ephemeral), persistent with --debug-logs
    if not debug_logs:
        cmd.extend(["--tmpfs", "/home/node/.claude/debug:rw,size=512m,mode=0777"])

    if config.git_name:
        cmd.extend(["-e", f"GIT_AUTHOR_NAME={config.git_name}"])
        cmd.extend(["-e", f"GIT_COMMITTER_NAME={config.git_name}"])
    if config.git_email:
        cmd.extend(["-e", f"GIT_AUTHOR_EMAIL={config.git_email}"])
        cmd.extend(["-e", f"GIT_COMMITTER_EMAIL={config.git_email}"])

    cmd.append(image_name)

    # Claude CLI arguments (passed to entrypoint -> claude command)
    # Note: --dangerously-skip-permissions is already in entrypoint.sh
    if model:
        cmd.extend(["--model", model])

    # Print mode required for: quiet mode OR prompt (non-interactive usage)
    if quiet or prompt:
        cmd.append("--print")

    # Prompt: passed as positional argument (Claude Code doesn't have --prompt flag)
    if prompt:
        cmd.append(prompt)

    return cmd
