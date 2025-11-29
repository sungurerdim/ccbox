"""Configuration management for ccbox."""

from __future__ import annotations

import json
import os
import platform
from enum import Enum
from pathlib import Path
from typing import Optional

from pydantic import BaseModel, Field


class RuntimeMode(str, Enum):
    """Claude Code runtime mode."""

    BYPASS = "bypass"  # --dangerously-skip-permissions
    SAFE = "safe"  # Normal mode with confirmations


class LanguageStack(str, Enum):
    """Supported language stacks for Docker images."""

    UNIVERSAL = "universal"  # node + python + go + rust + common tools
    NODE = "node"  # Node.js only (minimal)
    NODE_PYTHON = "node-python"  # Node.js + Python
    NODE_GO = "node-go"  # Node.js + Go
    NODE_RUST = "node-rust"  # Node.js + Rust
    NODE_JAVA = "node-java"  # Node.js + Java
    NODE_DOTNET = "node-dotnet"  # Node.js + .NET
    CUSTOM = "custom"  # User-defined Dockerfile


# Language stack descriptions for UI
STACK_DESCRIPTIONS: dict[str, str] = {
    LanguageStack.UNIVERSAL: "All languages: Node + Python + Go + Rust (~2GB)",
    LanguageStack.NODE: "Node.js only - minimal image (~500MB)",
    LanguageStack.NODE_PYTHON: "Node.js + Python 3 (~800MB)",
    LanguageStack.NODE_GO: "Node.js + Go (~900MB)",
    LanguageStack.NODE_RUST: "Node.js + Rust (~1.2GB)",
    LanguageStack.NODE_JAVA: "Node.js + OpenJDK (~1GB)",
    LanguageStack.NODE_DOTNET: "Node.js + .NET SDK (~1.5GB)",
    LanguageStack.CUSTOM: "Custom Dockerfile (advanced)",
}


class Config(BaseModel):
    """ccbox configuration model."""

    version: str = "1.0.0"

    # Git settings
    git_name: str = ""
    git_email: str = ""

    # Performance settings
    ram_percent: int = Field(default=75, ge=10, le=100)
    cpu_percent: int = Field(default=100, ge=10, le=100)

    # Runtime settings
    default_mode: RuntimeMode = RuntimeMode.BYPASS
    default_stack: LanguageStack = LanguageStack.NODE_PYTHON

    # Optional tools (minimal by default)
    install_cco: bool = False
    install_gh: bool = False
    install_gitleaks: bool = False

    # Paths
    claude_config_dir: str = "~/.claude"

    # Advanced settings
    docker_network: Optional[str] = None
    extra_volumes: list[str] = Field(default_factory=list)
    extra_env: dict[str, str] = Field(default_factory=dict)
    custom_dockerfile: Optional[str] = None


def get_config_dir() -> Path:
    """Get the ccbox configuration directory based on platform."""
    if platform.system() == "Windows":
        base = os.environ.get("USERPROFILE", os.path.expanduser("~"))
    else:
        base = os.environ.get("HOME", os.path.expanduser("~"))

    return Path(base) / ".ccbox"


def get_config_path() -> Path:
    """Get the path to the config file."""
    return get_config_dir() / "config.json"


def load_config() -> Config:
    """Load configuration from file, or return defaults."""
    config_path = get_config_path()

    if config_path.exists():
        try:
            data = json.loads(config_path.read_text(encoding="utf-8"))
            return Config(**data)
        except (json.JSONDecodeError, ValueError):
            # Invalid config, return defaults
            pass

    return Config()


def save_config(config: Config) -> None:
    """Save configuration to file."""
    config_dir = get_config_dir()
    config_dir.mkdir(parents=True, exist_ok=True)

    config_path = get_config_path()
    config_path.write_text(
        json.dumps(config.model_dump(), indent=2, ensure_ascii=False),
        encoding="utf-8",
    )


def get_claude_config_dir(config: Config) -> Path:
    """Get expanded Claude config directory path."""
    return Path(os.path.expanduser(config.claude_config_dir))


def get_image_name(stack: LanguageStack) -> str:
    """Get Docker image name for a language stack."""
    return f"ccbox:{stack.value}"


def get_container_name(project_name: str) -> str:
    """Get Docker container name for a project."""
    # Sanitize project name for Docker
    safe_name = "".join(c if c.isalnum() or c in "-_" else "-" for c in project_name.lower())
    return f"ccbox-{safe_name}"
