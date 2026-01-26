/**
 * Docker file generation for ccbox.
 *
 * Main module that re-exports from specialized modules and provides
 * entrypoint generation, FUSE source, and build file utilities.
 *
 * Module structure:
 *   - dockerfile-gen.ts: Dockerfile templates for all stacks
 *   - docker-runtime.ts: Container execution and runtime utilities
 *   - generator.ts (this file): Build files, entrypoint, FUSE source
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { LanguageStack } from "./config.js";
import type { DepsInfo, DepsMode } from "./deps.js";
import { getInstallCommands } from "./deps.js";
import { FUSE_BINARY_AMD64, FUSE_BINARY_ARM64 } from "./fuse-binaries.js";

// Import and re-export from dockerfile-gen.ts
import { generateDockerfile, DOCKERFILE_GENERATORS } from "./dockerfile-gen.js";
export { generateDockerfile, DOCKERFILE_GENERATORS };

// Re-export from docker-runtime.ts
export {
  buildClaudeArgs,
  buildContainerAwarenessPrompt,
  getDockerRunCmd,
  getHostTimezone,
  getHostUserIds,
  getTerminalSize,
  transformSlashCommand,
} from "./docker-runtime.js";

// ES module equivalent of __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Generate entrypoint script with comprehensive debugging support. */
export function generateEntrypoint(): string {
  // Try to read from package resources first
  const scriptPath = join(__dirname, "scripts", "entrypoint.sh");
  try {
    if (existsSync(scriptPath)) {
      return readFileSync(scriptPath, "utf-8");
    }
  } catch {
    // Fall through to embedded version
  }

  // Fallback to embedded script
  return `#!/bin/bash

# Debug logging function (stdout for diagnostic, stderr for errors only)
_log() {
    if [[ -n "$CCBOX_DEBUG" ]]; then
        echo "[ccbox] $*"
    fi
}

_log_verbose() {
    if [[ "$CCBOX_DEBUG" == "2" ]]; then
        echo "[ccbox:debug] $*"
    fi
}

_die() {
    echo "[ccbox:ERROR] $*" >&2
    exit 1
}

# Error trap - show what failed
trap 'echo "[ccbox:ERROR] Command failed at line $LINENO: $BASH_COMMAND" >&2' ERR

set -e

_log "Entrypoint started (PID: $$)"
_log_verbose "Working directory: $PWD"
_log_verbose "Arguments: $*"

# Log current user info
_log "Running as UID: $(id -u), GID: $(id -g)"
_log_verbose "User: $(id -un 2>/dev/null || echo 'unknown')"

# ══════════════════════════════════════════════════════════════════════════════
# Dynamic User Setup
# Ensure container user matches host UID/GID for proper file ownership
# This allows all tools (npm, pip, git, etc.) to work seamlessly
# ══════════════════════════════════════════════════════════════════════════════
if [[ "$(id -u)" == "0" && -n "$CCBOX_UID" && -n "$CCBOX_GID" ]]; then
    _log_verbose "Setting up dynamic user (UID:$CCBOX_UID GID:$CCBOX_GID)"

    # Update ccbox group GID if different from 1000
    if [[ "$CCBOX_GID" != "1000" ]]; then
        # Check if target GID already exists
        if getent group "$CCBOX_GID" >/dev/null 2>&1; then
            _log_verbose "GID $CCBOX_GID already exists, removing"
            groupdel "$(getent group "$CCBOX_GID" | cut -d: -f1)" 2>/dev/null || true
        fi
        groupmod -g "$CCBOX_GID" ccbox 2>/dev/null || true
        _log_verbose "Changed ccbox group GID to $CCBOX_GID"
    fi

    # Update ccbox user UID if different from 1000
    if [[ "$CCBOX_UID" != "1000" ]]; then
        # Check if target UID already exists
        if getent passwd "$CCBOX_UID" >/dev/null 2>&1; then
            _log_verbose "UID $CCBOX_UID already exists, removing"
            userdel "$(getent passwd "$CCBOX_UID" | cut -d: -f1)" 2>/dev/null || true
        fi
        usermod -u "$CCBOX_UID" ccbox 2>/dev/null || true
        _log_verbose "Changed ccbox user UID to $CCBOX_UID"
    fi

    # Fix ownership of ccbox home directory and cache directories
    # Only fix directories that exist to avoid unnecessary operations
    for dir in /ccbox /ccbox/.cache /ccbox/.npm /ccbox/.local /ccbox/.config; do
        if [[ -d "$dir" ]]; then
            chown "$CCBOX_UID:$CCBOX_GID" "$dir" 2>/dev/null || true
        fi
    done

    # Create tmp directory in cache (for tools that need temp space)
    mkdir -p /ccbox/.cache/tmp 2>/dev/null || true
    chown "$CCBOX_UID:$CCBOX_GID" /ccbox/.cache/tmp 2>/dev/null || true

    # Fix .claude directory ownership (projects, sessions, etc. created by previous runs)
    # Uses CLAUDE_CONFIG_DIR env var for dynamic path resolution
    _claude_dir="\${CLAUDE_CONFIG_DIR:-/ccbox/.claude}"
    if [[ -d "$_claude_dir" ]]; then
        # Fix projects directory and subdirectories (session files)
        if [[ -d "$_claude_dir/projects" ]]; then
            find "$_claude_dir/projects" -user root -exec chown "$CCBOX_UID:$CCBOX_GID" {} + 2>/dev/null || true
        fi
        # Fix other runtime directories that Claude Code writes to
        for subdir in todos tasks plans statsig session-env debug; do
            if [[ -d "$_claude_dir/$subdir" ]]; then
                find "$_claude_dir/$subdir" -user root -exec chown "$CCBOX_UID:$CCBOX_GID" {} + 2>/dev/null || true
            fi
        done
    fi
fi

# ══════════════════════════════════════════════════════════════════════════════
# Cross-platform path compatibility via FUSE (in-place overlay)
# FUSE provides kernel-level path transformation that works with ALL apps
# including Bun/Zig which bypass glibc (and thus LD_PRELOAD)
#
# In-place overlay: FUSE mounts directly over existing directories without
# creating additional directories on host. Uses bind mount trick:
# 1. Bind mount original dir to temp location (container-only)
# 2. FUSE mounts from temp back to original path
# 3. Changes go through FUSE -> bind mount -> host (transparent)
# ══════════════════════════════════════════════════════════════════════════════

# Helper function for in-place FUSE overlay on a directory
_setup_fuse_overlay() {
    local mount_point="$1"
    local label="$2"

    if [[ ! -d "$mount_point" ]]; then
        _log_verbose "FUSE skip ($label): dir not found: $mount_point"
        return 1
    fi

    # Container-only bind mount source directory
    # Use /run (tmpfs, always available, not cleaned by tmp cleaners)
    # Bind mount doesn't copy data - just creates alternate path to same inode
    local safe_name
    safe_name=$(echo "$mount_point" | tr '/' '-' | sed 's/^-//')
    local fuse_base="/run/ccbox-fuse"
    mkdir -p "$fuse_base" 2>/dev/null || true
    local tmp_source="$fuse_base/$safe_name"
    mkdir -p "$tmp_source"

    # Bind mount original to temp (preserves bidirectional host connection)
    if ! mount --bind "$mount_point" "$tmp_source"; then
        _log "Warning: bind mount failed for $label"
        rmdir "$tmp_source" 2>/dev/null
        return 1
    fi

    # Build FUSE options
    local fuse_opts="source=$tmp_source,allow_other"
    [[ -n "$CCBOX_UID" ]] && fuse_opts="$fuse_opts,uid=$CCBOX_UID"
    [[ -n "$CCBOX_GID" ]] && fuse_opts="$fuse_opts,gid=$CCBOX_GID"
    [[ -n "$CCBOX_PATH_MAP" ]] && fuse_opts="$fuse_opts,pathmap=$CCBOX_PATH_MAP"

    _log_verbose "FUSE ($label): $tmp_source -> $mount_point (in-place overlay)"

    # Mount FUSE over original path (in-place overlay)
    nohup /usr/local/bin/ccbox-fuse -f -o "$fuse_opts" "$mount_point" </dev/null >/dev/null 2>&1 &
    local fuse_pid=$!
    sleep 0.5  # Wait for FUSE to initialize

    # Verify mount
    if mountpoint -q "$mount_point" 2>/dev/null; then
        _log "FUSE mounted: $label (in-place)"
        return 0
    else
        _log "Warning: FUSE mount failed for $label"
        kill $fuse_pid 2>/dev/null || true
        umount "$tmp_source" 2>/dev/null || true
        rmdir "$tmp_source" 2>/dev/null
        return 1
    fi
}

if [[ -n "$CCBOX_PATH_MAP" && -x "/usr/local/bin/ccbox-fuse" ]]; then
    _log "Setting up FUSE for path translation (in-place overlay)..."

    # Mount global .claude with FUSE overlay
    if [[ -d "/ccbox/.claude" ]]; then
        if _setup_fuse_overlay "/ccbox/.claude" "global"; then
            export CCBOX_FUSE_GLOBAL=1
        fi
    fi

    # Mount project .claude with FUSE overlay (if exists)
    if [[ -d "$PWD/.claude" ]]; then
        if _setup_fuse_overlay "$PWD/.claude" "project"; then
            export CCBOX_FUSE_PROJECT=1
        fi
    fi

    _log "Path mapping: $CCBOX_PATH_MAP"

    # Clean orphaned plugin markers in global .claude
    if [[ -d "/ccbox/.claude/plugins/cache" ]]; then
        _orphan_count=$(find "/ccbox/.claude/plugins/cache" -name ".orphaned_at" -type f 2>/dev/null | wc -l)
        if [[ "$_orphan_count" -gt 0 ]]; then
            find "/ccbox/.claude/plugins/cache" -name ".orphaned_at" -type f -exec rm -f {} + 2>/dev/null || true
            _log "Cleaned $_orphan_count orphaned plugin marker(s)"
        fi
    fi
else
    # No path mapping needed or FUSE not available
    if [[ -d "$PWD/.claude" ]]; then
        _log "Project .claude detected (direct mount, no path transform)"
    fi
fi

# ══════════════════════════════════════════════════════════════════════════════
# WSL Session Compatibility Bridge
# WSL paths (/mnt/d/...) encode differently than Docker paths (/d/...)
# Create symlinks between encodings so sessions are visible across environments
# ══════════════════════════════════════════════════════════════════════════════
if [[ -n "$CCBOX_WSL_ORIGINAL_PATH" && -d "/ccbox/.claude" ]]; then
    _log_verbose "Setting up WSL session bridge..."

    # Calculate encodings: replace / and . with -
    _wsl_encoded=$(echo "$CCBOX_WSL_ORIGINAL_PATH" | tr '/.' '--' | sed 's/^-//')
    _target_encoded=$(echo "$PWD" | tr '/.' '--' | sed 's/^-//')

    if [[ "$_wsl_encoded" != "$_target_encoded" ]]; then
        _log_verbose "WSL encoding: $_wsl_encoded"
        _log_verbose "Target encoding: $_target_encoded"

        # Create symlinks in all path-encoded directories
        for _subdir in projects file-history todos shell-snapshots; do
            _base_dir="/ccbox/.claude/$_subdir"
            if [[ -d "$_base_dir" ]]; then
                # If WSL-encoded exists but target doesn't, link target -> WSL
                if [[ -d "$_base_dir/$_wsl_encoded" && ! -e "$_base_dir/$_target_encoded" ]]; then
                    ln -s "$_wsl_encoded" "$_base_dir/$_target_encoded" 2>/dev/null || true
                    _log "WSL bridge: $_subdir/$_target_encoded -> $_wsl_encoded"
                # If target exists but WSL-encoded doesn't, link WSL -> target
                elif [[ -d "$_base_dir/$_target_encoded" && ! -e "$_base_dir/$_wsl_encoded" ]]; then
                    ln -s "$_target_encoded" "$_base_dir/$_wsl_encoded" 2>/dev/null || true
                    _log "WSL bridge: $_subdir/$_wsl_encoded -> $_target_encoded"
                fi
            fi
        done
    fi
fi

# Git performance optimizations (I/O reduction)
git config --global core.fileMode false 2>/dev/null || true
git config --global --add safe.directory '*' 2>/dev/null || true
git config --global core.preloadindex true 2>/dev/null || true
git config --global core.fscache true 2>/dev/null || true
git config --global core.untrackedcache true 2>/dev/null || true
git config --global core.commitgraph true 2>/dev/null || true
git config --global core.splitIndex true 2>/dev/null || true
git config --global fetch.writeCommitGraph true 2>/dev/null || true
git config --global gc.auto 0 2>/dev/null || true
git config --global credential.helper 'cache --timeout=86400' 2>/dev/null || true
git config --global pack.threads 0 2>/dev/null || true
git config --global index.threads 0 2>/dev/null || true

# Create temp directory in cache (exec allowed, ephemeral tmpfs)
mkdir -p /ccbox/.cache/tmp 2>/dev/null || true
mkdir -p /ccbox/.cache/tmp/.gradle 2>/dev/null || true  # Gradle home
_log_verbose "TMPDIR: /ccbox/.cache/tmp"

# Verify claude command exists
if ! command -v claude &>/dev/null; then
    _die "claude command not found in PATH"
fi

_log_verbose "Claude location: $(which claude)"
_log_verbose "Claude version: $(claude --version 2>/dev/null || echo 'N/A')"

_log "Starting Claude Code..."

# Priority wrapper: nice (CPU) + ionice (I/O) for system responsiveness
# These are soft limits - only activate when competing for resources
# Skip if CCBOX_UNRESTRICTED is set (--unrestricted flag)
if [[ -z "$CCBOX_UNRESTRICTED" ]]; then
    PRIORITY_CMD="nice -n 10 ionice -c2 -n7"
    _log_verbose "Resource limits active (nice -n 10, ionice -c2 -n7)"
else
    PRIORITY_CMD=""
    _log_verbose "Unrestricted mode: no resource limits"
fi

# Build execution command with user switching if needed
EXEC_PREFIX=""
if [[ "$(id -u)" == "0" && -n "$CCBOX_UID" && -n "$CCBOX_GID" ]]; then
    # Running as root - switch to ccbox user via gosu
    # Use user name instead of UID:GID so HOME is properly set from /etc/passwd
    # ccbox user's UID/GID was dynamically updated above to match host
    _log_verbose "Switching to ccbox user (UID:$CCBOX_UID GID:$CCBOX_GID)"
    export HOME=/ccbox
    EXEC_PREFIX="gosu ccbox"
fi

# Run Claude Code
if [[ -t 1 ]]; then
    printf '\\e[?2026h' 2>/dev/null || true
    exec $EXEC_PREFIX $PRIORITY_CMD claude --dangerously-skip-permissions "$@"
else
    exec $EXEC_PREFIX stdbuf -oL -eL $PRIORITY_CMD claude --dangerously-skip-permissions "$@"
fi
`;
}


