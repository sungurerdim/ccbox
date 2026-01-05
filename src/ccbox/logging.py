"""Structured logging configuration for ccbox.

Provides dual output strategy:
- console.print() for user-facing messages (Rich formatting)
- logging module for debugging/monitoring (structured, filterable)

Usage:
    from ccbox.logging import get_logger
    logger = get_logger(__name__)
    logger.debug("Docker command: %s", cmd)
    logger.info("Image built successfully")

Enable verbose logging via:
    - CLI flag: ccbox --debug
    - Environment: CCBOX_DEBUG=1
"""

from __future__ import annotations

import logging
import os
import sys

# Module-level logger cache
_loggers: dict[str, logging.Logger] = {}
_initialized = False

# Log format for structured output
LOG_FORMAT = "%(asctime)s [%(levelname)s] %(name)s: %(message)s"
LOG_FORMAT_DEBUG = "%(asctime)s [%(levelname)s] %(name)s:%(lineno)d: %(message)s"
DATE_FORMAT = "%Y-%m-%d %H:%M:%S"


def _get_log_level() -> int:
    """Determine log level from environment."""
    if os.environ.get("CCBOX_DEBUG", "").lower() in ("1", "true", "yes"):
        return logging.DEBUG
    return logging.WARNING


def _init_logging() -> None:
    """Initialize logging configuration (called once)."""
    global _initialized
    if _initialized:
        return

    level = _get_log_level()
    is_debug = level == logging.DEBUG

    # Configure root ccbox logger
    root_logger = logging.getLogger("ccbox")
    root_logger.setLevel(level)

    # Only add handler if none exist (avoid duplicate handlers)
    if not root_logger.handlers:
        handler = logging.StreamHandler(sys.stderr)
        handler.setLevel(level)
        formatter = logging.Formatter(
            LOG_FORMAT_DEBUG if is_debug else LOG_FORMAT,
            datefmt=DATE_FORMAT,
        )
        handler.setFormatter(formatter)
        root_logger.addHandler(handler)

    _initialized = True


def get_logger(name: str) -> logging.Logger:
    """Get a logger instance for a module.

    Args:
        name: Module name (typically __name__).

    Returns:
        Configured logger instance.

    Example:
        logger = get_logger(__name__)
        logger.debug("Processing file: %s", filepath)
    """
    # Ensure logging is initialized
    _init_logging()

    # Normalize name to ccbox namespace
    if not name.startswith("ccbox"):
        name = f"ccbox.{name}"

    if name not in _loggers:
        _loggers[name] = logging.getLogger(name)

    return _loggers[name]


def set_debug(enabled: bool = True) -> None:
    """Enable or disable debug logging.

    Called by CLI when --debug flag is used.

    Args:
        enabled: If True, set log level to DEBUG.
    """
    level = logging.DEBUG if enabled else logging.WARNING
    root_logger = logging.getLogger("ccbox")
    root_logger.setLevel(level)

    for handler in root_logger.handlers:
        handler.setLevel(level)
        if enabled:
            handler.setFormatter(logging.Formatter(LOG_FORMAT_DEBUG, datefmt=DATE_FORMAT))
        else:
            handler.setFormatter(logging.Formatter(LOG_FORMAT, datefmt=DATE_FORMAT))
