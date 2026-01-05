"""Docker operations for ccbox.

This module contains Docker-specific utilities and operations,
separated from CLI logic for better modularity.
"""

from __future__ import annotations

import subprocess
from typing import TYPE_CHECKING

from .constants import DOCKER_COMMAND_TIMEOUT
from .errors import DockerError, DockerNotFoundError, DockerTimeoutError
from .logging import get_logger
from .paths import get_docker_env

logger = get_logger(__name__)

if TYPE_CHECKING:
    from collections.abc import Sequence

# Error messages
ERR_DOCKER_NOT_RUNNING = "[red]Error: Docker is not running.[/red]"

# Re-export for backward compatibility
__all__ = [
    "DockerError",
    "DockerNotFoundError",
    "DockerTimeoutError",
    "safe_docker_run",
    "check_docker_status",
    "get_image_ids",
    "get_dangling_image_ids",
    "image_has_parent",
    "remove_image",
    "remove_container",
    "list_containers",
    "list_images",
]


def safe_docker_run(
    cmd: Sequence[str],
    *,
    timeout: int = DOCKER_COMMAND_TIMEOUT,
    capture_output: bool = True,
    check: bool = False,
) -> subprocess.CompletedProcess[str]:
    """Run a Docker command with consistent error handling.

    Args:
        cmd: Command to run (should start with 'docker').
        timeout: Command timeout in seconds.
        capture_output: Capture stdout/stderr if True.
        check: Raise CalledProcessError on non-zero exit.

    Returns:
        CompletedProcess with command result.

    Raises:
        DockerNotFoundError: If docker command is not found.
        DockerTimeoutError: If command times out.
        subprocess.CalledProcessError: If check=True and command fails.
    """
    cmd_str = " ".join(cmd[:4]) + ("..." if len(cmd) > 4 else "")
    logger.debug("Running Docker command: %s", cmd_str)
    try:
        result = subprocess.run(
            cmd,
            capture_output=capture_output,
            text=True,
            check=check,
            timeout=timeout,
            env=get_docker_env(),
        )
        logger.debug("Docker command completed: exit=%d", result.returncode)
        return result
    except FileNotFoundError as e:
        logger.error("Docker not found in PATH: %s", cmd_str)
        raise DockerNotFoundError(f"Docker not found in PATH. Command: {cmd_str}") from e
    except subprocess.TimeoutExpired as e:
        logger.error("Docker command timed out after %ds: %s", timeout, cmd_str)
        raise DockerTimeoutError(
            f"Docker command timed out after {timeout}s. Command: {cmd_str}"
        ) from e


def check_docker_status() -> bool:
    """Check if Docker daemon is responsive.

    Returns:
        True if Docker is running and responsive, False otherwise.
    """
    try:
        result = safe_docker_run(["docker", "info"])
        return result.returncode == 0
    except (DockerNotFoundError, DockerTimeoutError):
        return False


def get_image_ids(image_filter: str) -> set[str]:
    """Get Docker image IDs matching a filter.

    Args:
        image_filter: Image name/tag filter.

    Returns:
        Set of image IDs, or empty set on failure.
    """
    try:
        result = safe_docker_run(["docker", "images", "--format", "{{.ID}}", image_filter])
        if result.returncode != 0:
            return set()
        ids = set(result.stdout.strip().split("\n"))
        return ids - {""}  # Remove empty string if present
    except (DockerNotFoundError, DockerTimeoutError):
        return set()


def get_dangling_image_ids() -> list[str]:
    """Get all dangling image IDs.

    Returns:
        List of dangling image IDs, or empty list on failure.
    """
    try:
        result = safe_docker_run(["docker", "images", "-f", "dangling=true", "-q"])
        if result.returncode != 0 or not result.stdout.strip():
            return []
        return [i for i in result.stdout.strip().split("\n") if i]
    except (DockerNotFoundError, DockerTimeoutError):
        return []


def image_has_parent(image_id: str, parent_ids: set[str]) -> bool:
    """Check if an image's parent chain includes any of the given IDs.

    Args:
        image_id: Docker image ID to check.
        parent_ids: Set of potential parent image IDs.

    Returns:
        True if image has a parent in the set, False otherwise.
    """
    try:
        result = safe_docker_run(["docker", "history", "--no-trunc", "-q", image_id])
        if result.returncode != 0:
            return False
        history_ids = set(result.stdout.strip().split("\n"))
        return bool(history_ids & parent_ids)  # Intersection check
    except (DockerNotFoundError, DockerTimeoutError):
        return False


def remove_image(image_id: str, *, force: bool = True) -> bool:
    """Remove a Docker image.

    Args:
        image_id: Image ID or name to remove.
        force: Force removal if True.

    Returns:
        True if image was removed, False otherwise.
    """
    try:
        cmd = ["docker", "rmi"]
        if force:
            cmd.append("-f")
        cmd.append(image_id)
        result = safe_docker_run(cmd)
        return result.returncode == 0
    except (DockerNotFoundError, DockerTimeoutError):
        return False


def remove_container(container_name: str, *, force: bool = True) -> bool:
    """Remove a Docker container.

    Args:
        container_name: Container name or ID to remove.
        force: Force removal if True.

    Returns:
        True if container was removed, False otherwise.
    """
    try:
        cmd = ["docker", "rm"]
        if force:
            cmd.append("-f")
        cmd.append(container_name)
        result = safe_docker_run(cmd)
        return result.returncode == 0
    except (DockerNotFoundError, DockerTimeoutError):
        return False


def list_containers(
    name_filter: str | None = None,
    status_filter: str | None = None,
    all_containers: bool = True,
) -> list[str]:
    """List Docker containers matching filters.

    Args:
        name_filter: Filter by container name pattern.
        status_filter: Filter by status (running, exited, etc.).
        all_containers: Include stopped containers if True.

    Returns:
        List of container names matching filters.
    """
    try:
        cmd = ["docker", "ps", "--format", "{{.Names}}"]
        if all_containers:
            cmd.append("-a")
        if name_filter:
            cmd.extend(["--filter", f"name={name_filter}"])
        if status_filter:
            cmd.extend(["--filter", f"status={status_filter}"])

        result = safe_docker_run(cmd)
        if result.returncode != 0:
            return []
        return [name for name in result.stdout.strip().split("\n") if name]
    except (DockerNotFoundError, DockerTimeoutError):
        return []


def list_images(prefix: str | None = None) -> list[str]:
    """List Docker images, optionally filtered by prefix.

    Args:
        prefix: Optional prefix to filter images by repository name.

    Returns:
        List of image names (repository:tag format).
    """
    try:
        result = safe_docker_run(["docker", "images", "--format", "{{.Repository}}:{{.Tag}}"])
        if result.returncode != 0:
            return []

        images = result.stdout.strip().split("\n")
        if prefix:
            return [img for img in images if img and img.startswith(prefix)]
        return [img for img in images if img]
    except (DockerNotFoundError, DockerTimeoutError):
        return []
