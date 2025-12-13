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
    # Standard CLI tools used by Claude Code
    gawk sed grep findutils coreutils less file unzip \\
    && rm -rf /var/lib/apt/lists/* \\
    && sed -i '/en_US.UTF-8/s/^# //g' /etc/locale.gen && locale-gen \\
    # fd (latest)
    && FD_VER=$(curl -sL https://api.github.com/repos/sharkdp/fd/releases/latest | jq -r .tag_name) \\
    && curl -sL "https://github.com/sharkdp/fd/releases/download/${FD_VER}/fd_${FD_VER#v}_amd64.deb" -o /tmp/fd.deb \\
    && dpkg -i /tmp/fd.deb && rm /tmp/fd.deb \\
    # GitHub CLI (latest)
    && GH_VER=$(curl -sL https://api.github.com/repos/cli/cli/releases/latest | jq -r .tag_name) \\
    && curl -sL "https://github.com/cli/cli/releases/download/${GH_VER}/gh_${GH_VER#v}_linux_amd64.tar.gz" \\
    | tar xz --strip-components=2 -C /usr/local/bin "gh_${GH_VER#v}_linux_amd64/bin/gh" \\
    # yq (latest)
    && curl -sL https://github.com/mikefarah/yq/releases/latest/download/yq_linux_amd64 -o /usr/local/bin/yq \\
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

# Python tools for CCO slash commands (with cache bust)
PYTHON_TOOLS = """
# Cache bust for ccbox/cco updates (changes each build)
ARG CACHEBUST=1

# Python dev tools (ruff, mypy, pytest) + CCO
RUN pip install --break-system-packages --no-cache-dir \\
    ruff mypy pytest \\
    git+https://github.com/sungurerdim/ClaudeCodeOptimizer.git
"""

# Claude Code only (no extra dev tools - users install what they need)
NODE_TOOLS = """
# Claude Code
RUN npm config set fund false && npm config set update-notifier false \\
    && npm install -g @anthropic-ai/claude-code --force \\
    && npm cache clean --force
"""

# Entrypoint setup
# Optimized: combined operations, COPY --chmod (BuildKit)
ENTRYPOINT_SETUP = """
WORKDIR /home/node/project

COPY --chmod=755 entrypoint.sh /usr/local/bin/entrypoint.sh

ENV HOME=/home/node
USER node
RUN git config --global --add safe.directory '*'

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
"""


def _base_dockerfile() -> str:
    """BASE stack: node:slim + Python + CCO."""
    return f"""# syntax=docker/dockerfile:1
# ccbox:base - Node.js + Python + CCO
FROM node:slim

LABEL org.opencontainers.image.title="ccbox:base"

ENV DEBIAN_FRONTEND=noninteractive
{COMMON_TOOLS}
{PYTHON_TOOLS}
{NODE_TOOLS}
{ENTRYPOINT_SETUP}
"""


def _go_dockerfile() -> str:
    """GO stack: golang:latest + Node.js + Python + CCO."""
    return f"""# syntax=docker/dockerfile:1
# ccbox:go - Go + Node.js + Python + CCO
FROM golang:latest

LABEL org.opencontainers.image.title="ccbox:go"

ENV DEBIAN_FRONTEND=noninteractive
{NODE_INSTALL}{COMMON_TOOLS}
{PYTHON_TOOLS}
{NODE_TOOLS}
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
{PYTHON_TOOLS}
{NODE_TOOLS}
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
{PYTHON_TOOLS}
{NODE_TOOLS}
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

# Go (latest) + golangci-lint
RUN set -eux; \
    GO_VER=$(curl -fsSL https://go.dev/VERSION?m=text | head -1); \
    curl -fsSL "https://go.dev/dl/${GO_VER}.linux-amd64.tar.gz" | tar -C /usr/local -xzf -; \
    curl -sSfL https://raw.githubusercontent.com/golangci/golangci-lint/master/install.sh | sh -s -- -b /usr/local/bin
ENV PATH=$PATH:/usr/local/go/bin GOPATH=/home/node/go
ENV PATH=$PATH:$GOPATH/bin

# Rust (latest) + clippy + rustfmt - install for node user
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y \
    && /root/.cargo/bin/rustup component add clippy rustfmt
ENV PATH="/root/.cargo/bin:$PATH"

# Java (Temurin LTS) + Maven
RUN set -eux; \
    TEMURIN_VER=$(curl -sfL "https://api.adoptium.net/v3/info/available_releases" | jq -r '.most_recent_lts'); \
    curl -sfL "https://api.adoptium.net/v3/binary/latest/${TEMURIN_VER}/ga/linux/x64/jdk/hotspot/normal/eclipse" -o /tmp/jdk.tar.gz; \
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
    return _base_dockerfile()  # pragma: no cover - fallback for unknown stacks


def generate_entrypoint() -> str:
    """Generate entrypoint script."""
    return """#!/bin/bash
# ccbox entrypoint

# Dynamic RAM allocation (75% of available)
TOTAL_MEM=$(free -m | awk '/^Mem:/{print $2}')
NODE_MEM=$((TOTAL_MEM * 3 / 4))
export NODE_OPTIONS="--max-old-space-size=$NODE_MEM"

# Dynamic CPU allocation
export UV_THREADPOOL_SIZE=$(nproc)

# Execute Claude Code with bypass permissions
exec claude --dangerously-skip-permissions "$@"
"""


def generate_dockerignore() -> str:
    """Generate .dockerignore for faster builds."""
    return """# ccbox .dockerignore - minimize build context
**/.git
**/.svn
**/.hg
**/node_modules
**/__pycache__
**/.venv
**/venv
**/.env
**/*.pyc
**/*.pyo
**/dist
**/build
**/.cache
**/coverage
**/.pytest_cache
**/.mypy_cache
**/.ruff_cache
**/target
**/*.log
**/.DS_Store
**/Thumbs.db
"""


def write_build_files(stack: LanguageStack) -> Path:
    """Write Dockerfile and entrypoint to build directory."""
    build_dir = get_config_dir() / "build" / stack.value
    build_dir.mkdir(parents=True, exist_ok=True)

    # Write with Unix line endings (open with newline="" to prevent OS conversion)
    for filename, content in [
        ("Dockerfile", generate_dockerfile(stack)),
        ("entrypoint.sh", generate_entrypoint()),
        (".dockerignore", generate_dockerignore()),
    ]:
        with open(build_dir / filename, "w", encoding="utf-8", newline="\n") as f:
            f.write(content)

    return build_dir


def get_docker_run_cmd(
    config: Config,
    project_path: Path,
    project_name: str,
    stack: LanguageStack,
) -> list[str]:
    """Generate docker run command with full cleanup on exit.

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
        # Mounts: project (rw) and claude config (rw)
        "-v",
        f"{project_path}:/home/node/{dirname}:rw",
        "-v",
        f"{claude_config}:/home/node/.claude:rw",
        # Workdir: dynamic based on directory name
        "-w",
        f"/home/node/{dirname}",
        # Temp directories in memory (no disk residue)
        "--tmpfs",
        "/tmp:rw,noexec,nosuid,size=512m",
        "--tmpfs",
        "/var/tmp:rw,noexec,nosuid,size=256m",
        # Environment
        "-e",
        "TERM=xterm-256color",
        "-e",
        "CLAUDE_CONFIG_DIR=/home/node/.claude",
        "-e",
        "DEBUG=False",  # Disable Claude Code debug mode (prevents 20GB+ log files)
    ]

    if config.git_name:
        cmd.extend(["-e", f"GIT_AUTHOR_NAME={config.git_name}"])
        cmd.extend(["-e", f"GIT_COMMITTER_NAME={config.git_name}"])
    if config.git_email:
        cmd.extend(["-e", f"GIT_AUTHOR_EMAIL={config.git_email}"])
        cmd.extend(["-e", f"GIT_COMMITTER_EMAIL={config.git_email}"])

    cmd.append(image_name)
    return cmd
