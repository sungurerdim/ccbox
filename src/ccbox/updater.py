"""Update checker for ccbox and CCO."""

from __future__ import annotations

import json
import re
import subprocess
from dataclasses import dataclass

import requests

from . import __version__
from .config import LanguageStack, get_image_name

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


def _image_exists(stack: LanguageStack = LanguageStack.BASE) -> bool:
    """Check if docker image exists."""
    try:
        result = subprocess.run(
            ["docker", "image", "inspect", get_image_name(stack)],
            capture_output=True,
            check=False,
        )
        return result.returncode == 0
    except FileNotFoundError:
        return False


def _get_docker_version(command: str, stack: LanguageStack = LanguageStack.BASE) -> str | None:
    """Get version from inside docker container."""
    try:
        result = subprocess.run(
            ["docker", "run", "--rm", get_image_name(stack), "bash", "-c", command],
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )
        if result.returncode == 0 and result.stdout.strip():
            return result.stdout.strip()
        return None
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return None


def check_cco_update(stack: LanguageStack = LanguageStack.BASE) -> UpdateInfo | None:
    """Check GitHub for CCO updates (version from docker image)."""
    # Skip if no image exists
    if not _image_exists(stack):
        return None

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

        # Get current installed version from docker image
        cmd = "pip show ClaudeCodeOptimizer | grep Version | cut -d' ' -f2"
        current = _get_docker_version(cmd, stack)
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


def check_claude_code_update(stack: LanguageStack = LanguageStack.BASE) -> UpdateInfo | None:
    """Check npm for Claude Code updates (version from docker image)."""
    # Skip if no image exists
    if not _image_exists(stack):
        return None

    try:
        # Get latest version from npm
        resp = requests.get(
            "https://registry.npmjs.org/@anthropic-ai/claude-code/latest",
            timeout=REQUEST_TIMEOUT,
        )
        if resp.status_code != 200:
            return None

        data = resp.json()
        latest = data.get("version", "")
        if not latest:
            return None

        # Get current installed version from docker image
        cmd = r"claude --version 2>/dev/null | head -1 | grep -oP '[0-9]+\.[0-9]+\.[0-9]+'"
        current = _get_docker_version(cmd, stack)
        if not current:
            current = "0.0.0"

        return UpdateInfo(
            package="Claude Code",
            current=current,
            latest=latest,
        )
    except (requests.RequestException, json.JSONDecodeError, KeyError):
        return None


def _get_installed_cco_version() -> str | None:
    """Get currently installed CCO version (host - deprecated, kept for compatibility)."""
    try:
        from importlib.metadata import version

        return version("ClaudeCodeOptimizer")
    except Exception:
        return None


def check_all_updates(stack: LanguageStack = LanguageStack.BASE) -> list[UpdateInfo]:
    """Check for all available updates."""
    updates: list[UpdateInfo] = []

    # ccbox update (host)
    ccbox_update = check_ccbox_update()
    if ccbox_update and ccbox_update.has_update:
        updates.append(ccbox_update)

    # Claude Code update (docker image)
    claude_update = check_claude_code_update(stack)
    if claude_update and claude_update.has_update:
        updates.append(claude_update)

    # CCO update (docker image)
    cco_update = check_cco_update(stack)
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
