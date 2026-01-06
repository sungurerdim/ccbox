#!/bin/bash
# ccbox entrypoint script
# This script is embedded in generator.py via generate_entrypoint()
#
# Security model:
# - Container runs as host user via Docker --user flag (Linux/macOS)
# - On Windows, uses node user (UID 1000) with --user 1000:1000
# - --security-opt=no-new-privileges enabled
# - All capabilities dropped
#
# Debug output is controlled by CCBOX_DEBUG environment variable:
# - CCBOX_DEBUG=1: Basic progress messages
# - CCBOX_DEBUG=2: Verbose with environment details
#
# Mount strategy:
# NORMAL mode (default):
# - Host ~/.claude -> /home/node/.claude (rw, credentials + settings)
# - CCO files installed during 'ccbox build' to host ~/.claude
# - Project .claude -> persistent (rw)
#
# VANILLA mode (--bare):
# - Host ~/.claude -> /home/node/.claude (rw for credentials)
# - tmpfs overlays for rules/commands/agents/skills
# - No CCO injection

# Debug logging function
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

# Error trap
trap 'echo "[ccbox:ERROR] Command failed at line $LINENO: $BASH_COMMAND" >&2' ERR

set -e

_log "Entrypoint started (PID: $$)"
_log_verbose "Working directory: $PWD"
_log_verbose "Arguments: $*"
_log "Running as UID: $(id -u), GID: $(id -g)"

# Warn if running as root (misconfigured)
if [[ "$(id -u)" == "0" ]]; then
    echo "[ccbox:WARN] Running as root - use --user flag for proper permissions" >&2
fi

if [[ -n "$CCBOX_BARE_MODE" ]]; then
    _log "Bare mode: vanilla Claude Code (no CCO)"
fi

# Project .claude detection
if [[ -d "$PWD/.claude" ]]; then
    _log "Project .claude detected"
    _log_verbose "Contents: $(ls -A "$PWD/.claude" 2>/dev/null | tr '\n' ' ')"
fi

# Node.js runtime config
export NODE_OPTIONS="${NODE_OPTIONS:-} --max-old-space-size=$(( $(free -m | awk '/^Mem:/{print $2}') * 3 / 4 )) --max-semi-space-size=64"
export UV_THREADPOOL_SIZE=$(nproc)

# Create cache directory
mkdir -p /home/node/.cache/node-compile 2>/dev/null || true

_log_verbose "NODE_OPTIONS: $NODE_OPTIONS"
_log_verbose "UV_THREADPOOL_SIZE: $UV_THREADPOOL_SIZE"

# Git config
git config --global core.fileMode false 2>/dev/null || true
git config --global --add safe.directory '*' 2>/dev/null || true

# Verify claude command
if ! command -v claude &>/dev/null; then
    _die "claude command not found in PATH"
fi

_log_verbose "Claude: $(which claude)"
_log_verbose "Node: $(node --version 2>/dev/null || echo 'N/A')"

_log "Starting Claude Code..."

# Priority wrapper (skip if unrestricted)
if [[ -z "$CCBOX_UNRESTRICTED" ]]; then
    PRIORITY_CMD="nice -n 10 ionice -c2 -n7"
    _log_verbose "Resource limits active"
else
    PRIORITY_CMD=""
    _log_verbose "Unrestricted mode"
fi

# Execute
if [[ -t 1 ]]; then
    printf '\e[?2026h' 2>/dev/null || true
    exec $PRIORITY_CMD claude --dangerously-skip-permissions "$@"
else
    exec $PRIORITY_CMD stdbuf -oL -eL claude --dangerously-skip-permissions "$@"
fi
