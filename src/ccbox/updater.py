"""Update checker for ccbox and CCO."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass

import requests

from . import __version__

# Timeout for HTTP requests
REQUEST_TIMEOUT = 5


@dataclass
class UpdateInfo:
    """Information about an available update."""

    package: str
    current: str
    latest: str
    changelog: str | None = None

    @property
    def has_update(self) -> bool:
        """Check if update is available."""
        return self._version_tuple(self.latest) > self._version_tuple(self.current)

    @staticmethod
    def _version_tuple(version: str) -> tuple[int, ...]:
        """Convert version string to comparable tuple."""
        # Remove 'v' prefix if present
        version = version.lstrip("v")
        # Extract numeric parts
        parts = re.findall(r"\d+", version)
        return tuple(int(p) for p in parts)


def check_ccbox_update() -> UpdateInfo | None:
    """Check PyPI for ccbox updates."""
    try:
        resp = requests.get(
            "https://pypi.org/pypi/ccbox/json",
            timeout=REQUEST_TIMEOUT,
        )
        if resp.status_code != 200:
            return None

        data = resp.json()
        latest = data.get("info", {}).get("version", "")
        if not latest:
            return None

        # Get changelog from releases
        changelog = None
        releases = data.get("releases", {})
        if latest in releases and releases[latest]:
            # Try to get description from latest release
            release_info = releases[latest][0] if releases[latest] else {}
            changelog = release_info.get("comment_text") or None

        return UpdateInfo(
            package="ccbox",
            current=__version__,
            latest=latest,
            changelog=changelog,
        )
    except (requests.RequestException, json.JSONDecodeError, KeyError):
        return None


def check_cco_update() -> UpdateInfo | None:
    """Check GitHub for CCO updates."""
    try:
        # Get latest release from GitHub
        resp = requests.get(
            "https://api.github.com/repos/sungurerdim/ClaudeCodeOptimizer/releases/latest",
            timeout=REQUEST_TIMEOUT,
            headers={"Accept": "application/vnd.github.v3+json"},
        )
        if resp.status_code != 200:
            return None

        data = resp.json()
        latest = data.get("tag_name", "")
        if not latest:
            return None

        # Get changelog from release body
        changelog = data.get("body")

        # Get current installed version
        current = _get_installed_cco_version()
        if not current:
            current = "0.0.0"

        return UpdateInfo(
            package="CCO",
            current=current,
            latest=latest,
            changelog=changelog,
        )
    except (requests.RequestException, json.JSONDecodeError, KeyError):
        return None


def _get_installed_cco_version() -> str | None:
    """Get currently installed CCO version."""
    try:
        from importlib.metadata import version

        return version("ClaudeCodeOptimizer")
    except Exception:
        return None


def check_all_updates() -> list[UpdateInfo]:
    """Check for all available updates."""
    updates: list[UpdateInfo] = []

    ccbox_update = check_ccbox_update()
    if ccbox_update and ccbox_update.has_update:
        updates.append(ccbox_update)

    cco_update = check_cco_update()
    if cco_update and cco_update.has_update:
        updates.append(cco_update)

    return updates


def format_changelog(changelog: str | None, max_lines: int = 10) -> str:
    """Format changelog for display."""
    if not changelog:
        return "[dim]No changelog available[/dim]"

    lines = changelog.strip().split("\n")
    if len(lines) > max_lines:
        lines = lines[:max_lines]
        lines.append("...")

    return "\n".join(f"  {line}" for line in lines)
