"""Sleep inhibition control for ccbox.

Prevents system sleep during long-running ccbox sessions with
automatic release via activity-based heartbeat monitoring.

Platform support via wakepy:
- macOS: caffeinate
- Windows: SetThreadExecutionState
- Linux/GNOME: org.gnome.SessionManager
- Linux/KDE: org.freedesktop.PowerManagement
"""

from __future__ import annotations

import contextlib
import os
import select
import sys
import threading
import time
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from collections.abc import Callable

# Default timeout: 15 minutes
DEFAULT_HEARTBEAT_TIMEOUT_SECONDS = 900

# Check interval for timeout detection
CHECK_INTERVAL_SECONDS = 30.0


@dataclass
class HeartbeatMonitor:
    """Thread-safe activity monitor with timeout detection.

    Tracks last activity timestamp and provides timeout checking.
    """

    timeout_seconds: float = DEFAULT_HEARTBEAT_TIMEOUT_SECONDS
    _last_activity: float = field(default_factory=time.monotonic, init=False)
    _lock: threading.Lock = field(default_factory=threading.Lock, init=False)

    def pulse(self) -> None:
        """Record activity heartbeat."""
        with self._lock:
            self._last_activity = time.monotonic()

    def is_timed_out(self) -> bool:
        """Check if timeout has been exceeded since last pulse."""
        with self._lock:
            return (time.monotonic() - self._last_activity) > self.timeout_seconds

    def seconds_since_last_pulse(self) -> float:
        """Return seconds since last activity."""
        with self._lock:
            return time.monotonic() - self._last_activity


class SleepInhibitor:
    """Context manager for sleep inhibition with heartbeat monitoring.

    Usage:
        with SleepInhibitor(timeout_seconds=600) as inhibitor:
            # Run long-running process
            inhibitor.pulse()  # Call on activity

    The inhibitor automatically releases when:
    1. Context exits normally
    2. Context exits via exception
    3. Heartbeat timeout is exceeded (background thread releases)
    """

    def __init__(
        self,
        timeout_seconds: float = DEFAULT_HEARTBEAT_TIMEOUT_SECONDS,
        on_timeout: Callable[[], None] | None = None,
        check_interval: float = CHECK_INTERVAL_SECONDS,
    ) -> None:
        self.timeout_seconds = timeout_seconds
        self.on_timeout = on_timeout
        self.check_interval = check_interval

        self._monitor = HeartbeatMonitor(timeout_seconds=timeout_seconds)
        self._wakepy_mode: Any = None
        self._monitor_thread: threading.Thread | None = None
        self._stop_event = threading.Event()
        self._released = False
        self._active = False

    def __enter__(self) -> SleepInhibitor:
        """Enter sleep inhibition mode."""
        self._start_inhibition()
        self._start_monitor_thread()
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc_val: BaseException | None,
        exc_tb: Any,
    ) -> None:
        """Exit sleep inhibition mode."""
        self._stop_monitor_thread()
        self._stop_inhibition()

    def pulse(self) -> None:
        """Record activity heartbeat."""
        self._monitor.pulse()

    def release(self) -> None:
        """Manually release sleep inhibition."""
        self._stop_inhibition()

    @property
    def is_active(self) -> bool:
        """Check if sleep inhibition is currently active."""
        return self._active and not self._released

    def _start_inhibition(self) -> None:
        """Activate sleep inhibition via wakepy."""
        try:
            from wakepy import keep

            self._wakepy_mode = keep.running().__enter__()
            self._active = True
        except ImportError:
            self._log_warning("wakepy not installed - sleep inhibition disabled")
        except Exception as e:
            self._log_warning(f"Failed to inhibit sleep: {e}")

    def _stop_inhibition(self) -> None:
        """Deactivate sleep inhibition."""
        if self._released:
            return
        self._released = True
        self._active = False

        if self._wakepy_mode is not None:
            with contextlib.suppress(Exception):
                self._wakepy_mode.__exit__(None, None, None)
            self._wakepy_mode = None

    def _start_monitor_thread(self) -> None:
        """Start background thread to check for timeout."""
        self._stop_event.clear()
        self._monitor_thread = threading.Thread(
            target=self._monitor_loop,
            name="ccbox-sleep-monitor",
            daemon=True,
        )
        self._monitor_thread.start()

    def _stop_monitor_thread(self) -> None:
        """Stop the background monitor thread."""
        self._stop_event.set()
        if self._monitor_thread is not None:
            self._monitor_thread.join(timeout=2.0)
            self._monitor_thread = None

    def _monitor_loop(self) -> None:
        """Background loop that checks for heartbeat timeout."""
        while not self._stop_event.wait(self.check_interval):
            if self._monitor.is_timed_out():
                # Timeout reached - release inhibition
                self._stop_inhibition()
                if self.on_timeout:
                    with contextlib.suppress(Exception):
                        self.on_timeout()
                break

    def _log_warning(self, message: str) -> None:
        """Log warning message."""
        # Use stderr to avoid interfering with stdout relay
        print(f"[ccbox] Warning: {message}", file=sys.stderr)


