/**
 * Constants module for ccbox.
 *
 * All timeout values and shared constants are defined here (SSOT).
 */

// === Version ===
export const VERSION = "0.1.0"; // Package version

// === Docker Timeouts (milliseconds) ===
export const DOCKER_COMMAND_TIMEOUT = 30_000; // Quick docker commands (info, inspect, ps)
export const DOCKER_BUILD_TIMEOUT = 600_000; // 10 min for image builds
export const DOCKER_STARTUP_TIMEOUT = 30_000; // Waiting for Docker to start
export const DOCKER_CHECK_INTERVAL = 5_000; // Milliseconds between Docker status checks
export const PRUNE_TIMEOUT = 60_000; // Prune operations

// === Validation Constants ===
export const MAX_PROMPT_LENGTH = 5000; // Maximum characters for --prompt parameter
export const MAX_SYSTEM_PROMPT_LENGTH = 10000; // Maximum characters for --append-system-prompt
export const VALID_MODELS = new Set(["opus", "sonnet", "haiku"]); // Known Claude models

// === Prune Settings ===
export const PRUNE_CACHE_AGE = "168h"; // 7 days - keep recent build cache

// === Path Constants (Centralized) ===
// Host paths
export const CLAUDE_HOST_DIR = "~/.claude"; // Claude config on host (expandable)

// Container paths
export const CONTAINER_USER = "ccbox"; // Container username
export const CONTAINER_HOME = "/ccbox"; // Container base directory
export const CONTAINER_PROJECT_DIR = "/ccbox"; // Project base (actual: /ccbox/{dirName}, supports unicode via NFC normalization)
export const CONTAINER_CLAUDE_DIR = "/ccbox/.claude"; // Claude config in container (global)
export const CONTAINER_TMP_DIR = "/tmp"; // Tmpfs mount point

// Build paths - SSOT for all Dockerfile generation
export const BUILD_DIR = "/tmp/ccbox/build"; // Base directory for all builds

// Tmpfs configuration
export const TMPFS_SIZE = "64m"; // Default tmpfs size for /tmp
export const TMPFS_MODE = "1777"; // Tmpfs permissions (sticky bit)

// Resource limits
export const DEFAULT_PIDS_LIMIT = 2048; // Process limit per container (fork bomb protection)

// === Package Manager Priority (higher = run first) ===
export const PRIORITY = {
  HIGHEST: 10, // Lock files (most reliable)
  HIGH: 5,     // Standard package managers
  LOW: 3,      // Fallback package managers
} as const;
