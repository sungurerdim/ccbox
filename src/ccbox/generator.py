"""Docker file generation for ccbox."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Callable

from .config import Config, LanguageStack, get_config_dir, get_image_name

# Common tools added to all images (CCO, Claude Code, lint/test tools)
# Optimized: single layer, parallel downloads, minimal temp files
COMMON_TOOLS = """
# System packages + CLI tools (single layer for caching)
RUN apt-get update && apt-get install -y --no-install-recommends \\
    git gnupg ca-certificates openssh-client curl \\
    jq ripgrep procps locales \\
    bash less tree file zip unzip \\
    && sed -i '/en_US.UTF-8/s/^# //g' /etc/locale.gen && locale-gen \\
    && rm -rf /var/lib/apt/lists/*

# External tools: fd, gh, yq (separate layer - changes less frequently)
RUN set -eux; \\
    FD_VER=$(curl -sfL https://api.github.com/repos/sharkdp/fd/releases/latest | jq -r .tag_name); \\
    GH_VER=$(curl -sfL https://api.github.com/repos/cli/cli/releases/latest | jq -r .tag_name); \\
    curl -sfL "https://github.com/sharkdp/fd/releases/download/${FD_VER}/fd_${FD_VER#v}_amd64.deb" -o /tmp/fd.deb; \\
    curl -sfL "https://github.com/cli/cli/releases/download/${GH_VER}/gh_${GH_VER#v}_linux_amd64.tar.gz" | tar xz --strip-components=2 -C /usr/local/bin "gh_${GH_VER#v}_linux_amd64/bin/gh"; \\
    curl -sfL https://github.com/mikefarah/yq/releases/latest/download/yq_linux_amd64 -o /usr/local/bin/yq; \\
    dpkg -i /tmp/fd.deb; \\
    chmod +x /usr/local/bin/yq; \\
    rm -f /tmp/fd.deb

ENV LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8
"""

# Python tools (for CCO and linting)
# Optimized: single pip install, CCO from git
PYTHON_TOOLS = """
# Python tools + CCO (single layer)
RUN pip install --break-system-packages --no-cache-dir \\
    ruff mypy pytest pytest-cov poetry uv \\
    git+https://github.com/sungurerdim/ClaudeCodeOptimizer.git
"""

# Node.js tools (for Claude Code)
# Optimized: combined npm config and installs
NODE_TOOLS = """
# npm config + global tools + Claude Code (single layer)
RUN npm config set fund false && npm config set audit false && npm config set update-notifier false \\
    && npm install -g typescript eslint prettier jest @anthropic-ai/claude-code --force \\
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
    """BASE stack: node:lts-slim + Python + CCO."""
    return f"""# syntax=docker/dockerfile:1
# ccbox:base - Node.js + Python + CCO
FROM node:lts-slim

LABEL org.opencontainers.image.title="ccbox:base"

ENV DEBIAN_FRONTEND=noninteractive
{COMMON_TOOLS}
# Python (full) - single layer with cleanup
RUN apt-get update && apt-get install -y --no-install-recommends \\
    python3 python3-pip python3-venv python3-dev python-is-python3 build-essential \\
    && rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*
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
{COMMON_TOOLS}
# Node.js LTS + Python (combined for fewer layers)
RUN curl -fsSL https://deb.nodesource.com/setup_lts.x | bash - \\
    && apt-get install -y --no-install-recommends nodejs python3 python3-pip python3-venv python-is-python3 \\
    && rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*
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
{COMMON_TOOLS}
# Node.js LTS + Python (combined for fewer layers)
RUN curl -fsSL https://deb.nodesource.com/setup_lts.x | bash - \\
    && apt-get install -y --no-install-recommends nodejs python3 python3-pip python3-venv python-is-python3 \\
    && rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*
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
{COMMON_TOOLS}
# Node.js LTS + Python (combined for fewer layers)
RUN curl -fsSL https://deb.nodesource.com/setup_lts.x | bash - \\
    && apt-get install -y --no-install-recommends nodejs python3 python3-pip python3-venv python-is-python3 \\
    && rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*
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
    """WEB stack: node:lts-slim + pnpm + Python + CCO."""
    return f"""# syntax=docker/dockerfile:1
# ccbox:web - Node.js + pnpm + Python + CCO (fullstack)
FROM node:lts-slim

LABEL org.opencontainers.image.title="ccbox:web"

ENV DEBIAN_FRONTEND=noninteractive
{COMMON_TOOLS}
# Python (full) - single layer with cleanup
RUN apt-get update && apt-get install -y --no-install-recommends \\
    python3 python3-pip python3-venv python3-dev python-is-python3 build-essential \\
    && rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*
{PYTHON_TOOLS}
{NODE_TOOLS}
# pnpm (latest) - combined with cache clean
RUN npm install -g pnpm --force && npm cache clean --force
{ENTRYPOINT_SETUP}
"""


def _full_dockerfile() -> str:
    """FULL stack: node:lts-slim + all languages."""
    return f"""# syntax=docker/dockerfile:1
# ccbox:full - All languages (Go + Rust + Java + pnpm)
FROM node:lts-slim

LABEL org.opencontainers.image.title="ccbox:full"

ENV DEBIAN_FRONTEND=noninteractive
{COMMON_TOOLS}
# Python (full) - single layer with cleanup
RUN apt-get update && apt-get install -y --no-install-recommends \\
    python3 python3-pip python3-venv python3-dev python-is-python3 build-essential \\
    && rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*
{PYTHON_TOOLS}
{NODE_TOOLS}
# Go (latest) + golangci-lint
RUN set -eux; \\
    GO_VER=$(curl -fsSL https://go.dev/VERSION?m=text | head -1); \\
    curl -fsSL "https://go.dev/dl/${{GO_VER}}.linux-amd64.tar.gz" | tar -C /usr/local -xzf -; \\
    curl -sSfL https://raw.githubusercontent.com/golangci/golangci-lint/master/install.sh | sh -s -- -b /usr/local/bin
ENV PATH=$PATH:/usr/local/go/bin GOPATH=/home/node/go
ENV PATH=$PATH:$GOPATH/bin

# Rust (latest) + clippy + rustfmt
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y \\
    && /root/.cargo/bin/rustup component add clippy rustfmt
ENV PATH="/root/.cargo/bin:$PATH"

# Java (Temurin LTS) + Maven
RUN set -eux; \\
    TEMURIN_VER=$(curl -sfL "https://api.adoptium.net/v3/info/available_releases" | jq -r '.most_recent_lts'); \\
    curl -sfL "https://api.adoptium.net/v3/binary/latest/${{TEMURIN_VER}}/ga/linux/x64/jdk/hotspot/normal/eclipse" -o /tmp/jdk.tar.gz; \\
    mkdir -p /usr/lib/jvm && tar -xzf /tmp/jdk.tar.gz -C /usr/lib/jvm; \\
    ln -s /usr/lib/jvm/jdk-* /usr/lib/jvm/temurin; \\
    MVN_VER=$(curl -sfL https://api.github.com/repos/apache/maven/releases/latest | jq -r .tag_name | sed 's/maven-//'); \\
    curl -sfL "https://archive.apache.org/dist/maven/maven-3/${{MVN_VER}}/binaries/apache-maven-${{MVN_VER}}-bin.tar.gz" | tar -xz -C /opt; \\
    ln -s /opt/apache-maven-${{MVN_VER}}/bin/mvn /usr/local/bin/mvn; \\
    rm -f /tmp/jdk.tar.gz
ENV JAVA_HOME=/usr/lib/jvm/temurin PATH=$JAVA_HOME/bin:$PATH

# pnpm (latest)
RUN npm install -g pnpm --force && npm cache clean --force
{ENTRYPOINT_SETUP}
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

# Run CCO setup if available
command -v cco-setup &>/dev/null && cco-setup 2>/dev/null

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

    (build_dir / "Dockerfile").write_text(generate_dockerfile(stack), encoding="utf-8")
    (build_dir / "entrypoint.sh").write_text(generate_entrypoint(), encoding="utf-8")
    (build_dir / ".dockerignore").write_text(generate_dockerignore(), encoding="utf-8")

    return build_dir


def get_docker_run_cmd(
    config: Config,
    project_path: Path,
    project_name: str,
    stack: LanguageStack,
) -> list[str]:
    """Generate docker run command with full cleanup on exit."""
    image_name = get_image_name(stack)
    claude_config = Path(os.path.expanduser(config.claude_config_dir))

    # Sanitize project name for container naming
    safe_name = "".join(c if c.isalnum() or c in "-_" else "-" for c in project_name.lower())
    container_name = f"ccbox-{safe_name}"

    # Use directory name (not full path) for workdir
    dirname = project_path.name

    cmd = [
        "docker", "run",
        "--rm",                          # Remove container on exit
        "-it",                           # Interactive TTY
        "--name", container_name,
        # Mounts: project (rw) and claude config (rw)
        "-v", f"{project_path}:/home/node/{dirname}:rw",
        "-v", f"{claude_config}:/home/node/.claude:rw",
        # Workdir: dynamic based on directory name
        "-w", f"/home/node/{dirname}",
        # Temp directories in memory (no disk residue)
        "--tmpfs", "/tmp:rw,noexec,nosuid,size=512m",
        "--tmpfs", "/var/tmp:rw,noexec,nosuid,size=256m",
        # Environment
        "-e", "TERM=xterm-256color",
        "-e", "CLAUDE_CONFIG_DIR=/home/node/.claude",
        "-e", "DEBUG=False",  # Disable Claude Code debug mode (prevents 20GB+ log files)
    ]

    if config.git_name:
        cmd.extend(["-e", f"GIT_AUTHOR_NAME={config.git_name}"])
        cmd.extend(["-e", f"GIT_COMMITTER_NAME={config.git_name}"])
    if config.git_email:
        cmd.extend(["-e", f"GIT_AUTHOR_EMAIL={config.git_email}"])
        cmd.extend(["-e", f"GIT_COMMITTER_EMAIL={config.git_email}"])

    cmd.append(image_name)
    return cmd
