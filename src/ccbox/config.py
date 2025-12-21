"""Configuration management for ccbox."""

from __future__ import annotations

import json
import os
import subprocess
import uuid
from dataclasses import asdict, dataclass
from enum import Enum
from pathlib import Path

from rich.console import Console

console = Console(stderr=True)


class LanguageStack(str, Enum):
    """Supported language stacks for Docker images.

    Hierarchy: minimal (no CCO) -> base (+ CCO) -> web/full (+ extras)
    Standalone: go, rust, java (own base images + CCO)
    """

    MINIMAL = "minimal"  # Node + Python + tools (no CCO) (~400MB)
    BASE = "base"  # minimal + CCO (~450MB)
    GO = "go"  # Go + Node + Python + CCO (~750MB)
    RUST = "rust"  # Rust + Node + Python + CCO (~900MB)
    JAVA = "java"  # JDK (Temurin LTS) + Maven + CCO (~1GB)
    WEB = "web"  # base + pnpm (fullstack) (~500MB)
    FULL = "full"  # base + Go + Rust + Java (~1.35GB)


# Stack descriptions for CLI help (sizes are estimates)
STACK_INFO: dict[LanguageStack, tuple[str, int]] = {
    LanguageStack.MINIMAL: ("Node + Python + tools (no CCO)", 400),
    LanguageStack.BASE: ("minimal + CCO (default)", 450),
    LanguageStack.GO: ("Go + Node + Python + CCO", 750),
    LanguageStack.RUST: ("Rust + Node + Python + CCO", 900),
    LanguageStack.JAVA: ("JDK (Temurin) + Maven + CCO", 1000),
    LanguageStack.WEB: ("base + pnpm (fullstack)", 500),
    LanguageStack.FULL: ("base + Go + Rust + Java", 1350),
}

# Stack dependencies: which stack must be built first
# Hierarchy: minimal -> base -> web/full
# GO, RUST, JAVA use their own base images (golang:latest, rust:latest, etc.)
STACK_DEPENDENCIES: dict[LanguageStack, LanguageStack | None] = {
    LanguageStack.MINIMAL: None,
    LanguageStack.BASE: LanguageStack.MINIMAL,
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
        except (json.JSONDecodeError, ValueError) as e:
            console.print(f"[yellow]Warning: Failed to load config ({e}), using defaults[/yellow]")

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


class ConfigPathError(ValueError):
    """Raised when a config path is invalid or unsafe."""


def validate_safe_path(path: Path, description: str = "path") -> Path:
    """Validate that a path is safe (within user's home directory).

    Args:
        path: Path to validate (should already be expanded/resolved).
        description: Human-readable description for error messages.

    Returns:
        The validated path.

    Raises:
        ConfigPathError: If path is outside user's home directory or is a symlink.
    """
    home = Path.home().resolve()

    # Security: reject symlinks to prevent symlink attacks
    if path.is_symlink():
        raise ConfigPathError(f"{description} cannot be a symlink: {path}")

    resolved = path.resolve()

    # Check if path is within home directory
    try:
        resolved.relative_to(home)
    except ValueError as e:
        raise ConfigPathError(
            f"Invalid {description}: '{resolved}' must be within home directory '{home}'"
        ) from e

    return resolved


def get_claude_config_dir(config: Config) -> Path:
    """Get expanded and validated Claude config directory path.

    Raises:
        ConfigPathError: If path traversal is detected.
    """
    expanded = Path(os.path.expanduser(config.claude_config_dir))
    return validate_safe_path(expanded, "claude_config_dir")


def get_image_name(stack: LanguageStack) -> str:
    """Get Docker image name for a language stack."""
    return f"ccbox:{stack.value}"


def image_exists(stack: LanguageStack) -> bool:
    """Check if Docker image exists for stack."""
    try:
        result = subprocess.run(
            ["docker", "image", "inspect", get_image_name(stack)],
            capture_output=True,
            check=False,
        )
        return result.returncode == 0
    except FileNotFoundError:
        return False


def get_container_name(project_name: str, unique: bool = True) -> str:
    """Get Docker container name for a project.

    Args:
        project_name: Name of the project directory.
        unique: If True, append a short unique suffix to allow multiple instances.
    """
    safe_name = "".join(c if c.isalnum() or c in "-_" else "-" for c in project_name.lower())
    if unique:
        suffix = uuid.uuid4().hex[:6]
        return f"ccbox-{safe_name}-{suffix}"
    return f"ccbox-{safe_name}"
