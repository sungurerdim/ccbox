"""Template-based file generation for ccbox."""

from __future__ import annotations

import importlib.resources
import os
from pathlib import Path
from string import Template
from typing import Any

from .config import Config, LanguageStack, get_config_dir


def get_template(name: str) -> str:
    """Load a template file from the templates directory."""
    files = importlib.resources.files("ccbox.templates")
    return (files / name).read_text(encoding="utf-8")


def render_template(template_name: str, context: dict[str, Any]) -> str:
    """Render a template with the given context."""
    template_content = get_template(template_name)
    template = Template(template_content)
    return template.safe_substitute(context)


def get_language_packages(stack: LanguageStack) -> dict[str, str]:
    """Get language-specific package installation commands."""
    packages: dict[str, str] = {}

    python_full = """# Python
RUN apt-get update && apt-get install -y --no-install-recommends \\
    python3 python3-pip python3-venv python3-dev python-is-python3 build-essential \\
    && rm -rf /var/lib/apt/lists/*

# Python tools
RUN pip install --break-system-packages \\
    poetry uv pipx ruff mypy black isort flake8 pylint bandit pytest pytest-cov coverage"""

    if stack == LanguageStack.NODE:
        packages["extra_languages"] = "# Node.js only"

    elif stack == LanguageStack.NODE_PYTHON:
        packages["extra_languages"] = python_full

    elif stack == LanguageStack.NODE_GO:
        packages["extra_languages"] = """# Go (latest)
RUN curl -fsSL "https://go.dev/dl/$(curl -fsSL https://go.dev/VERSION?m=text | head -1).linux-amd64.tar.gz" \\
    | tar -C /usr/local -xzf -
ENV PATH=$PATH:/usr/local/go/bin
ENV GOPATH=/home/node/go
ENV PATH=$PATH:$GOPATH/bin"""

    elif stack == LanguageStack.NODE_RUST:
        packages["extra_languages"] = """# Rust
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
ENV PATH="/home/node/.cargo/bin:$PATH" """

    elif stack == LanguageStack.NODE_JAVA:
        packages["extra_languages"] = """# Java (OpenJDK)
RUN apt-get update && apt-get install -y --no-install-recommends \\
    openjdk-17-jdk-headless maven gradle \\
    && rm -rf /var/lib/apt/lists/*
ENV JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64"""

    elif stack == LanguageStack.NODE_DOTNET:
        packages["extra_languages"] = """# .NET SDK
RUN curl -fsSL https://dot.net/v1/dotnet-install.sh | bash -s -- --channel LTS --install-dir /usr/share/dotnet
ENV DOTNET_ROOT=/usr/share/dotnet
ENV PATH=$PATH:/usr/share/dotnet"""

    elif stack == LanguageStack.UNIVERSAL:
        packages["extra_languages"] = f"""{python_full}

# Go (latest)
RUN curl -fsSL "https://go.dev/dl/$(curl -fsSL https://go.dev/VERSION?m=text | head -1).linux-amd64.tar.gz" \\
    | tar -C /usr/local -xzf -
ENV PATH=$PATH:/usr/local/go/bin
ENV GOPATH=/home/node/go
ENV PATH=$PATH:$GOPATH/bin

# Rust
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
ENV PATH="/home/node/.cargo/bin:$PATH" """

    else:
        packages["extra_languages"] = "# Custom stack"

    return packages


def get_optional_tools(config: Config) -> str:
    """Get optional tools installation commands."""
    tools = []

    if config.install_cco:
        tools.append("""# CCO (ClaudeCodeOptimizer)
RUN pip install --break-system-packages --force-reinstall \\
    git+https://github.com/sungurerdim/ClaudeCodeOptimizer.git""")

    if config.install_gh:
        tools.append("""# GitHub CLI (latest)
RUN GH_VERSION=$(curl -fsSL https://api.github.com/repos/cli/cli/releases/latest | jq -r .tag_name | sed 's/v//') \\
    && curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_amd64.tar.gz" \\
    | tar xz --strip-components=1 -C /usr/local""")

    if config.install_gitleaks:
        tools.append("""# Gitleaks (latest)
RUN GL_VERSION=$(curl -fsSL https://api.github.com/repos/gitleaks/gitleaks/releases/latest | jq -r .tag_name | sed 's/v//') \\
    && curl -fsSL "https://github.com/gitleaks/gitleaks/releases/download/v${GL_VERSION}/gitleaks_${GL_VERSION}_linux_x64.tar.gz" \\
    | tar xz -C /usr/local/bin gitleaks""")

    return "\n\n".join(tools) if tools else "# No optional tools"


def generate_dockerfile(config: Config, stack: LanguageStack) -> str:
    """Generate Dockerfile content for the given stack."""
    packages = get_language_packages(stack)
    optional_tools = get_optional_tools(config)

    context = {
        "extra_languages": packages["extra_languages"],
        "optional_tools": optional_tools,
        "ram_percent": config.ram_percent,
        "cpu_percent": config.cpu_percent,
    }

    return render_template("Dockerfile.template", context)


def generate_compose(
    config: Config,
    project_path: Path,
    project_name: str,
    stack: LanguageStack,
    build_dir: Path,
) -> str:
    """Generate docker-compose.yml content."""
    claude_config = Path(os.path.expanduser(config.claude_config_dir))

    extra_volumes = "".join(f"\n      - {vol}" for vol in config.extra_volumes)
    extra_env = "".join(f"\n      - {k}={v}" for k, v in config.extra_env.items())

    network_config = ""
    if config.docker_network:
        network_config = f"""
networks:
  default:
    name: {config.docker_network}
    external: true"""

    context = {
        "image_name": f"ccbox:{stack.value}",
        "container_name": f"ccbox-{project_name}",
        "build_dir": str(build_dir),
        "project_path": str(project_path),
        "project_name": project_name,
        "claude_config_dir": str(claude_config),
        "git_name": config.git_name,
        "git_email": config.git_email,
        "extra_volumes": extra_volumes,
        "extra_env": extra_env,
        "network_config": network_config,
    }

    return render_template("compose.yml.template", context)


def generate_entrypoint() -> str:
    """Generate entrypoint script content."""
    return render_template("entrypoint.sh.template", {})


def write_build_files(config: Config, stack: LanguageStack) -> Path:
    """Write Dockerfile and related files to ccbox directory."""
    build_dir = get_config_dir() / "build" / stack.value
    build_dir.mkdir(parents=True, exist_ok=True)

    dockerfile = generate_dockerfile(config, stack)
    (build_dir / "Dockerfile").write_text(dockerfile, encoding="utf-8")

    entrypoint = generate_entrypoint()
    (build_dir / "entrypoint.sh").write_text(entrypoint, encoding="utf-8")

    return build_dir


def write_compose_file(
    config: Config,
    project_path: Path,
    project_name: str,
    stack: LanguageStack,
    build_dir: Path,
) -> Path:
    """Write docker-compose.yml for a project."""
    compose_content = generate_compose(config, project_path, project_name, stack, build_dir)

    compose_dir = get_config_dir() / "compose"
    compose_dir.mkdir(parents=True, exist_ok=True)

    compose_file = compose_dir / f"{project_name}.yml"
    compose_file.write_text(compose_content, encoding="utf-8")

    return compose_file
