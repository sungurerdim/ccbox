"""Configuration management for ccbox."""

from __future__ import annotations

import json
import os
from dataclasses import asdict, dataclass
from enum import Enum
from pathlib import Path


class LanguageStack(str, Enum):
    """Supported language stacks for Docker images.

    All stacks include base tools: Node.js + Python + CCO + linting/testing
    """

    BASE = "base"      # Node + Python + CCO + eslint/prettier/ruff/pytest (~450MB)
    GO = "go"          # + Go + golangci-lint (~750MB)
    RUST = "rust"      # + Rust + clippy (~900MB)
    JAVA = "java"      # + JDK (Temurin LTS) + Maven (~1GB)
    WEB = "web"        # + pnpm (fullstack) (~500MB)
    FULL = "full"      # All languages (~1.35GB)


# Stack descriptions for CLI help (sizes are estimates, no dev tools)
STACK_INFO: dict[LanguageStack, tuple[str, int]] = {
    LanguageStack.BASE: ("Node + Python + CCO + lint/test tools", 450),
    LanguageStack.GO: ("+ Go (latest) + golangci-lint", 750),
    LanguageStack.RUST: ("+ Rust (latest) + clippy", 900),
    LanguageStack.JAVA: ("+ JDK (Temurin LTS) + Maven", 1000),
    LanguageStack.WEB: ("+ pnpm (fullstack)", 500),
    LanguageStack.FULL: ("All: Go + Rust + Java", 1350),
}

# Stack dependencies: stacks that require ccbox:base to be built first
# WEB and FULL use FROM ccbox:base for layer sharing
# GO, RUST, JAVA use their own base images (golang:latest, rust:latest, etc.)
STACK_DEPENDENCIES: dict[LanguageStack, LanguageStack | None] = {
    LanguageStack.BASE: None,
    LanguageStack.GO: None,
    LanguageStack.RUST: None,
    LanguageStack.JAVA: None,
    LanguageStack.WEB: LanguageStack.BASE,
    LanguageStack.FULL: LanguageStack.BASE,
}


@dataclass
class Config:
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
        json.dumps(asdict(config), indent=2, ensure_ascii=False),
        encoding="utf-8",
    )


def get_claude_config_dir(config: Config) -> Path:
    """Get expanded Claude config directory path."""
    return Path(os.path.expanduser(config.claude_config_dir))


def get_image_name(stack: LanguageStack) -> str:
    """Get Docker image name for a language stack."""
    return f"ccbox:{stack.value}"


def get_container_name(project_name: str, unique: bool = True) -> str:
    """Get Docker container name for a project.

    Args:
        project_name: Name of the project directory.
        unique: If True, append a short unique suffix to allow multiple instances.
    """
    import uuid

    safe_name = "".join(c if c.isalnum() or c in "-_" else "-" for c in project_name.lower())
    if unique:
        suffix = uuid.uuid4().hex[:6]
        return f"ccbox-{safe_name}-{suffix}"
    return f"ccbox-{safe_name}"
