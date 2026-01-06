"""Configuration management for ccbox.

Dependency direction:
    This module has minimal dependencies (near-leaf module).
    It may be imported by: cli.py, generator.py, docker.py, paths.py
    It should NOT import from: cli, generator, sleepctl
"""

from __future__ import annotations

import os
import subprocess
import uuid
from dataclasses import dataclass
from enum import Enum
from pathlib import Path

from .constants import DOCKER_COMMAND_TIMEOUT as _DOCKER_COMMAND_TIMEOUT


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

# Stacks that include CCO (all except MINIMAL) - SSOT for cco-install logic
CCO_ENABLED_STACKS: frozenset[LanguageStack] = frozenset(
    {
        LanguageStack.BASE,
        LanguageStack.GO,
        LanguageStack.RUST,
        LanguageStack.JAVA,
        LanguageStack.WEB,
        LanguageStack.FULL,
    }
)


@dataclass
class Config:
    """ccbox configuration model."""

    version: str = "1.0.0"

    # Git settings (auto-detected from system if empty)
    git_name: str = ""
    git_email: str = ""

    # Claude config directory on host
    claude_config_dir: str = "~/.claude"


def create_config() -> Config:
    """Create a new Config with defaults."""
    return Config()


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
    return f"ccbox/{stack.value}"


# Re-export from constants for backward compatibility
DOCKER_COMMAND_TIMEOUT = _DOCKER_COMMAND_TIMEOUT


def image_exists(stack: LanguageStack) -> bool:
    """Check if Docker image exists for stack."""
    try:
        result = subprocess.run(
            ["docker", "image", "inspect", get_image_name(stack)],
            capture_output=True,
            check=False,
            timeout=DOCKER_COMMAND_TIMEOUT,
        )
        return result.returncode == 0
    except (FileNotFoundError, subprocess.TimeoutExpired):
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
        return f"ccbox.{safe_name}-{suffix}"
    return f"ccbox.{safe_name}"
