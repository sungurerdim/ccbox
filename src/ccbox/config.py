"""Configuration management for ccbox."""

from __future__ import annotations

import json
import os
from enum import Enum
from pathlib import Path

from pydantic import BaseModel


class LanguageStack(str, Enum):
    """Supported language stacks for Docker images.

    All stacks include base tools: Node.js + Python + CCO + linting/testing
    """

    BASE = "base"      # Node + Python + CCO + eslint/prettier/ruff/pytest (~600MB)
    GO = "go"          # + Go + golangci-lint (~750MB)
    RUST = "rust"      # + Rust + clippy (~900MB)
    JAVA = "java"      # + JDK (Temurin LTS) + Maven (~1GB)
    WEB = "web"        # + pnpm (fullstack) (~650MB)
    FULL = "full"      # All languages (~1.5GB)


# Stack descriptions for CLI help
STACK_INFO: dict[LanguageStack, tuple[str, int]] = {
    LanguageStack.BASE: ("Node + Python + CCO + lint/test tools", 600),
    LanguageStack.GO: ("+ Go (latest) + golangci-lint", 750),
    LanguageStack.RUST: ("+ Rust (latest) + clippy", 900),
    LanguageStack.JAVA: ("+ JDK (Temurin LTS) + Maven", 1000),
    LanguageStack.WEB: ("+ pnpm (fullstack)", 650),
    LanguageStack.FULL: ("All: Go + Rust + Java", 1500),
}


class Config(BaseModel):
    """ccbox configuration model."""

    version: str = "1.0.0"

    # Git settings (auto-detected from system if empty)
    git_name: str = ""
    git_email: str = ""

    # Claude config directory on host
    claude_config_dir: str = "~/.claude"


def get_config_dir() -> Path:
    """Get the ccbox configuration directory based on platform."""
    return Path.home() / ".ccbox"


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
    safe_name = "".join(c if c.isalnum() or c in "-_" else "-" for c in project_name.lower())
    return f"ccbox-{safe_name}"
