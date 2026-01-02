"""Unified exception hierarchy for ccbox.

All custom exceptions inherit from CCBoxError for consistent error handling.
CLI catches these and converts to user-friendly messages via click.ClickException.

Dependency direction:
    This module has NO internal dependencies (leaf module).
    It may be imported by: all other ccbox modules.
    It should NOT import from any other ccbox modules.
"""

from __future__ import annotations


class CCBoxError(Exception):
    """Base exception for all ccbox errors.

    All ccbox-specific exceptions should inherit from this class.
    This enables consistent error handling at the CLI layer.
    """


class ConfigError(CCBoxError):
    """Configuration-related errors.

    Examples:
        - Invalid configuration values
        - Missing required configuration
        - Configuration file parse errors
    """


class PathError(CCBoxError):
    """Path validation and access errors.

    Examples:
        - Path traversal attempts
        - Symlink attacks
        - Path outside allowed boundaries
        - Invalid path format
    """


class DockerError(CCBoxError):
    """Docker operation errors.

    Base class for all Docker-related exceptions.
    """


class DockerNotFoundError(DockerError):
    """Raised when Docker is not installed or not in PATH."""


class DockerTimeoutError(DockerError):
    """Raised when a Docker operation times out."""


class DockerNotRunningError(DockerError):
    """Raised when Docker daemon is not running."""


class ImageBuildError(DockerError):
    """Raised when Docker image build fails."""


class ContainerError(DockerError):
    """Raised when container operations fail."""


class DependencyError(CCBoxError):
    """Dependency detection and resolution errors.

    Examples:
        - Unable to detect package manager
        - Conflicting dependencies
        - Missing required dependencies
    """


class ValidationError(CCBoxError):
    """Input validation errors.

    Examples:
        - Invalid prompt length
        - Invalid model name
        - Invalid stack name
    """
