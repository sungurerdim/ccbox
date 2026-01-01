#!/bin/bash
# ccbox entrypoint script
# This script is embedded in generator.py via generate_entrypoint()
# Kept as reference file for documentation and potential external use
#
# Debug output is controlled by CCBOX_DEBUG environment variable:
# - CCBOX_DEBUG=1: Basic progress messages
# - CCBOX_DEBUG=2: Verbose with environment details
#
# Mount strategy:
# NORMAL mode (default):
# - Host ~/.claude -> /home/node/.claude (rw, fully accessible)
# - CCO files from /opt/cco copied to ~/.claude (merges with host's)
# - CCO CLAUDE.md (if exists) copied to project .claude
# - Project .claude -> persistent (rw)
#
# VANILLA mode (--bare):
# - Host ~/.claude -> /home/node/.claude (rw for credentials/settings)
# - tmpfs overlays for rules/commands/agents/skills (host's hidden)
# - CLAUDE.md hidden via /dev/null
# - No CCO injection

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

# Detect host UID/GID from mounted directory
HOST_UID=$(stat -c '%u' "$PWD" 2>/dev/null || stat -f '%u' "$PWD" 2>/dev/null || echo "1000")
HOST_GID=$(stat -c '%g' "$PWD" 2>/dev/null || stat -f '%g' "$PWD" 2>/dev/null || echo "1000")
_log_verbose "Host UID/GID: $HOST_UID/$HOST_GID"

# If root, switch to node user (with optional UID remapping)
if [[ "$(id -u)" == "0" ]]; then
    _log "Running as root, switching to node user..."
    if [[ "$HOST_UID" != "0" && "$HOST_UID" != "1000" ]]; then
        _log "Remapping UID $HOST_UID -> node"
        usermod -u "$HOST_UID" node 2>/dev/null || true
        groupmod -g "$HOST_GID" node 2>/dev/null || true
        chown "$HOST_UID:$HOST_GID" /home/node 2>/dev/null || true
        chown -R "$HOST_UID:$HOST_GID" /home/node/.claude /home/node/.npm /home/node/.config 2>/dev/null || true
    fi
    _log "Switching to node user via gosu..."
    exec gosu node "$0" "$@"
fi

_log "Running as node user (UID: $(id -u))"

# Inject CCO files from image (unless bare mode)
# Host .claude is mounted rw, but rules/commands/agents/skills are tmpfs overlays
if [[ -z "$CCBOX_BARE_MODE" && -d "/opt/cco" ]]; then
    _log "Injecting CCO from image..."
    # Copy all CCO directories to global .claude (tmpfs overlays)
    for dir in rules commands agents skills; do
        if [[ -d "/opt/cco/$dir" ]]; then
            cp -r "/opt/cco/$dir/." "/home/node/.claude/$dir/" 2>/dev/null || true
            _log_verbose "Copied $dir/ to global .claude"
        fi
    done
    # Copy CLAUDE.md template to project .claude (takes precedence over global)
    # Global CLAUDE.md is hidden via /dev/null mount
    if [[ -f "/opt/cco/CLAUDE.md" ]]; then
        mkdir -p "$PWD/.claude" 2>/dev/null || true
        cp "/opt/cco/CLAUDE.md" "$PWD/.claude/CLAUDE.md" 2>/dev/null || true
        _log_verbose "Copied CLAUDE.md to project .claude"
    fi
else
    _log "Bare mode: vanilla Claude Code (no CCO)"
fi

# Project .claude is mounted directly from host (persistent)
# Claude Code automatically reads project .claude first, then global
if [[ -d "$PWD/.claude" ]]; then
    _log "Project .claude detected (persistent, host-mounted)"
    _log_verbose "Project .claude contents: $(ls -A "$PWD/.claude" 2>/dev/null | tr '\n' ' ')"
fi

# Runtime config (as node user) - append to existing NODE_OPTIONS (preserves flags from docker run)
# --max-old-space-size: dynamic heap limit (3/4 of available RAM)
# --max-semi-space-size: larger young generation reduces GC pauses for smoother output
export NODE_OPTIONS="${NODE_OPTIONS:-} --max-old-space-size=$(( $(free -m | awk '/^Mem:/{print $2}') * 3 / 4 )) --max-semi-space-size=64"
export UV_THREADPOOL_SIZE=$(nproc)
_log_verbose "NODE_OPTIONS: $NODE_OPTIONS"
_log_verbose "UV_THREADPOOL_SIZE: $UV_THREADPOOL_SIZE"

git config --global core.fileMode false 2>/dev/null || true
git config --global --add safe.directory '*' 2>/dev/null || true

# Verify claude command exists
if ! command -v claude &>/dev/null; then
    _die "claude command not found in PATH"
fi

_log_verbose "Claude location: $(which claude)"
_log_verbose "Node version: $(node --version 2>/dev/null || echo 'N/A')"
_log_verbose "npm version: $(npm --version 2>/dev/null || echo 'N/A')"

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

# Use stdbuf for unbuffered output in non-TTY mode (--print with pipes)
if [[ -t 1 ]]; then
    # TTY mode: Enable synchronized output (mode 2026) if terminal supports it
    # This reduces flickering by batching terminal updates atomically
    # Terminals that don't support it will silently ignore the sequence
    printf '\e[?2026h' 2>/dev/null || true
    exec $PRIORITY_CMD claude --dangerously-skip-permissions "$@"
else
    exec $PRIORITY_CMD stdbuf -oL -eL claude --dangerously-skip-permissions "$@"
fi