/**
 * Generate ccbox-fuse.c content for FUSE filesystem.
 * This is embedded for compiled binary compatibility.
 * FUSE provides kernel-level path transformation that works with direct syscalls (Bun/Zig).
 */
function generateCcboxFuseC(): string {
  return `/**
 * ccbox-fuse: FUSE filesystem for transparent cross-platform path mapping
 * Provides kernel-level path transformation that works with io_uring and direct syscalls
 * This is REQUIRED for Bun-based Claude Code which bypasses glibc
 * Compile: gcc -Wall -O2 -o ccbox-fuse ccbox-fuse.c $(pkg-config fuse3 --cflags --libs)
 */
#define FUSE_USE_VERSION 31
#include <fuse3/fuse.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <fcntl.h>
#include <sys/stat.h>
#include <sys/statvfs.h>
#include <dirent.h>
#include <errno.h>
#include <ctype.h>
#include <limits.h>
#include <stddef.h>

#define MAX_MAPPINGS 32
#define MAX_PATH_LEN 4096

typedef struct {
    char *from, *to;
    size_t from_len, to_len;
    char drive;
    int is_unc, is_wsl;
} PathMapping;

static char *source_dir = NULL;
static PathMapping mappings[MAX_MAPPINGS];
static int mapping_count = 0;

static char *normalize_path(const char *path) {
    if (!path) return NULL;
    char *norm = strdup(path);
    if (!norm) return NULL;
    for (char *p = norm; *p; p++) if (*p == '\\\\') *p = '/';
    if (norm[0] && norm[1] == ':') norm[0] = tolower(norm[0]);
    size_t len = strlen(norm);
    while (len > 1 && norm[len-1] == '/') norm[--len] = '\\0';
    return norm;
}

static int needs_transform(const char *path) {
    if (!path || mapping_count == 0) return 0;
    const char *dot = strrchr(path, '.');
    return dot && strcasecmp(dot, ".json") == 0;
}

static void get_source_path(char *dest, const char *path, size_t destsize) {
    snprintf(dest, destsize, "%s%s", source_dir, path);
}

/* Transform Windows paths in JSON content to Linux paths */
/* Returns new buffer that caller must free, or NULL if no transform needed */
static char *transform_to_container_alloc(const char *buf, size_t len, size_t *newlen) {
    if (!buf || len == 0 || mapping_count == 0) { *newlen = len; return NULL; }
    char *work = malloc(len * 2 + 1);
    if (!work) { *newlen = len; return NULL; }
    size_t wi = 0, i = 0;
    int any_transform = 0;
    while (i < len && buf[i]) {
        int matched = 0;
        /* Check for drive letter pattern like C: or D: */
        if (i + 2 < len && isalpha(buf[i]) && buf[i+1] == ':') {
            char drive = tolower(buf[i]);
            for (int m = 0; m < mapping_count && !matched; m++) {
                if (mappings[m].drive == drive) {
                    /* Extract the full path after drive letter for comparison */
                    char pathbuf[MAX_PATH_LEN];
                    size_t pi = 0, ti = i + 2;
                    while (ti < len && buf[ti] != '"' && buf[ti] != ',' && buf[ti] != '}' && pi < MAX_PATH_LEN - 1) {
                        if (buf[ti] == '\\\\') { pathbuf[pi++] = '/'; ti++; if (ti < len && buf[ti] == '\\\\') ti++; }
                        else pathbuf[pi++] = buf[ti++];
                    }
                    pathbuf[pi] = '\\0';

                    /* Check if path starts with the mapped from-path (after drive letter) */
                    /* from is like "c:/Users/Sungur/.claude", so skip first 2 chars (c:) */
                    const char *from_path = mappings[m].from + 2;
                    size_t from_path_len = mappings[m].from_len - 2;

                    if (strncmp(pathbuf, from_path, from_path_len) == 0) {
                        /* Full prefix match - replace with to path */
                        memcpy(work + wi, mappings[m].to, mappings[m].to_len);
                        wi += mappings[m].to_len;
                        /* Copy remainder after the matched prefix */
                        const char *remainder = pathbuf + from_path_len;
                        size_t rem_len = strlen(remainder);
                        memcpy(work + wi, remainder, rem_len);
                        wi += rem_len;
                        i = ti;
                        matched = 1;
                        any_transform = 1;
                    }
                }
            }
        }
        if (!matched) work[wi++] = buf[i++];
    }
    work[wi] = '\\0';
    if (!any_transform) { free(work); *newlen = len; return NULL; }
    *newlen = wi;
    return work;
}

/* Transform Linux paths in JSON content to Windows paths (reverse transform for writes) */
/* Converts /ccbox/... paths back to C:\\\\Users\\\\... format for host filesystem */
static char *transform_to_host_alloc(const char *buf, size_t len, size_t *newlen) {
    if (!buf || len == 0 || mapping_count == 0) { *newlen = len; return NULL; }
    /* Allocate extra space for backslash escaping (worst case: each / becomes \\\\) */
    char *work = malloc(len * 4 + 1);
    if (!work) { *newlen = len; return NULL; }
    size_t wi = 0, i = 0;
    int any_transform = 0;

    while (i < len) {
        int matched = 0;
        /* Check for Linux path that matches a mapping's "to" path */
        for (int m = 0; m < mapping_count && !matched; m++) {
            size_t to_len = mappings[m].to_len;
            if (i + to_len <= len && strncmp(buf + i, mappings[m].to, to_len) == 0) {
                /* Check it's a proper path boundary */
                char next = (i + to_len < len) ? buf[i + to_len] : '\\0';
                if (next == '\\0' || next == '/' || next == '"' || next == ',' || next == '}' || next == ']') {
                    /* Write the Windows path with JSON-escaped backslashes */
                    const char *from = mappings[m].from;
                    for (size_t j = 0; j < mappings[m].from_len; j++) {
                        if (from[j] == '/') {
                            work[wi++] = '\\\\';
                            work[wi++] = '\\\\';
                        } else {
                            work[wi++] = from[j];
                        }
                    }
                    i += to_len;
                    matched = 1;
                    any_transform = 1;

                    /* Copy remainder path with JSON-escaped backslashes */
                    while (i < len && buf[i] != '"' && buf[i] != ',' && buf[i] != '}' && buf[i] != ']' && !isspace(buf[i])) {
                        if (buf[i] == '/') {
                            work[wi++] = '\\\\';
                            work[wi++] = '\\\\';
                        } else {
                            work[wi++] = buf[i];
                        }
                        i++;
                    }
                }
            }
        }
        if (!matched) work[wi++] = buf[i++];
    }
    work[wi] = '\\0';
    if (!any_transform) { free(work); *newlen = len; return NULL; }
    *newlen = wi;
    return work;
}

static int ccbox_getattr(const char *path, struct stat *stbuf, struct fuse_file_info *fi) {
    (void)fi;
    char fpath[MAX_PATH_LEN];
    get_source_path(fpath, path, sizeof(fpath));
    return lstat(fpath, stbuf) == -1 ? -errno : 0;
}

static int ccbox_readdir(const char *path, void *buf, fuse_fill_dir_t filler, off_t offset, struct fuse_file_info *fi, enum fuse_readdir_flags flags) {
    (void)offset; (void)fi; (void)flags;
    char fpath[MAX_PATH_LEN];
    get_source_path(fpath, path, sizeof(fpath));
    DIR *dp = opendir(fpath);
    if (!dp) return -errno;
    struct dirent *de;
    while ((de = readdir(dp))) {
        struct stat st = {0};
        st.st_ino = de->d_ino;
        st.st_mode = de->d_type << 12;
        if (filler(buf, de->d_name, &st, 0, 0)) break;
    }
    closedir(dp);
    return 0;
}

static int ccbox_open(const char *path, struct fuse_file_info *fi) {
    char fpath[MAX_PATH_LEN];
    get_source_path(fpath, path, sizeof(fpath));
    int fd = open(fpath, fi->flags);
    if (fd == -1) return -errno;
    fi->fh = fd;
    return 0;
}

static int ccbox_read(const char *path, char *buf, size_t size, off_t offset, struct fuse_file_info *fi) {
    int fd = fi->fh;
    if (needs_transform(path)) {
        struct stat st;
        if (fstat(fd, &st) == -1) return -errno;
        size_t filesize = st.st_size;
        if (filesize == 0) return 0;
        char *filebuf = malloc(filesize + 1);
        if (!filebuf) return -ENOMEM;
        ssize_t nread = pread(fd, filebuf, filesize, 0);
        if (nread == -1) { free(filebuf); return -errno; }
        filebuf[nread] = '\\0';

        /* Transform paths - may return new buffer if transform happened */
        size_t newlen;
        char *transformed = transform_to_container_alloc(filebuf, nread, &newlen);
        char *result = transformed ? transformed : filebuf;

        if ((size_t)offset >= newlen) {
            if (transformed) free(transformed);
            free(filebuf);
            return 0;
        }
        size_t tocopy = newlen - offset;
        if (tocopy > size) tocopy = size;
        memcpy(buf, result + offset, tocopy);
        if (transformed) free(transformed);
        free(filebuf);
        return tocopy;
    }
    ssize_t res = pread(fd, buf, size, offset);
    return res == -1 ? -errno : res;
}

static int ccbox_write(const char *path, const char *buf, size_t size, off_t offset, struct fuse_file_info *fi) {
    if (needs_transform(path)) {
        /* For JSON files, transform Linux paths back to Windows paths */
        size_t newlen;
        char *transformed = transform_to_host_alloc(buf, size, &newlen);
        if (transformed) {
            /* Write transformed content - handle offset by reading existing, merging, writing */
            if (offset == 0) {
                /* Simple case: writing from beginning */
                ssize_t res = pwrite(fi->fh, transformed, newlen, 0);
                /* Truncate file to new size in case new content is shorter */
                if (res >= 0) ftruncate(fi->fh, newlen);
                free(transformed);
                return res == -1 ? -errno : (int)size;
            } else {
                /* Complex case: writing at offset - need to merge with existing content */
                struct stat st;
                if (fstat(fi->fh, &st) == -1) { free(transformed); return -errno; }
                size_t filesize = st.st_size;
                size_t total = (offset + newlen > filesize) ? offset + newlen : filesize;
                char *merged = malloc(total);
                if (!merged) { free(transformed); return -ENOMEM; }
                /* Read existing content */
                pread(fi->fh, merged, filesize, 0);
                /* Overlay transformed content at offset */
                memcpy(merged + offset, transformed, newlen);
                /* Write back */
                ssize_t res = pwrite(fi->fh, merged, total, 0);
                if (res >= 0) ftruncate(fi->fh, total);
                free(merged);
                free(transformed);
                return res == -1 ? -errno : (int)size;
            }
        }
    }
    ssize_t res = pwrite(fi->fh, buf, size, offset);
    return res == -1 ? -errno : res;
}

static int ccbox_release(const char *path, struct fuse_file_info *fi) { (void)path; close(fi->fh); return 0; }
static int ccbox_flush(const char *path, struct fuse_file_info *fi) { (void)path; return close(dup(fi->fh)) == -1 ? -errno : 0; }
static int ccbox_fsync(const char *path, int isdatasync, struct fuse_file_info *fi) { (void)path; return (isdatasync ? fdatasync(fi->fh) : fsync(fi->fh)) == -1 ? -errno : 0; }
static int ccbox_statfs(const char *path, struct statvfs *stbuf) { char fpath[MAX_PATH_LEN]; get_source_path(fpath, path, sizeof(fpath)); return statvfs(fpath, stbuf) == -1 ? -errno : 0; }
static int ccbox_access(const char *path, int mask) { char fpath[MAX_PATH_LEN]; get_source_path(fpath, path, sizeof(fpath)); return access(fpath, mask) == -1 ? -errno : 0; }
static int ccbox_mkdir(const char *path, mode_t mode) {
    struct fuse_context *ctx = fuse_get_context();
    char fpath[MAX_PATH_LEN];
    get_source_path(fpath, path, sizeof(fpath));
    if (mkdir(fpath, mode) == -1) return -errno;
    // Set ownership to calling process (not FUSE daemon)
    chown(fpath, ctx->uid, ctx->gid);
    return 0;
}
static int ccbox_unlink(const char *path) { char fpath[MAX_PATH_LEN]; get_source_path(fpath, path, sizeof(fpath)); return unlink(fpath) == -1 ? -errno : 0; }
static int ccbox_rmdir(const char *path) { char fpath[MAX_PATH_LEN]; get_source_path(fpath, path, sizeof(fpath)); return rmdir(fpath) == -1 ? -errno : 0; }
static int ccbox_create(const char *path, mode_t mode, struct fuse_file_info *fi) {
    struct fuse_context *ctx = fuse_get_context();
    char fpath[MAX_PATH_LEN];
    get_source_path(fpath, path, sizeof(fpath));
    int fd = open(fpath, fi->flags, mode);
    if (fd == -1) return -errno;
    fi->fh = fd;
    // Set ownership to calling process (not FUSE daemon)
    fchown(fd, ctx->uid, ctx->gid);
    return 0;
}
static int ccbox_truncate(const char *path, off_t size, struct fuse_file_info *fi) { char fpath[MAX_PATH_LEN]; get_source_path(fpath, path, sizeof(fpath)); return (fi ? ftruncate(fi->fh, size) : truncate(fpath, size)) == -1 ? -errno : 0; }
static int ccbox_utimens(const char *path, const struct timespec ts[2], struct fuse_file_info *fi) { (void)fi; char fpath[MAX_PATH_LEN]; get_source_path(fpath, path, sizeof(fpath)); return utimensat(0, fpath, ts, AT_SYMLINK_NOFOLLOW) == -1 ? -errno : 0; }
static int ccbox_chmod(const char *path, mode_t mode, struct fuse_file_info *fi) { (void)fi; char fpath[MAX_PATH_LEN]; get_source_path(fpath, path, sizeof(fpath)); return chmod(fpath, mode) == -1 ? -errno : 0; }
static int ccbox_chown(const char *path, uid_t uid, gid_t gid, struct fuse_file_info *fi) { (void)fi; char fpath[MAX_PATH_LEN]; get_source_path(fpath, path, sizeof(fpath)); return lchown(fpath, uid, gid) == -1 ? -errno : 0; }
static int ccbox_rename(const char *from, const char *to, unsigned int flags) { if (flags) return -EINVAL; char ff[MAX_PATH_LEN], ft[MAX_PATH_LEN]; get_source_path(ff, from, sizeof(ff)); get_source_path(ft, to, sizeof(ft)); return rename(ff, ft) == -1 ? -errno : 0; }
static int ccbox_symlink(const char *target, const char *linkpath) {
    struct fuse_context *ctx = fuse_get_context();
    char fpath[MAX_PATH_LEN];
    get_source_path(fpath, linkpath, sizeof(fpath));
    if (symlink(target, fpath) == -1) return -errno;
    // Set ownership to calling process (not FUSE daemon)
    lchown(fpath, ctx->uid, ctx->gid);
    return 0;
}
static int ccbox_readlink(const char *path, char *buf, size_t size) { char fpath[MAX_PATH_LEN]; get_source_path(fpath, path, sizeof(fpath)); ssize_t res = readlink(fpath, buf, size - 1); if (res == -1) return -errno; buf[res] = '\\0'; return 0; }
static int ccbox_link(const char *from, const char *to) { char ff[MAX_PATH_LEN], ft[MAX_PATH_LEN]; get_source_path(ff, from, sizeof(ff)); get_source_path(ft, to, sizeof(ft)); return link(ff, ft) == -1 ? -errno : 0; }

static const struct fuse_operations ccbox_oper = {
    .getattr = ccbox_getattr, .readdir = ccbox_readdir, .open = ccbox_open, .read = ccbox_read,
    .write = ccbox_write, .release = ccbox_release, .flush = ccbox_flush, .fsync = ccbox_fsync,
    .statfs = ccbox_statfs, .access = ccbox_access, .mkdir = ccbox_mkdir, .unlink = ccbox_unlink,
    .rmdir = ccbox_rmdir, .create = ccbox_create, .truncate = ccbox_truncate, .utimens = ccbox_utimens,
    .chmod = ccbox_chmod, .chown = ccbox_chown, .rename = ccbox_rename, .symlink = ccbox_symlink,
    .readlink = ccbox_readlink, .link = ccbox_link,
};

static void add_mapping(const char *from, const char *to) {
    if (mapping_count >= MAX_MAPPINGS) return;
    PathMapping *m = &mappings[mapping_count];
    m->from = normalize_path(from);
    m->to = normalize_path(to);
    if (!m->from || !m->to) { free(m->from); free(m->to); return; }
    m->from_len = strlen(m->from);
    m->to_len = strlen(m->to);
    m->drive = (m->from[0] && m->from[1] == ':') ? tolower(m->from[0]) : 0;
    m->is_unc = m->from[0] == '/' && m->from[1] == '/';
    m->is_wsl = strncmp(m->from, "/mnt/", 5) == 0 && isalpha(m->from[5]);
    if (m->is_wsl) m->drive = tolower(m->from[5]);
    mapping_count++;
}

static void parse_pathmap(const char *pathmap) {
    if (!pathmap || !*pathmap) return;
    char *copy = strdup(pathmap);
    if (!copy) return;
    char *saveptr = NULL, *mapping = strtok_r(copy, ";", &saveptr);
    while (mapping) {
        char *sep = mapping;
        /* Skip drive letter in Windows path (e.g., C:/...) */
        if (sep[0] && sep[1] == ':') sep += 2;
        sep = strchr(sep, ':');
        if (sep) { *sep = '\\0'; add_mapping(mapping, sep + 1); }
        mapping = strtok_r(NULL, ";", &saveptr);
    }
    free(copy);
}

struct ccbox_config { char *source; char *pathmap; };

static struct fuse_opt ccbox_opts[] = {
    {"source=%s", offsetof(struct ccbox_config, source), 0},
    {"pathmap=%s", offsetof(struct ccbox_config, pathmap), 0},
    FUSE_OPT_END
};

int main(int argc, char *argv[]) {
    struct fuse_args args = FUSE_ARGS_INIT(argc, argv);
    struct ccbox_config conf = {0};
    if (fuse_opt_parse(&args, &conf, ccbox_opts, NULL) == -1) return 1;
    if (!conf.source) { fprintf(stderr, "Error: source not specified\\n"); return 1; }
    source_dir = conf.source;
    size_t slen = strlen(source_dir);
    while (slen > 1 && source_dir[slen-1] == '/') source_dir[--slen] = '\\0';
    if (conf.pathmap) parse_pathmap(conf.pathmap);
    fuse_opt_add_arg(&args, "-o");
    fuse_opt_add_arg(&args, "default_permissions");
    if (getuid() == 0) { fuse_opt_add_arg(&args, "-o"); fuse_opt_add_arg(&args, "allow_other"); }
    int ret = fuse_main(args.argc, args.argv, &ccbox_oper, NULL);
    fuse_opt_free_args(&args);
    return ret;
}
`;
}

