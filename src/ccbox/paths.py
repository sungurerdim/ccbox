"""Cross-platform path utilities for Docker mount compatibility.

Handles path conversion between Windows, WSL, and Docker formats.
Docker Desktop expects POSIX-style paths: /c/Users/... (not C:\\Users\\...)
"""

from __future__ import annotations

import os
import re
from pathlib import Path

# Cached WSL detection result
_is_wsl_cached: bool | None = None


def is_windows_path(path: str | Path) -> bool:
    """Check if path is a Windows-style path (e.g., D:\\GitHub or D:/GitHub).

    Args:
        path: Path to check.

    Returns:
        True if path looks like a Windows path (has drive letter).
    """
    path_str = str(path)
    # Match patterns like: D:\, D:/, D:
    return bool(re.match(r"^[A-Za-z]:[/\\]", path_str))


def is_wsl() -> bool:
    """Check if running inside WSL.

    Result is cached for performance.

    Returns:
        True if running in WSL environment.
    """
    global _is_wsl_cached
    if _is_wsl_cached is not None:
        return _is_wsl_cached

    # Check for WSL-specific kernel
    try:
        with open("/proc/version", encoding="utf-8") as f:
            if "microsoft" in f.read().lower():
                _is_wsl_cached = True
                return True
    except (OSError, PermissionError):
        pass

    # Fallback: check WSL env vars
    _is_wsl_cached = bool(os.environ.get("WSL_DISTRO_NAME") or os.environ.get("WSLENV"))
    return _is_wsl_cached


def _normalize_path_separators(path_str: str) -> str:
    """Normalize path separators to forward slashes and remove duplicates.

    Args:
        path_str: Path string to normalize.

    Returns:
        Normalized path with single forward slashes.
    """
    # Convert backslashes to forward slashes
    normalized = path_str.replace("\\", "/")
    # Remove all duplicate slashes
    while "//" in normalized:
        normalized = normalized.replace("//", "/")
    # Remove trailing slash (unless it's root)
    if len(normalized) > 1:
        normalized = normalized.rstrip("/")
    return normalized


def windows_to_docker_path(path: str | Path) -> str:
    """Convert Windows path to Docker Desktop compatible format.

    Docker Desktop on Windows expects paths in POSIX format with lowercase
    drive letter prefix: D:\\GitHub\\Project -> /d/GitHub/Project

    Args:
        path: Windows path to convert.

    Returns:
        Docker-compatible POSIX path.

    Examples:
        >>> windows_to_docker_path("D:\\\\GitHub\\\\Project")
        '/d/GitHub/Project'
        >>> windows_to_docker_path("C:/Users/name/project")
        '/c/Users/name/project'
        >>> windows_to_docker_path("C:\\\\")
        '/c'
    """
    path_str = str(path)

    # Extract drive letter and rest of path
    match = re.match(r"^([A-Za-z]):[/\\]*(.*)$", path_str)
    if not match:
        return path_str  # Not a Windows path, return as-is

    drive = match.group(1).lower()
    rest = match.group(2)

    # Normalize separators (handles backslashes, duplicates, trailing)
    rest = _normalize_path_separators(rest)

    # Handle root drive case (C:\ or C:)
    if not rest:
        return f"/{drive}"

    return f"/{drive}/{rest}"


def wsl_to_docker_path(path: str | Path) -> str:
    """Convert WSL path to Docker Desktop compatible format.

    WSL paths like /mnt/d/GitHub/Project need to be converted to
    Docker Desktop format: /d/GitHub/Project

    Args:
        path: WSL path to convert.

    Returns:
        Docker-compatible POSIX path.

    Examples:
        >>> wsl_to_docker_path("/mnt/c/Users/name/project")
        '/c/Users/name/project'
        >>> wsl_to_docker_path("/mnt/d/")
        '/d'
    """
    path_str = str(path)

    # WSL mount pattern: /mnt/[drive]/...
    match = re.match(r"^/mnt/([a-z])(?:/(.*))?$", path_str)
    if match:
        drive = match.group(1)
        rest = match.group(2) or ""
        rest = _normalize_path_separators(rest)
        if not rest:
            return f"/{drive}"
        return f"/{drive}/{rest}"

    return path_str


def resolve_for_docker(path: Path) -> str:
    """Resolve path to Docker-compatible format.

    This is the main function to use for Docker volume mounts.
    Handles all platform variations automatically.

    Handles:
    - Windows paths (D:\\GitHub\\...) -> /d/GitHub/...
    - WSL paths (/mnt/d/...) -> /d/...
    - Native Linux/macOS paths -> unchanged

    Args:
        path: Path to resolve (should already be absolute/resolved).

    Returns:
        Docker-compatible path string for volume mounts.

    Examples:
        >>> resolve_for_docker(Path("D:/GitHub/Project"))
        '/d/GitHub/Project'
        >>> resolve_for_docker(Path("/mnt/c/Users/name"))
        '/c/Users/name'
        >>> resolve_for_docker(Path("/home/user/project"))
        '/home/user/project'
    """
    path_str = str(path)

    # Normalize backslashes for consistent pattern matching
    # (On Windows, Path("/mnt/c/...") becomes "\mnt\c\..." as string)
    path_str = path_str.replace("\\", "/")

    # Case 1: Windows-style path (from click.Path with resolve_path=True on Windows)
    if is_windows_path(path_str):
        return windows_to_docker_path(path_str)

    # Case 2: WSL mount path (/mnt/[a-z] or /mnt/[a-z]/...)
    # Check: starts with /mnt/, has at least 6 chars, 6th char is lowercase letter,
    # and either exactly 6 chars or 7th char is /
    if (
        path_str.startswith("/mnt/")
        and len(path_str) >= 6
        and path_str[5].isalpha()
        and path_str[5].islower()
        and (len(path_str) == 6 or path_str[6] == "/")
    ):
        return wsl_to_docker_path(path_str)

    # Case 3: Native Linux/macOS path - use as-is
    return path_str


