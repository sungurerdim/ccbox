/**
 * Constants module for ccbox.
 *
 * All timeout values and shared constants are defined here (SSOT).
 */

import { tmpdir } from "node:os";
import { join } from "node:path";

// === Version (SSOT: package.json) ===
import pkg from "../package.json" with { type: "json" };
export const VERSION: string = pkg.version;

// === CCBOX Naming (SSOT) ===
export const CCBOX_PREFIX = "ccbox";

// === Docker Timeouts (milliseconds) ===
export const DOCKER_COMMAND_TIMEOUT = 30_000; // Quick docker commands (info, inspect, ps)
export const DOCKER_BUILD_TIMEOUT = 600_000; // 10 min for image builds
export const DOCKER_STARTUP_TIMEOUT = 30_000; // Waiting for Docker to start
export const DOCKER_CHECK_INTERVAL = 5_000; // Milliseconds between Docker status checks
export const PRUNE_TIMEOUT = 60_000; // Prune operations

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

// === CCBOX Temp Paths (SSOT) ===
/** Get base temp directory for ccbox. */
export function getCcboxTempDir(): string {
  return join(tmpdir(), CCBOX_PREFIX);
}

/** Get temp directory for Docker builds. */
export function getCcboxTempBuild(subdir?: string): string {
  const base = join(getCcboxTempDir(), "build");
  return subdir ? join(base, subdir) : base;
}

/** Get temp directory for clipboard operations. */
export function getCcboxTempClipboard(): string {
  return join(getCcboxTempDir(), "clipboard");
}

/** Get temp directory for voice operations. */
export function getCcboxTempVoice(): string {
  return join(getCcboxTempDir(), "voice");
}

// === CCBOX Environment Variables (SSOT for names) ===
export const CCBOX_ENV = {
  // Container configuration
  UID: "CCBOX_UID",
  GID: "CCBOX_GID",
  DEBUG: "CCBOX_DEBUG",
  UNRESTRICTED: "CCBOX_UNRESTRICTED",
  MINIMAL_MOUNT: "CCBOX_MINIMAL_MOUNT",
  PERSISTENT_PATHS: "CCBOX_PERSISTENT_PATHS",
  ZERO_RESIDUE: "CCBOX_ZERO_RESIDUE",
  // Path mapping
  PATH_MAP: "CCBOX_PATH_MAP",
  DIR_MAP: "CCBOX_DIR_MAP",
  WIN_ORIGINAL_PATH: "CCBOX_WIN_ORIGINAL_PATH",
  // Resource limits (user-configurable via host env)
  PIDS_LIMIT: "CCBOX_PIDS_LIMIT",
  TMP_SIZE: "CCBOX_TMP_SIZE",
  SHM_SIZE: "CCBOX_SHM_SIZE",
  // Resource limits (new)
  MEMORY_LIMIT: "CCBOX_MEMORY_LIMIT",
  CPU_LIMIT: "CCBOX_CPU_LIMIT",
  // Network isolation
  NETWORK_POLICY: "CCBOX_NETWORK_POLICY",
} as const;

// === Default Resource Limits ===
export const DEFAULT_MEMORY_LIMIT = "4g";
export const DEFAULT_CPU_LIMIT = "2.0";

// === Filesystem Isolation ===
// NOTE: ccbox already has secure defaults:
//   - Only mounts: project dir + ~/.claude (required for Claude Code)
//   - Git identity passed via GIT_AUTHOR_NAME/EMAIL env vars
//   - ~/.ssh, ~/.aws, ~/.kube etc. are NEVER mounted
// No explicit sensitive path list needed - secure by design.
