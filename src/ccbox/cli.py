"""CLI for ccbox - Secure Docker environment for Claude Code.

This module re-exports from the cli package for backward compatibility.
The actual implementation is in the cli/ subpackage.
"""

from __future__ import annotations

# Re-export everything from the cli package
from .cli import (
    build_image,
    check_docker,
    cli,
    get_git_config,
)

# Re-export constants for backward compatibility
from .cli.utils import (
    DOCKER_CHECK_INTERVAL_SECONDS,
    DOCKER_STARTUP_TIMEOUT_SECONDS,
    ERR_DOCKER_NOT_RUNNING,
)

__all__ = [
    "cli",
    "check_docker",
    "build_image",
    "get_git_config",
    "DOCKER_STARTUP_TIMEOUT_SECONDS",
    "DOCKER_CHECK_INTERVAL_SECONDS",
    "ERR_DOCKER_NOT_RUNNING",
]

if __name__ == "__main__":  # pragma: no cover
    cli()
