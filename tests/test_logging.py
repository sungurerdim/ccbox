"""Tests for ccbox.logging module."""

from __future__ import annotations

import logging
import os
from unittest.mock import patch

import pytest

from ccbox.logging import _get_log_level, _init_logging, get_logger, set_debug


class TestGetLogLevel:
    """Tests for _get_log_level function."""

    def test_default_is_warning(self) -> None:
        """Default log level is WARNING when no env var set."""
        with patch.dict(os.environ, {}, clear=True):
            # Remove CCBOX_DEBUG if it exists
            os.environ.pop("CCBOX_DEBUG", None)
            assert _get_log_level() == logging.WARNING

    def test_debug_enabled_with_1(self) -> None:
        """CCBOX_DEBUG=1 enables debug logging."""
        with patch.dict(os.environ, {"CCBOX_DEBUG": "1"}):
            assert _get_log_level() == logging.DEBUG

    def test_debug_enabled_with_true(self) -> None:
        """CCBOX_DEBUG=true enables debug logging."""
        with patch.dict(os.environ, {"CCBOX_DEBUG": "true"}):
            assert _get_log_level() == logging.DEBUG

    def test_debug_enabled_with_yes(self) -> None:
        """CCBOX_DEBUG=yes enables debug logging."""
        with patch.dict(os.environ, {"CCBOX_DEBUG": "yes"}):
            assert _get_log_level() == logging.DEBUG

    def test_debug_enabled_case_insensitive(self) -> None:
        """CCBOX_DEBUG values are case insensitive."""
        with patch.dict(os.environ, {"CCBOX_DEBUG": "TRUE"}):
            assert _get_log_level() == logging.DEBUG

    def test_invalid_value_is_warning(self) -> None:
        """Invalid CCBOX_DEBUG value defaults to WARNING."""
        with patch.dict(os.environ, {"CCBOX_DEBUG": "invalid"}):
            assert _get_log_level() == logging.WARNING


class TestGetLogger:
    """Tests for get_logger function."""

    def test_returns_logger(self) -> None:
        """get_logger returns a Logger instance."""
        logger = get_logger("test_module")
        assert isinstance(logger, logging.Logger)

    def test_prefixes_with_ccbox(self) -> None:
        """Logger names are prefixed with 'ccbox' if not already."""
        logger = get_logger("my_module")
        assert logger.name.startswith("ccbox")

    def test_ccbox_prefix_not_duplicated(self) -> None:
        """Logger names starting with 'ccbox' are not double-prefixed."""
        logger = get_logger("ccbox.docker")
        assert logger.name == "ccbox.docker"

    def test_caches_loggers(self) -> None:
        """Same logger is returned for same name."""
        logger1 = get_logger("cached_module")
        logger2 = get_logger("cached_module")
        assert logger1 is logger2


class TestSetDebug:
    """Tests for set_debug function."""

    def test_enable_debug(self) -> None:
        """set_debug(True) sets log level to DEBUG."""
        set_debug(True)
        root_logger = logging.getLogger("ccbox")
        assert root_logger.level == logging.DEBUG

    def test_disable_debug(self) -> None:
        """set_debug(False) sets log level to WARNING."""
        set_debug(False)
        root_logger = logging.getLogger("ccbox")
        assert root_logger.level == logging.WARNING


class TestInitLogging:
    """Tests for _init_logging function."""

    def test_idempotent(self) -> None:
        """_init_logging can be called multiple times safely."""
        # Should not raise
        _init_logging()
        _init_logging()
        _init_logging()

    def test_adds_handler(self) -> None:
        """_init_logging adds a handler to the ccbox logger."""
        _init_logging()
        root_logger = logging.getLogger("ccbox")
        assert len(root_logger.handlers) >= 1


class TestLoggerIntegration:
    """Integration tests for logging usage."""

    def test_logger_can_log(self, caplog: pytest.LogCaptureFixture) -> None:
        """Logger can log messages."""
        with caplog.at_level(logging.DEBUG, logger="ccbox"):
            logger = get_logger("integration_test")
            logger.debug("Test message")
            assert "Test message" in caplog.text

    def test_logger_respects_level(self, caplog: pytest.LogCaptureFixture) -> None:
        """Logger respects log level settings."""
        set_debug(False)
        with caplog.at_level(logging.WARNING, logger="ccbox"):
            logger = get_logger("level_test")
            logger.debug("Debug message")
            logger.warning("Warning message")
            assert "Debug message" not in caplog.text
            assert "Warning message" in caplog.text
