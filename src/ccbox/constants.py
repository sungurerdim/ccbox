"""Constants module for ccbox.

All timeout values and shared constants are defined here (SSOT).
"""

from __future__ import annotations

# Docker command timeouts (seconds)
DOCKER_COMMAND_TIMEOUT = 30  # Quick docker commands (info, inspect, ps)
DOCKER_BUILD_TIMEOUT = 600  # 10 min for image builds
DOCKER_STARTUP_TIMEOUT = 30  # Waiting for Docker to start
DOCKER_CHECK_INTERVAL = 5  # Seconds between Docker status checks
PRUNE_TIMEOUT = 60  # Prune operations

# Sleep control timeouts (seconds)
DEFAULT_HEARTBEAT_TIMEOUT = 900  # 15 minutes - no activity timeout
SLEEP_CHECK_INTERVAL = 30.0  # Check interval for timeout detection
THREAD_JOIN_TIMEOUT = 5.0  # Thread join timeout for graceful shutdown
PROCESS_TERM_TIMEOUT = 3.0  # Process termination timeout before SIGKILL

# Validation constants
MAX_PROMPT_LENGTH = 5000  # Maximum characters for --prompt parameter
MAX_SYSTEM_PROMPT_LENGTH = 10000  # Maximum characters for --append-system-prompt
VALID_MODELS = frozenset({"opus", "sonnet", "haiku"})  # Known Claude models

# Prune settings
PRUNE_CACHE_AGE = "168h"  # 7 days - keep recent build cache