/**
 * Write Dockerfile and entrypoint to build directory.
 * Uses OS-agnostic path handling.
 * @param targetArch - Target architecture (amd64 or arm64). If not specified, uses host arch.
 */
export function writeBuildFiles(stack: LanguageStack, _targetArch?: string): string {
  // Use OS-agnostic temp directory
  const buildDir = join(tmpdir(), "ccbox", "build", stack);
  mkdirSync(buildDir, { recursive: true });

  // Write with explicit newline handling (Unix line endings for Dockerfile)
  const dockerfile = generateDockerfile(stack);
  const entrypoint = generateEntrypoint();

  writeFileSync(join(buildDir, "Dockerfile"), dockerfile, { encoding: "utf-8" });
  writeFileSync(join(buildDir, "entrypoint.sh"), entrypoint, { encoding: "utf-8", mode: 0o755 });

  // Write pre-compiled FUSE binary (no gcc needed - ~2GB savings)
  // Architecture is detected at build time via Docker's TARGETARCH
  // We write both binaries and let Docker select the right one
  const fuseBinaryAmd64 = Buffer.from(FUSE_BINARY_AMD64, "base64");
  const fuseBinaryArm64 = Buffer.from(FUSE_BINARY_ARM64, "base64");

  writeFileSync(join(buildDir, "ccbox-fuse-amd64"), fuseBinaryAmd64, { mode: 0o755 });
  writeFileSync(join(buildDir, "ccbox-fuse-arm64"), fuseBinaryArm64, { mode: 0o755 });

  // Write architecture selector script
  // Docker will use TARGETARCH to copy the correct binary
  const archSelector = `#!/bin/sh
# Select correct binary based on architecture
ARCH=\${TARGETARCH:-amd64}
if [ "$ARCH" = "arm64" ]; then
  cp /tmp/ccbox-fuse-arm64 /usr/local/bin/ccbox-fuse
else
  cp /tmp/ccbox-fuse-amd64 /usr/local/bin/ccbox-fuse
fi
chmod 755 /usr/local/bin/ccbox-fuse
`;
  writeFileSync(join(buildDir, "install-fuse.sh"), archSelector, { encoding: "utf-8", mode: 0o755 });

  // Also keep ccbox-fuse.c for source builds if needed
  const fuseSrc = join(__dirname, "..", "native", "ccbox-fuse.c");
  let fuseContent: string;
  if (existsSync(fuseSrc)) {
    fuseContent = readFileSync(fuseSrc, "utf-8");
  } else {
    // Fallback to embedded version when running from compiled binary
    fuseContent = generateCcboxFuseC();
  }
  writeFileSync(join(buildDir, "ccbox-fuse.c"), fuseContent, { encoding: "utf-8" });

  return buildDir;
}

