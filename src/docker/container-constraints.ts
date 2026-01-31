/**
 * Container constraints configuration for ccbox.
 *
 * SSOT for all container resource limits, security settings, and mount configuration.
 * Extracted from docker-runtime.ts for reusability.
 */

import { env } from "node:process";
import { DEFAULT_PIDS_LIMIT } from "../constants.js";

/**
 * Container constraints (SSOT - used for both docker run and prompt generation).
 * Override via environment variables: CCBOX_PIDS_LIMIT, CCBOX_TMP_SIZE, etc.
 */
export const CONTAINER_CONSTRAINTS = {
  pidsLimit: parseInt(env.CCBOX_PIDS_LIMIT ?? "", 10) || DEFAULT_PIDS_LIMIT,
  capDrop: "ALL",
  ephemeralPaths: ["/tmp", "/var/tmp", "~/.cache"],
  tmpfs: {
    tmp: env.CCBOX_TMP_SIZE ?? "512m",
    varTmp: "256m",
    run: "64m",
    shm: env.CCBOX_SHM_SIZE ?? "256m",
  },
} as const;

/**
 * Default capability additions for non-privileged mode.
 */
export const DEFAULT_CAPABILITIES = [
  "SETUID",   // gosu: change user ID
  "SETGID",   // gosu: change group ID
  "CHOWN",    // entrypoint: change file ownership
  "SYS_ADMIN", // FUSE: mount filesystem in userspace
] as const;

/**
 * Terminal passthrough environment variables.
 */
export const TERMINAL_PASSTHROUGH_VARS = [
  "TERM_PROGRAM",
  "TERM_PROGRAM_VERSION",
  "ITERM_SESSION_ID",
  "ITERM_PROFILE",
  "KITTY_WINDOW_ID",
  "KITTY_PID",
  "WEZTERM_PANE",
  "WEZTERM_UNIX_SOCKET",
  "GHOSTTY_RESOURCES_DIR",
  "ALACRITTY_SOCKET",
  "ALACRITTY_LOG",
  "VSCODE_GIT_IPC_HANDLE",
  "VSCODE_INJECTION",
  "WT_SESSION",
  "WT_PROFILE_ID",
  "KONSOLE_VERSION",
  "KONSOLE_DBUS_SESSION",
  "TMUX",
  "TMUX_PANE",
  "STY",
] as const;