def _relay_pty_output(
    master_fd: int,
    monitor: HeartbeatMonitor,
    stop_event: threading.Event,
) -> None:
    """Relay PTY output to real output while pulsing heartbeat.

    Args:
        master_fd: PTY master file descriptor
        monitor: HeartbeatMonitor to pulse on activity
        stop_event: Event to signal stop
    """
    while not stop_event.is_set():
        # Use select with timeout for interruptibility
        try:
            ready, _, _ = select.select([master_fd], [], [], 0.5)
        except (ValueError, OSError):
            # FD closed or invalid
            break

        if ready:
            try:
                data = os.read(master_fd, 4096)
                if not data:
                    break  # EOF
                monitor.pulse()
                sys.stdout.buffer.write(data)
                sys.stdout.buffer.flush()
            except OSError:
                break  # FD closed


def _run_with_pty(
    cmd: list[str],
    inhibitor: SleepInhibitor,
    stdin: int | None,
) -> int:
    """Run with PTY for Unix systems."""
    import pty
    import subprocess

    # Create PTY for output
    master_fd, slave_fd = pty.openpty()

    stop_event = threading.Event()

    try:
        proc = subprocess.Popen(
            cmd,
            stdin=stdin,
            stdout=slave_fd,
            stderr=slave_fd,
            close_fds=True,
        )

        # Close slave in parent - child has it
        os.close(slave_fd)
        slave_fd = -1

        # Start relay thread
        relay_thread = threading.Thread(
            target=_relay_pty_output,
            args=(master_fd, inhibitor._monitor, stop_event),
            daemon=True,
        )
        relay_thread.start()

        # Wait for process
        return_code = proc.wait()

        # Signal relay to stop and wait
        stop_event.set()
        relay_thread.join(timeout=1.0)

        return return_code

    finally:
        stop_event.set()
        if slave_fd >= 0:
            os.close(slave_fd)
        with contextlib.suppress(OSError):
            os.close(master_fd)


def _run_with_pipes(
    cmd: list[str],
    inhibitor: SleepInhibitor,
    stdin: int | None,
) -> int:
    """Run with pipes for Windows or fallback."""
    import subprocess

    proc = subprocess.Popen(
        cmd,
        stdin=stdin,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )

    try:
        assert proc.stdout is not None
        # Read output and relay
        for line in iter(proc.stdout.readline, b""):
            inhibitor.pulse()
            sys.stdout.buffer.write(line)
            sys.stdout.buffer.flush()

        return proc.wait()
    finally:
        if proc.stdout:
            proc.stdout.close()


def run_with_sleep_inhibition(
    cmd: list[str],
    stdin: int | None = None,
    timeout_seconds: float | None = None,
) -> int:
    """Run subprocess with sleep inhibition and heartbeat monitoring.

    This is the main integration function that replaces subprocess.run()
    for container execution.

    Args:
        cmd: Command to run
        stdin: stdin file descriptor (or None for default)
        timeout_seconds: Heartbeat timeout in seconds (default from env or 600)

    Returns:
        Process return code
    """
    # Get timeout from env or use default
    if timeout_seconds is None:
        timeout_seconds = float(
            os.environ.get(
                "CCBOX_SLEEP_TIMEOUT_SECONDS",
                DEFAULT_HEARTBEAT_TIMEOUT_SECONDS,
            )
        )

    # Platform detection
    is_windows = sys.platform == "win32"

    def on_timeout() -> None:
        minutes = timeout_seconds / 60
        print(
            f"\n[ccbox] No output activity for {minutes:.0f} minutes - "
            "releasing sleep inhibition",
            file=sys.stderr,
        )

    with SleepInhibitor(
        timeout_seconds=timeout_seconds,
        on_timeout=on_timeout,
    ) as inhibitor:
        if is_windows:
            return _run_with_pipes(cmd, inhibitor, stdin)
        else:
            return _run_with_pty(cmd, inhibitor, stdin)
