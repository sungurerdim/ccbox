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
import signal
import subprocess
import sys
import threading
import time
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

from .constants import (
    DEFAULT_HEARTBEAT_TIMEOUT,
    PROCESS_TERM_TIMEOUT,
    SLEEP_CHECK_INTERVAL,
    THREAD_JOIN_TIMEOUT,
)
from .paths import get_docker_env

if TYPE_CHECKING:
    from collections.abc import Callable
    from subprocess import Popen
    from types import FrameType

# Re-export for backward compatibility
DEFAULT_HEARTBEAT_TIMEOUT_SECONDS = DEFAULT_HEARTBEAT_TIMEOUT
CHECK_INTERVAL_SECONDS = SLEEP_CHECK_INTERVAL


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
        except (RuntimeError, OSError, AttributeError) as e:
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
            self._monitor_thread.join(timeout=THREAD_JOIN_TIMEOUT)
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


def _terminate_process(proc: Popen[bytes], timeout: float = PROCESS_TERM_TIMEOUT) -> None:
    """Gracefully terminate a process, escalating to SIGKILL if needed.

    Args:
        proc: Process to terminate
        timeout: Seconds to wait before SIGKILL
    """
    if proc.poll() is not None:
        return  # Already dead

    # Try graceful termination first
    proc.terminate()
    try:
        proc.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        # Process didn't die, force kill
        with contextlib.suppress(OSError):
            proc.kill()
        with contextlib.suppress(OSError):
            proc.wait(timeout=1.0)


def _close_fd_safe(fd: int) -> None:
    """Safely close a file descriptor, ignoring errors."""
    if fd >= 0:
        with contextlib.suppress(OSError):
            os.close(fd)


def _run_with_pty(
    cmd: list[str],
    inhibitor: SleepInhibitor,
    stdin: int | None,
) -> int:
    """Run with PTY for Unix systems.

    Includes proper signal handling and resource cleanup for long sessions.
    """
    import pty
    import subprocess

    # Create PTY for output
    master_fd, slave_fd = pty.openpty()
    stop_event = threading.Event()
    proc: Popen[bytes] | None = None
    relay_thread: threading.Thread | None = None
    return_code = 1  # Default to error
    shutdown_initiated = False

    def signal_handler(signum: int, frame: FrameType | None) -> None:
        """Handle termination signals gracefully."""
        nonlocal shutdown_initiated
        if shutdown_initiated:
            return  # Prevent re-entry
        shutdown_initiated = True

        stop_event.set()
        if proc is not None:
            _terminate_process(proc)

    # Install signal handlers (Unix only)
    old_sigterm = signal.signal(signal.SIGTERM, signal_handler)
    old_sigint = signal.signal(signal.SIGINT, signal_handler)
    # Ignore SIGPIPE to prevent crashes on broken pipe
    old_sigpipe = signal.signal(signal.SIGPIPE, signal.SIG_IGN)

    try:
        proc = subprocess.Popen(
            cmd,
            stdin=stdin,
            stdout=slave_fd,
            stderr=slave_fd,
            close_fds=True,
            start_new_session=True,  # Process group for clean termination
        )

        # Close slave in parent immediately - child has it
        _close_fd_safe(slave_fd)
        slave_fd = -1

        # Start relay thread
        relay_thread = threading.Thread(
            target=_relay_pty_output,
            args=(master_fd, inhibitor._monitor, stop_event),
            name="ccbox-pty-relay",
            daemon=True,
        )
        relay_thread.start()

        # Wait for process with periodic checks
        while proc.poll() is None:
            try:
                return_code = proc.wait(timeout=1.0)
                break
            except subprocess.TimeoutExpired:
                # Check if shutdown was requested
                if shutdown_initiated:
                    _terminate_process(proc)
                    return_code = 128 + signal.SIGTERM
                    break
                continue

        if proc.returncode is not None:
            return_code = proc.returncode

    finally:
        # Cleanup in correct order
        stop_event.set()

        # Wait for relay thread with timeout
        if relay_thread is not None and relay_thread.is_alive():
            relay_thread.join(timeout=THREAD_JOIN_TIMEOUT)

        # Close file descriptors
        _close_fd_safe(slave_fd)
        _close_fd_safe(master_fd)

        # Restore signal handlers
        signal.signal(signal.SIGTERM, old_sigterm)
        signal.signal(signal.SIGINT, old_sigint)
        signal.signal(signal.SIGPIPE, old_sigpipe)

    return return_code


def _run_with_pipes(
    cmd: list[str],
    inhibitor: SleepInhibitor,
    stdin: int | None,
) -> int:
    """Run with pipes for Windows or fallback.

    Includes proper signal handling and resource cleanup.
    """
    import subprocess

    proc: Popen[bytes] | None = None
    return_code = 1
    shutdown_initiated = False

    def signal_handler(signum: int, frame: FrameType | None) -> None:
        """Handle termination signals gracefully."""
        nonlocal shutdown_initiated
        if shutdown_initiated:
            return
        shutdown_initiated = True
        if proc is not None:
            _terminate_process(proc)

    # Install signal handlers
    old_sigterm = signal.signal(signal.SIGTERM, signal_handler)
    old_sigint = signal.signal(signal.SIGINT, signal_handler)

    try:
        proc = subprocess.Popen(
            cmd,
            stdin=stdin,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            env=get_docker_env(),
        )

        if proc.stdout is None:
            raise RuntimeError("Process stdout not available")

        # Read output and relay with timeout checks
        while True:
            if shutdown_initiated:
                _terminate_process(proc)
                return_code = 128 + signal.SIGTERM
                break

            line = proc.stdout.readline()
            if not line:
                # EOF - process finished or pipe closed
                break

            inhibitor.pulse()
            try:
                sys.stdout.buffer.write(line)
                sys.stdout.buffer.flush()
            except OSError:
                # Broken pipe on output side
                break

        return_code = proc.wait()

    finally:
        if proc is not None and proc.stdout:
            with contextlib.suppress(OSError):
                proc.stdout.close()

        # Restore signal handlers
        signal.signal(signal.SIGTERM, old_sigterm)
        signal.signal(signal.SIGINT, old_sigint)

    return return_code


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
            f"\n[ccbox] No output activity for {minutes:.0f} minutes - releasing sleep inhibition",
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