/**
 * Generate project-specific Dockerfile with dependencies.
 */
export function generateProjectDockerfile(
  baseImage: string,
  depsList: DepsInfo[],
  depsMode: DepsMode,
  projectPath: string
): string {
  const lines = [
    "# syntax=docker/dockerfile:1",
    "# Project-specific image with dependencies",
    `FROM ${baseImage}`,
    "",
    "USER root",
    "WORKDIR /tmp/deps",
    "",
  ];

  // Collect candidate dependency files
  const candidateFiles = new Set<string>();
  for (const deps of depsList) {
    for (const f of deps.files) {
      if (!f.includes("*")) {
        candidateFiles.add(f);
      }
    }
  }

  // Add common dependency files
  const commonFiles = [
    "pyproject.toml",
    "setup.py",
    "setup.cfg",
    "package.json",
    "package-lock.json",
    "yarn.lock",
    "pnpm-lock.yaml",
    "go.mod",
    "go.sum",
    "Cargo.toml",
    "Cargo.lock",
    "Gemfile",
    "Gemfile.lock",
    "composer.json",
    "composer.lock",
  ];
  commonFiles.forEach((f) => candidateFiles.add(f));

  // Filter to only files that actually exist
  const existingFiles = [...candidateFiles].filter((f) => existsSync(join(projectPath, f)));

  // Copy only existing dependency files
  if (existingFiles.length > 0) {
    lines.push("# Copy dependency files");
    for (const pattern of existingFiles.sort()) {
      lines.push(`COPY ${pattern} ./`);
    }
  }

  lines.push("");

  // Get install commands
  const installCmds = getInstallCommands(depsList, depsMode);

  if (installCmds.length > 0) {
    lines.push("# Install dependencies");
    for (const cmd of installCmds) {
      const pkgManager = cmd.split(" ")[0] ?? "package";
      lines.push(`RUN ${cmd} || echo 'Warning: ${pkgManager} install failed'`);
    }
  }

  lines.push(
    "",
    "# Return to project directory (entrypoint will handle user switching via gosu)",
    "WORKDIR /ccbox",
    ""
  );

  return lines.join("\n");
}
