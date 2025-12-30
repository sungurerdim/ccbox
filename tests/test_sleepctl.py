"""Tests for sleep inhibition control module."""

from __future__ import annotations

import sys
import threading
import time
from unittest.mock import MagicMock, patch

import pytest

from ccbox.sleepctl import (
    DEFAULT_HEARTBEAT_TIMEOUT_SECONDS,
    HeartbeatMonitor,
    SleepInhibitor,
    run_with_sleep_inhibition,
)


class TestHeartbeatMonitor:
    """Tests for HeartbeatMonitor class."""

    def test_initial_state_not_timed_out(self) -> None:
        """Monitor should not be timed out initially."""
        monitor = HeartbeatMonitor(timeout_seconds=10.0)
        assert not monitor.is_timed_out()

    def test_pulse_resets_timeout(self) -> None:
        """Pulse should reset the timeout counter."""
        monitor = HeartbeatMonitor(timeout_seconds=0.1)
        time.sleep(0.05)
        monitor.pulse()
        assert not monitor.is_timed_out()

    def test_is_timed_out_after_timeout(self) -> None:
        """Monitor should report timed out after timeout period."""
        monitor = HeartbeatMonitor(timeout_seconds=0.05)
        time.sleep(0.1)
        assert monitor.is_timed_out()

    def test_seconds_since_last_pulse(self) -> None:
        """Should accurately report time since last pulse."""
        monitor = HeartbeatMonitor(timeout_seconds=10.0)
        time.sleep(0.1)
        elapsed = monitor.seconds_since_last_pulse()
        assert 0.1 <= elapsed < 0.2

    def test_thread_safety(self) -> None:
        """Concurrent access should not cause race conditions."""
        monitor = HeartbeatMonitor(timeout_seconds=10.0)
        errors: list[Exception] = []

        def pulse_thread() -> None:
            try:
                for _ in range(100):
                    monitor.pulse()
                    _ = monitor.is_timed_out()
            except Exception as e:
                errors.append(e)

        threads = [threading.Thread(target=pulse_thread) for _ in range(5)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        assert len(errors) == 0, f"Thread safety errors: {errors}"

    def test_default_timeout_value(self) -> None:
        """Default timeout should be 900 seconds (15 minutes)."""
        monitor = HeartbeatMonitor()
        assert monitor.timeout_seconds == DEFAULT_HEARTBEAT_TIMEOUT_SECONDS
        assert monitor.timeout_seconds == 900.0


class TestSleepInhibitor:
    """Tests for SleepInhibitor class."""

    def test_context_manager_cleanup(self) -> None:
        """Context manager should properly clean up on exit."""
        with patch("ccbox.sleepctl.SleepInhibitor._start_inhibition"):
            with patch("ccbox.sleepctl.SleepInhibitor._stop_inhibition") as mock_stop:
                with SleepInhibitor(timeout_seconds=10.0):
                    pass
                mock_stop.assert_called()

    def test_context_manager_cleanup_on_exception(self) -> None:
        """Context manager should clean up even on exception."""
        with patch("ccbox.sleepctl.SleepInhibitor._start_inhibition"):
            with patch("ccbox.sleepctl.SleepInhibitor._stop_inhibition") as mock_stop:
                with pytest.raises(ValueError):
                    with SleepInhibitor(timeout_seconds=10.0):
                        raise ValueError("test error")
                mock_stop.assert_called()

    def test_pulse_updates_monitor(self) -> None:
        """Pulse should update the internal monitor."""
        with patch("ccbox.sleepctl.SleepInhibitor._start_inhibition"):
            with SleepInhibitor(timeout_seconds=10.0) as inhibitor:
                initial = inhibitor._monitor.seconds_since_last_pulse()
                time.sleep(0.05)
                inhibitor.pulse()
                after_pulse = inhibitor._monitor.seconds_since_last_pulse()
                assert after_pulse < initial

    def test_timeout_callback_called(self) -> None:
        """Timeout callback should be called when timeout occurs."""
        callback_called = threading.Event()

        def on_timeout() -> None:
            callback_called.set()

        with patch("ccbox.sleepctl.SleepInhibitor._start_inhibition"):
            with SleepInhibitor(
                timeout_seconds=0.05,
                on_timeout=on_timeout,
                check_interval=0.02,
            ):
                # Wait for timeout to trigger
                callback_called.wait(timeout=0.5)

        assert callback_called.is_set(), "Timeout callback was not called"

    def test_manual_release(self) -> None:
        """Manual release should stop inhibition."""
        with patch("ccbox.sleepctl.SleepInhibitor._start_inhibition"):
            inhibitor = SleepInhibitor(timeout_seconds=10.0)
            inhibitor.__enter__()
            assert not inhibitor._released
            inhibitor.release()
            assert inhibitor._released
            inhibitor.__exit__(None, None, None)

    def test_double_release_safe(self) -> None:
        """Double release should not cause errors."""
        with patch("ccbox.sleepctl.SleepInhibitor._start_inhibition"):
            inhibitor = SleepInhibitor(timeout_seconds=10.0)
            inhibitor.__enter__()
            inhibitor.release()
            inhibitor.release()  # Should not raise
            inhibitor.__exit__(None, None, None)

    def test_graceful_degradation_no_wakepy(self) -> None:
        """Should continue gracefully if wakepy is not available."""
        with patch.dict(sys.modules, {"wakepy": None}):
            with patch("builtins.__import__", side_effect=ImportError("No module")):
                # Should not raise, just log warning
                inhibitor = SleepInhibitor(timeout_seconds=10.0)
                inhibitor._start_inhibition()
                assert not inhibitor._active

    def test_is_active_property(self) -> None:
        """is_active should reflect inhibition state."""
        with patch("ccbox.sleepctl.SleepInhibitor._start_inhibition"):
            inhibitor = SleepInhibitor(timeout_seconds=10.0)
            assert not inhibitor.is_active
            inhibitor._active = True
            assert inhibitor.is_active
            inhibitor._released = True
            assert not inhibitor.is_active


class TestRunWithSleepInhibition:
    """Tests for run_with_sleep_inhibition function."""

    @pytest.mark.skipif(sys.platform == "win32", reason="PTY not available on Windows")
    def test_output_passthrough_unix(self) -> None:
        """Output should be passed through to stdout on Unix."""
        with patch("ccbox.sleepctl.SleepInhibitor") as mock_inhibitor:
            mock_instance = MagicMock()
            mock_inhibitor.return_value.__enter__ = MagicMock(return_value=mock_instance)
            mock_inhibitor.return_value.__exit__ = MagicMock(return_value=None)

            # Use echo command for simple test
            returncode = run_with_sleep_inhibition(
                ["echo", "test"],
                timeout_seconds=10.0,
            )
            assert returncode == 0

    def test_return_code_preserved(self) -> None:
        """Process return code should be preserved."""
        with patch("ccbox.sleepctl.SleepInhibitor") as mock_inhibitor:
            mock_instance = MagicMock()
            mock_inhibitor.return_value.__enter__ = MagicMock(return_value=mock_instance)
            mock_inhibitor.return_value.__exit__ = MagicMock(return_value=None)

            # Use false command which returns 1
            returncode = run_with_sleep_inhibition(
                ["false"],
                timeout_seconds=10.0,
            )
            assert returncode == 1

    def test_timeout_from_env(self) -> None:
        """Timeout should be read from environment variable."""
        with patch.dict("os.environ", {"CCBOX_SLEEP_TIMEOUT_SECONDS": "300"}):
            with patch("ccbox.sleepctl.SleepInhibitor") as mock_inhibitor:
                mock_instance = MagicMock()
                mock_inhibitor.return_value.__enter__ = MagicMock(return_value=mock_instance)
                mock_inhibitor.return_value.__exit__ = MagicMock(return_value=None)

                run_with_sleep_inhibition(["true"])

                # Check that SleepInhibitor was called with correct timeout
                call_kwargs = mock_inhibitor.call_args[1]
                assert call_kwargs["timeout_seconds"] == 300.0

    def test_explicit_timeout_overrides_env(self) -> None:
        """Explicit timeout parameter should override environment variable."""
        with patch.dict("os.environ", {"CCBOX_SLEEP_TIMEOUT_SECONDS": "300"}):
            with patch("ccbox.sleepctl.SleepInhibitor") as mock_inhibitor:
                mock_instance = MagicMock()
                mock_inhibitor.return_value.__enter__ = MagicMock(return_value=mock_instance)
                mock_inhibitor.return_value.__exit__ = MagicMock(return_value=None)

                run_with_sleep_inhibition(["true"], timeout_seconds=120.0)

                call_kwargs = mock_inhibitor.call_args[1]
                assert call_kwargs["timeout_seconds"] == 120.0


class TestEdgeCases:
    """Edge case tests for sleep inhibition."""

    def test_zero_timeout(self) -> None:
        """Zero timeout should immediately time out."""
        monitor = HeartbeatMonitor(timeout_seconds=0.0)
        # Even with 0 timeout, should time out after any delay
        time.sleep(0.001)
        assert monitor.is_timed_out()

    def test_very_small_timeout(self) -> None:
        """Very small timeout should work correctly."""
        monitor = HeartbeatMonitor(timeout_seconds=0.001)
        time.sleep(0.01)
        assert monitor.is_timed_out()

    def test_rapid_pulses(self) -> None:
        """Rapid pulses should not cause issues."""
        monitor = HeartbeatMonitor(timeout_seconds=1.0)
        for _ in range(1000):
            monitor.pulse()
        assert not monitor.is_timed_out()

    def test_negative_timeout_handled(self) -> None:
        """Negative timeout should effectively always time out."""
        monitor = HeartbeatMonitor(timeout_seconds=-1.0)
        assert monitor.is_timed_out()
