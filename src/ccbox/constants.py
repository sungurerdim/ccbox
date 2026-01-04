"""Constants module for ccbox.

All timeout values and shared constants are defined here (SSOT).
"""

from __future__ import annotations

# === Docker Timeouts (seconds) ===
DOCKER_COMMAND_TIMEOUT = 30  # Quick docker commands (info, inspect, ps)
DOCKER_BUILD_TIMEOUT = 600  # 10 min for image builds
DOCKER_STARTUP_TIMEOUT = 30  # Waiting for Docker to start
DOCKER_CHECK_INTERVAL = 5  # Seconds between Docker status checks
PRUNE_TIMEOUT = 60  # Prune operations

# === Sleep Control Timeouts (seconds) ===
DEFAULT_HEARTBEAT_TIMEOUT = 900  # 15 minutes - no activity timeout
SLEEP_CHECK_INTERVAL = 30.0  # Check interval for timeout detection
THREAD_JOIN_TIMEOUT = 5.0  # Thread join timeout for graceful shutdown
PROCESS_TERM_TIMEOUT = 3.0  # Process termination timeout before SIGKILL

# === Validation Constants ===
MAX_PROMPT_LENGTH = 5000  # Maximum characters for --prompt parameter
MAX_SYSTEM_PROMPT_LENGTH = 10000  # Maximum characters for --append-system-prompt
VALID_MODELS = frozenset({"opus", "sonnet", "haiku"})  # Known Claude models

# === Prune Settings ===
PRUNE_CACHE_AGE = "168h"  # 7 days - keep recent build cache

# === Path Constants (MNT-11: Centralized) ===
# Host paths
CLAUDE_HOST_DIR = "~/.claude"  # Claude config on host (expandable)

# Container paths
CONTAINER_USER = "node"  # Container username
CONTAINER_HOME = "/home/node"  # Container home directory
CONTAINER_PROJECT_DIR = "/home/node/project"  # Project mount point
CONTAINER_CLAUDE_DIR = "/home/node/.claude"  # Claude config in container
CONTAINER_TMP_DIR = "/tmp"  # Tmpfs mount point

# Build paths - SSOT for all Dockerfile generation
BUILD_DIR = "/tmp/ccbox/build"  # Base directory for all builds

# Tmpfs configuration
TMPFS_SIZE = "64m"  # Default tmpfs size for /tmp
TMPFS_MODE = "1777"  # Tmpfs permissions (sticky bit)

# Resource limits
DEFAULT_MEMORY_LIMIT = "4g"  # Default container memory limit
DEFAULT_MEMORY_SWAP = "4g"  # Same as memory (no swap)
DEFAULT_PIDS_LIMIT = 256  # Process limit per container
