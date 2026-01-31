#!/bin/bash

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

# Graceful FUSE cleanup on exit
_cleanup_fuse() {
    for _mp in /ccbox/.claude "$PWD/.claude"; do
        if mountpoint -q "$_mp" 2>/dev/null; then
            fusermount -u "$_mp" 2>/dev/null || umount -l "$_mp" 2>/dev/null || true
        fi
    done
}
trap _cleanup_fuse EXIT

set -e

# Set system timezone from TZ env var (passed from host by docker-runtime)
if [[ -n "$TZ" && -f "/usr/share/zoneinfo/$TZ" ]]; then
    ln -sf "/usr/share/zoneinfo/$TZ" /etc/localtime 2>/dev/null || true
    echo "$TZ" > /etc/timezone 2>/dev/null || true
fi

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

    _claude_dir="${CLAUDE_CONFIG_DIR:-/ccbox/.claude}"

    # Fix .claude directory ownership (projects, sessions, etc. created by previous runs)
    # Uses CLAUDE_CONFIG_DIR env var for dynamic path resolution
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
# Onboarding state symlink
# Claude Code looks for ~/.claude.json at $HOME/.claude.json
# But host may store it inside .claude/ directory (at .claude/.claude.json)
# Create symlink so Claude finds it at expected location
# ══════════════════════════════════════════════════════════════════════════════
if [[ -f "/ccbox/.claude/.claude.json" && ! -e "/ccbox/.claude.json" ]]; then
    ln -sf /ccbox/.claude/.claude.json /ccbox/.claude.json 2>/dev/null || true
    _log "Linked onboarding state: /ccbox/.claude.json -> .claude/.claude.json"
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
    # pathmap/dirmap are read from env vars (CCBOX_PATH_MAP, CCBOX_DIR_MAP) by the binary
    # NOT passed via -o to avoid FUSE comma-parsing issues with paths
    local fuse_opts="source=$tmp_source,allow_other"
    [[ -n "$CCBOX_UID" ]] && fuse_opts="$fuse_opts,uid=$CCBOX_UID"
    [[ -n "$CCBOX_GID" ]] && fuse_opts="$fuse_opts,gid=$CCBOX_GID"

    _log_verbose "FUSE ($label): $tmp_source -> $mount_point (in-place overlay)"

    # Mount FUSE over original path (in-place overlay)
    nohup /usr/local/bin/ccbox-fuse -f -o "$fuse_opts" "$mount_point" </dev/null >/dev/null 2>&1 &
    local fuse_pid=$!

    # Poll for FUSE mount readiness instead of fixed sleep
    local waited=0
    while ! mountpoint -q "$mount_point" 2>/dev/null; do
        sleep 0.1
        waited=$((waited + 1))
        if [[ $waited -ge 50 ]]; then
            _log "FUSE mount timeout: $label"
            kill $fuse_pid 2>/dev/null || true
            umount "$tmp_source" 2>/dev/null || true
            rmdir "$tmp_source" 2>/dev/null
            return 1
        fi
    done

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

    # Case-sensitivity fix for plugins: Linux is case-sensitive, Windows is not.
    # Claude Code may lookup marketplace dirs in lowercase but they exist in mixed case.
    # Create lowercase symlinks for any non-lowercase directory names.
    for _pdir in /ccbox/.claude/plugins/marketplaces /ccbox/.claude/plugins/cache; do
        [[ -d "$_pdir" ]] || continue
        for _entry in "$_pdir"/*/; do
            [[ -d "$_entry" ]] || continue
            _name=$(basename "$_entry")
            _lower=$(echo "$_name" | tr '[:upper:]' '[:lower:]')
            if [[ "$_name" != "$_lower" && ! -e "$_pdir/$_lower" ]]; then
                ln -sf "$_name" "$_pdir/$_lower" 2>/dev/null || true
                _log_verbose "Plugin case-fix: $_lower -> $_name"
            fi
        done
    done
else
    # No path mapping needed or FUSE not available
    if [[ -d "$PWD/.claude" ]]; then
        _log "Project .claude detected (direct mount, no path transform)"
    fi
fi


# Git performance optimizations (I/O reduction)
# Use --system for settings that must apply to all users (root runs this, ccbox runs claude)
# Use --global for user-specific settings (will be inherited when gosu switches to ccbox)
# CRITICAL: Add wildcard safe.directory to allow any mounted path (quotes prevent shell expansion)
git config --system --add safe.directory "*" 2>/dev/null || true
git config --system core.fileMode false 2>/dev/null || true
# Also add current project directory explicitly (belt and suspenders)
git config --system --add safe.directory "$PWD" 2>/dev/null || true
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

# Copy root's gitconfig to ccbox user so performance settings are inherited
if [[ -f /root/.gitconfig && -n "$CCBOX_UID" ]]; then
    cp /root/.gitconfig /ccbox/.gitconfig 2>/dev/null || true
    chown "$CCBOX_UID:$CCBOX_GID" /ccbox/.gitconfig 2>/dev/null || true
fi

# If project has .git, ensure it's recognized despite path/ownership differences
if [[ -d "$PWD/.git" ]]; then
    _log "Git repository detected at $PWD"
    # Add this specific directory as safe (belt and suspenders with --system '*')
    git config --global --add safe.directory "$PWD" 2>/dev/null || true
fi

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

# ══════════════════════════════════════════════════════════════════════════════
# Path Translation via LD_PRELOAD (fakepath.so)
# Intercepts glibc calls (getcwd, open, stat, etc.) to translate between
# container paths (/d/GitHub/project) and host paths (D:/GitHub/project).
# Note: Bun uses direct syscalls for file I/O (bypasses glibc), so FUSE
# handles file content transformation. fakepath complements FUSE by covering
# glibc-based tools (git, npm, etc.) and getcwd for path display.
# ══════════════════════════════════════════════════════════════════════════════
FAKEPATH_PRELOAD=""
if [[ -n "$CCBOX_WIN_ORIGINAL_PATH" && -f "/usr/lib/fakepath.so" ]]; then
    FAKEPATH_PRELOAD="LD_PRELOAD=/usr/lib/fakepath.so"
    _log "fakepath active: $CCBOX_WIN_ORIGINAL_PATH"
fi

# Run command (Claude Code by default, or custom via CCBOX_CMD for debugging)
# Usage: docker run -e CCBOX_CMD=bash ... (opens shell with FUSE active)
#        docker run -e CCBOX_CMD=cat ... /ccbox/.claude/plugins/installed_plugins.json
if [[ -n "$CCBOX_CMD" ]]; then
    _log "Custom command: $CCBOX_CMD $*"
    exec $EXEC_PREFIX env $FAKEPATH_PRELOAD $CCBOX_CMD "$@"
elif [[ -t 1 ]]; then
    printf '\e[?2026h' 2>/dev/null || true
    exec $EXEC_PREFIX env $FAKEPATH_PRELOAD $PRIORITY_CMD claude --dangerously-skip-permissions "$@"
else
    exec $EXEC_PREFIX env $FAKEPATH_PRELOAD stdbuf -oL -eL $PRIORITY_CMD claude --dangerously-skip-permissions "$@"
fi
