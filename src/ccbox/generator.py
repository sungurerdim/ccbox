"""Docker file generation for ccbox."""

from __future__ import annotations

import os
from pathlib import Path

from .config import Config, LanguageStack, get_config_dir

# Stack-specific Dockerfile snippets
STACK_PACKAGES: dict[LanguageStack, str] = {
    LanguageStack.BASE: "# Base stack - Node.js only",
    LanguageStack.PYTHON: """# Python
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip python3-venv python3-dev python-is-python3 build-essential \
    && rm -rf /var/lib/apt/lists/*
RUN pip install --break-system-packages \
    poetry uv ruff mypy pytest pytest-cov""",
    LanguageStack.GO: """# Go
RUN curl -fsSL "https://go.dev/dl/$(curl -fsSL https://go.dev/VERSION?m=text | head -1).linux-amd64.tar.gz" \
    | tar -C /usr/local -xzf -
ENV PATH=$PATH:/usr/local/go/bin
ENV GOPATH=/home/node/go
ENV PATH=$PATH:$GOPATH/bin""",
    LanguageStack.RUST: """# Rust
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
ENV PATH="/root/.cargo/bin:$PATH" """,
    LanguageStack.JAVA: """# Java
RUN apt-get update && apt-get install -y --no-install-recommends \
    openjdk-17-jdk-headless maven \
    && rm -rf /var/lib/apt/lists/*
ENV JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64""",
    LanguageStack.WEB: """# Python + pnpm (fullstack)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip python3-venv python3-dev python-is-python3 build-essential \
    && rm -rf /var/lib/apt/lists/*
RUN pip install --break-system-packages poetry uv ruff mypy pytest
RUN npm install -g pnpm""",
    LanguageStack.FULL: """# Python
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip python3-venv python3-dev python-is-python3 build-essential \
    && rm -rf /var/lib/apt/lists/*
RUN pip install --break-system-packages poetry uv ruff mypy pytest pytest-cov

# Go
RUN curl -fsSL "https://go.dev/dl/$(curl -fsSL https://go.dev/VERSION?m=text | head -1).linux-amd64.tar.gz" \
    | tar -C /usr/local -xzf -
ENV PATH=$PATH:/usr/local/go/bin
ENV GOPATH=/home/node/go
ENV PATH=$PATH:$GOPATH/bin

# Rust
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
ENV PATH="/root/.cargo/bin:$PATH" """,
}


def generate_dockerfile(stack: LanguageStack) -> str:
    """Generate Dockerfile content for the given stack."""
    extra_packages = STACK_PACKAGES.get(stack, "# Unknown stack")

    return f"""# ccbox - Claude Code Docker Environment
# Stack: {stack.value}

FROM node:slim

ENV DEBIAN_FRONTEND=noninteractive

# Essential tools
RUN apt-get update && apt-get install -y --no-install-recommends \\
    git gnupg ca-certificates openssh-client \\
    curl wget jq \\
    gawk sed grep findutils diffutils coreutils \\
    bash less tree file patch bc \\
    ripgrep fd-find \\
    procps \\
    zip unzip xz-utils bzip2 \\
    locales \\
    && rm -rf /var/lib/apt/lists/*

# Locale
RUN sed -i '/en_US.UTF-8/s/^# //g' /etc/locale.gen && locale-gen
ENV LANG=en_US.UTF-8
ENV LC_ALL=en_US.UTF-8

# npm optimization
RUN npm config set fund false \\
    && npm config set audit false \\
    && npm config set update-notifier false

# fd symlink
RUN ln -sf $(which fdfind) /usr/local/bin/fd

# yq
RUN curl -sL https://github.com/mikefarah/yq/releases/latest/download/yq_linux_amd64 \\
    -o /usr/local/bin/yq && chmod +x /usr/local/bin/yq

# GitHub CLI
RUN curl -sL "https://github.com/cli/cli/releases/latest/download/gh_$(curl -sL https://api.github.com/repos/cli/cli/releases/latest | jq -r .tag_name | tr -d v)_linux_amd64.tar.gz" \\
    | tar xz --strip-components=1 -C /usr/local

{extra_packages}

# Node.js tools
RUN npm install -g typescript eslint prettier --force

# Claude Code
RUN npm install -g @anthropic-ai/claude-code

WORKDIR /home/node/project

# Entrypoint
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

ENV HOME=/home/node
USER node
RUN git config --global --add safe.directory '*'

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
"""


def generate_entrypoint() -> str:
    """Generate entrypoint script (always bypass mode)."""
    return """#!/bin/bash
# ccbox entrypoint

# Dynamic RAM allocation (75% of available)
TOTAL_MEM=$(free -m | awk '/^Mem:/{print $2}')
NODE_MEM=$((TOTAL_MEM * 3 / 4))
export NODE_OPTIONS="--max-old-space-size=$NODE_MEM"

# Dynamic CPU allocation
export UV_THREADPOOL_SIZE=$(nproc)

# Check for Claude Code updates
OLD_VER=$(claude --version 2>/dev/null | cut -d" " -f1)
claude update 2>/dev/null
NEW_VER=$(claude --version 2>/dev/null | cut -d" " -f1)
if [ "$OLD_VER" != "$NEW_VER" ]; then
    echo ""
    echo "*** CLAUDE CODE UPDATED: $OLD_VER -> $NEW_VER ***"
    echo "*** Run 'ccbox update' to make permanent ***"
    echo ""
    sleep 2
fi

# Run CCO setup if available
command -v cco-setup &>/dev/null && cco-setup 2>/dev/null

# Execute Claude Code with bypass permissions
exec claude --dangerously-skip-permissions "$@"
"""


def write_build_files(stack: LanguageStack) -> Path:
    """Write Dockerfile and entrypoint to build directory."""
    build_dir = get_config_dir() / "build" / stack.value
    build_dir.mkdir(parents=True, exist_ok=True)

    (build_dir / "Dockerfile").write_text(generate_dockerfile(stack), encoding="utf-8")
    (build_dir / "entrypoint.sh").write_text(generate_entrypoint(), encoding="utf-8")

    return build_dir


def get_docker_run_cmd(
    config: Config,
    project_path: Path,
    project_name: str,
    stack: LanguageStack,
) -> list[str]:
    """Generate docker run command."""
    image_name = f"ccbox:{stack.value}"
    container_name = f"ccbox-{project_name.lower().replace(' ', '-')}"
    claude_config = Path(os.path.expanduser(config.claude_config_dir))

    cmd = [
        "docker", "run", "--rm", "-it",
        "--name", container_name,
        "-v", f"{project_path}:/home/node/{project_name}",
        "-v", f"{claude_config}:/home/node/.claude",
        "-w", f"/home/node/{project_name}",
        "-e", "TERM=xterm-256color",
    ]

    # Git config
    if config.git_name:
        cmd.extend(["-e", f"GIT_AUTHOR_NAME={config.git_name}"])
        cmd.extend(["-e", f"GIT_COMMITTER_NAME={config.git_name}"])
    if config.git_email:
        cmd.extend(["-e", f"GIT_AUTHOR_EMAIL={config.git_email}"])
        cmd.extend(["-e", f"GIT_COMMITTER_EMAIL={config.git_email}"])

    cmd.append(image_name)
    return cmd
