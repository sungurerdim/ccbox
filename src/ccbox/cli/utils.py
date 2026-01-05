"""CLI utilities for ccbox.

Docker status checks, git configuration, and console setup.
"""

from __future__ import annotations

import os
import platform
import subprocess
import time
from pathlib import Path

from rich.console import Console

from .. import docker
from ..config import DOCKER_COMMAND_TIMEOUT
from ..constants import DOCKER_CHECK_INTERVAL, DOCKER_STARTUP_TIMEOUT

console = Console(force_terminal=True, legacy_windows=False)

# Re-export constants for backward compatibility
DOCKER_STARTUP_TIMEOUT_SECONDS = DOCKER_STARTUP_TIMEOUT
DOCKER_CHECK_INTERVAL_SECONDS = DOCKER_CHECK_INTERVAL
ERR_DOCKER_NOT_RUNNING = "[red]Error: Docker is not running.[/red]"


def _check_docker_status() -> bool:
    """Check if Docker daemon is responsive."""
    return docker.check_docker_status()


def _start_docker_desktop() -> bool:
    """Attempt to start Docker Desktop based on platform."""
    system = platform.system()

    if system == "Windows":
        result = subprocess.run(
            ["docker", "desktop", "start"],
            capture_output=True,
            check=False,
            timeout=DOCKER_COMMAND_TIMEOUT,
        )
        if result.returncode == 0:
            return True
        docker_path = Path(os.environ.get("PROGRAMFILES", "C:\\Program Files"))
        docker_exe = docker_path / "Docker" / "Docker" / "Docker Desktop.exe"
        if docker_exe.exists():
            try:
                subprocess.Popen([str(docker_exe)], start_new_session=True)
                return True
            except (OSError, PermissionError):
                return False
    elif system == "Darwin":
        subprocess.run(
            ["open", "-a", "Docker"],
            capture_output=True,
            check=False,
            timeout=DOCKER_COMMAND_TIMEOUT,
        )
        return True
    return False


def check_docker(auto_start: bool = True) -> bool:
    """Check if Docker is available and running, optionally auto-start."""
    if _check_docker_status():
        return True

    if auto_start:
        console.print("[dim]Docker not running, attempting to start...[/dim]")
        if _start_docker_desktop():
            for i in range(DOCKER_STARTUP_TIMEOUT_SECONDS):
                time.sleep(1)
                if _check_docker_status():
                    console.print("[green]Docker started successfully[/green]")
                    return True
                if i % DOCKER_CHECK_INTERVAL_SECONDS == DOCKER_CHECK_INTERVAL_SECONDS - 1:
                    console.print(f"[dim]Waiting for Docker... ({i + 1}s)[/dim]")
    return False


def _get_git_config_value(key: str) -> str:
    """Get a single git config value."""
    try:
        result = subprocess.run(
            ["git", "config", "--global", key],
            capture_output=True,
            text=True,
            check=False,
            timeout=DOCKER_COMMAND_TIMEOUT,
        )
        if result.returncode == 0:
            return result.stdout.strip()
    except FileNotFoundError:
        console.print("[dim]Git not found in PATH[/dim]", highlight=False)
    except subprocess.TimeoutExpired:
        console.print(f"[dim]Git config {key} timed out[/dim]", highlight=False)
    return ""


def get_git_config() -> tuple[str, str]:
    """Get git user.name and user.email from system."""
    return _get_git_config_value("user.name"), _get_git_config_value("user.email")
