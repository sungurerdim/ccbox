#!/bin/bash
# ccbox entrypoint - container initialization and Claude Code launcher

# === Logging ===
_log() { [[ -n "$CCBOX_DEBUG" ]] && echo "[ccbox] $*" || true; }
_log_verbose() { [[ "$CCBOX_DEBUG" == "2" ]] && echo "[ccbox:debug] $*" || true; }
_die() { echo "[ccbox:ERROR] $*" >&2; exit 1; }

trap 'echo "[ccbox:ERROR] Command failed at line $LINENO: $BASH_COMMAND" >&2' ERR

# === Cleanup on exit ===
_cleanup() {
    # Unmount FUSE overlays
    for _mp in /ccbox/.claude "$PWD/.claude"; do
        mountpoint -q "$_mp" 2>/dev/null && { fusermount -u "$_mp" 2>/dev/null || umount -l "$_mp" 2>/dev/null || true; }
    done
    # Unmount bind mounts
    if [[ -d /run/ccbox-fuse ]]; then
        for _bp in /run/ccbox-fuse/*/; do
            [[ -d "$_bp" ]] && mountpoint -q "$_bp" 2>/dev/null && { umount "$_bp" 2>/dev/null || umount -l "$_bp" 2>/dev/null || true; }
            rmdir "$_bp" 2>/dev/null || true
        done
    fi
    # Zero-residue cleanup
    if [[ -n "$CCBOX_ZERO_RESIDUE" ]]; then
        _log "Zero-residue cleanup..."
        rm -rf /ccbox/.cache/* /tmp/* /run/ccbox-fuse-trace.log /ccbox/.claude/debug/* 2>/dev/null || true
    fi
}
trap _cleanup EXIT
trap 'trap - TERM; _cleanup; kill -- -$$' TERM
trap 'trap - INT; _cleanup; kill -- -$$' INT

set -e

# === Timezone ===
[[ -n "$TZ" && -f "/usr/share/zoneinfo/$TZ" ]] && {
    ln -sf "/usr/share/zoneinfo/$TZ" /etc/localtime 2>/dev/null || true
    echo "$TZ" > /etc/timezone 2>/dev/null || true
} || true

_log "Entrypoint started (UID: $(id -u), GID: $(id -g))"

# === Network Isolation ===
if [[ "$CCBOX_NETWORK_POLICY" == "isolated" ]] && command -v iptables &>/dev/null; then
    _log "Network policy: isolated (private IPs blocked)"
    iptables -F OUTPUT 2>/dev/null || true
    iptables -A OUTPUT -o lo -j ACCEPT 2>/dev/null || true
    iptables -A OUTPUT -m state --state ESTABLISHED,RELATED -j ACCEPT 2>/dev/null || true
    # Allow: DNS, HTTP/S, SSH, Git
    for port in 53 80 443 22 9418; do
        iptables -A OUTPUT -p tcp --dport $port -j ACCEPT 2>/dev/null || true
    done
    iptables -A OUTPUT -p udp --dport 53 -j ACCEPT 2>/dev/null || true
    # Block private ranges
    for net in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 127.0.0.0/8; do
        iptables -A OUTPUT -d $net -j DROP 2>/dev/null || true
    done
fi

# === Dynamic User Setup ===
if [[ "$(id -u)" == "0" && -n "$CCBOX_UID" && -n "$CCBOX_GID" ]]; then
    _log_verbose "Setting up user (UID:$CCBOX_UID GID:$CCBOX_GID)"
    # Update GID if needed
    [[ "$CCBOX_GID" != "1000" ]] && {
        getent group "$CCBOX_GID" >/dev/null 2>&1 && groupdel "$(getent group "$CCBOX_GID" | cut -d: -f1)" 2>/dev/null || true
        groupmod -g "$CCBOX_GID" ccbox 2>/dev/null || true
    } || true
    # Update UID if needed
    [[ "$CCBOX_UID" != "1000" ]] && {
        getent passwd "$CCBOX_UID" >/dev/null 2>&1 && userdel "$(getent passwd "$CCBOX_UID" | cut -d: -f1)" 2>/dev/null || true
        usermod -u "$CCBOX_UID" ccbox 2>/dev/null || true
    } || true
    # Fix ownership
    for dir in /ccbox /ccbox/.cache /ccbox/.npm /ccbox/.local /ccbox/.config; do
        [[ -d "$dir" ]] && chown "$CCBOX_UID:$CCBOX_GID" "$dir" 2>/dev/null || true
    done
    mkdir -p /ccbox/.cache/tmp && chown "$CCBOX_UID:$CCBOX_GID" /ccbox/.cache/tmp 2>/dev/null || true
    # Fix .claude ownership
    _claude_dir="${CLAUDE_CONFIG_DIR:-/ccbox/.claude}"
    if [[ -d "$_claude_dir" ]]; then
        for subdir in projects todos tasks plans statsig session-env debug; do
            [[ -d "$_claude_dir/$subdir" ]] && find "$_claude_dir/$subdir" -user root -exec chown "$CCBOX_UID:$CCBOX_GID" {} + 2>/dev/null || true
        done
    fi
fi

# === FUSE Overlay Helper ===
_setup_fuse_overlay() {
    local mount_point="$1" label="$2"
    [[ ! -d "$mount_point" ]] && return 1

    local safe_name fuse_base="/run/ccbox-fuse"
    safe_name=$(echo "$mount_point" | tr '/' '-' | sed 's/^-//')
    mkdir -p "$fuse_base" "$fuse_base/$safe_name" 2>/dev/null || true
    local tmp_source="$fuse_base/$safe_name"

    mount --bind "$mount_point" "$tmp_source" || { rmdir "$tmp_source" 2>/dev/null; return 1; }

    local fuse_opts="source=$tmp_source,allow_other"
    [[ -n "$CCBOX_UID" ]] && fuse_opts="$fuse_opts,uid=$CCBOX_UID"
    [[ -n "$CCBOX_GID" ]] && fuse_opts="$fuse_opts,gid=$CCBOX_GID"

    nohup /usr/local/bin/ccbox-fuse -f -o "$fuse_opts" "$mount_point" </dev/null >/dev/null 2>&1 &
    local fuse_pid=$! waited=0
    while ! mountpoint -q "$mount_point" 2>/dev/null; do
        sleep 0.1; waited=$((waited + 1))
        [[ $waited -ge 50 ]] && { kill $fuse_pid 2>/dev/null || true; umount "$tmp_source" 2>/dev/null || true; rmdir "$tmp_source" 2>/dev/null; return 1; }
    done
    _log "FUSE mounted: $label"
}

# === Session Directory Merge (shadow -> native) ===
if [[ -n "$CCBOX_DIR_MAP" ]]; then
    _claude_projects="${CLAUDE_CONFIG_DIR:-/ccbox/.claude}/projects"
    if [[ -d "$_claude_projects" ]]; then
        IFS=';' read -ra _dirmaps <<< "$CCBOX_DIR_MAP"
        for _dm in "${_dirmaps[@]}"; do
            _container_name="${_dm%%:*}" _native_name="${_dm##*:}"
            [[ -z "$_container_name" || -z "$_native_name" ]] && continue
            _literal_dir="$_claude_projects/$_container_name" _native_dir="$_claude_projects/$_native_name"
            if [[ -d "$_literal_dir" && -d "$_native_dir" && "$_literal_dir" != "$_native_dir" ]]; then
                _log "Merging shadow sessions: $_container_name -> $_native_name"
                for _sf in "$_literal_dir"/*.jsonl; do
                    [[ -f "$_sf" ]] && [[ ! -f "$_native_dir/$(basename "$_sf")" ]] && mv "$_sf" "$_native_dir/" 2>/dev/null || true
                done
                rm -f "$_literal_dir/sessions-index.json" "$_native_dir/sessions-index.json" 2>/dev/null
                rmdir "$_literal_dir" 2>/dev/null || true
            elif [[ -d "$_native_dir" ]]; then
                _idx="$_native_dir/sessions-index.json"
                [[ -f "$_idx" ]] && [[ -n "$(find "$_native_dir" -maxdepth 1 -name '*.jsonl' -newer "$_idx" -print -quit 2>/dev/null)" ]] && rm -f "$_idx" 2>/dev/null
            fi
        done
    fi
fi

# === FUSE Path Translation ===
if [[ -n "$CCBOX_PATH_MAP" && -x "/usr/local/bin/ccbox-fuse" ]]; then
    _log "Setting up FUSE path translation..."
    [[ -d "/ccbox/.claude" ]] && _setup_fuse_overlay "/ccbox/.claude" "global" && export CCBOX_FUSE_GLOBAL=1
    [[ -d "$PWD/.claude" ]] && _setup_fuse_overlay "$PWD/.claude" "project" && export CCBOX_FUSE_PROJECT=1
    _log "Path mapping: $CCBOX_PATH_MAP"

    # Plugin case-sensitivity fix
    for _pdir in /ccbox/.claude/plugins/marketplaces /ccbox/.claude/plugins/cache; do
        [[ -d "$_pdir" ]] || continue
        find "$_pdir" -maxdepth 1 -name ".orphaned_at" -delete 2>/dev/null || true
        for _entry in "$_pdir"/*/; do
            [[ -d "$_entry" ]] || continue
            _name=$(basename "$_entry") _lower=$(echo "$_name" | tr '[:upper:]' '[:lower:]')
            [[ "$_name" != "$_lower" && ! -e "$_pdir/$_lower" ]] && ln -sf "$_name" "$_pdir/$_lower" 2>/dev/null || true
        done
    done
fi

# === ccbox-inject helper ===
cat > /usr/local/bin/ccbox-inject <<'EOF'
#!/bin/bash
set -e
[[ $# -eq 0 ]] && { echo "Usage: ccbox-inject <text>" >&2; exit 1; }
SESSION=$(tmux list-sessions -F '#{session_name}' 2>/dev/null | grep '^ccbox$' | head -1)
[[ -z "$SESSION" ]] && { echo "Error: No active ccbox session" >&2; exit 1; }
tmux send-keys -l -t "$SESSION" "$1"; sleep 1.5; tmux send-keys -t "$SESSION" Enter
EOF
chmod 755 /usr/local/bin/ccbox-inject

# === Git Configuration ===
cat > /etc/gitconfig 2>/dev/null <<'EOF' || true
[safe]
	directory = *
[core]
	fileMode = false
EOF
git config --system --add safe.directory "$PWD" 2>/dev/null || true

# Performance optimizations
cat > /root/.gitconfig 2>/dev/null <<'EOF' || true
[core]
	preloadindex = true
	fscache = true
	untrackedcache = true
[fetch]
	writeCommitGraph = true
[gc]
	auto = 0
[credential]
	helper = cache --timeout=86400
[pack]
	threads = 0
[index]
	threads = 0
EOF

# Copy to ccbox user
if [[ -f /root/.gitconfig && -n "$CCBOX_UID" ]]; then
    cp /root/.gitconfig /ccbox/.gitconfig 2>/dev/null || true
    chown "$CCBOX_UID:$CCBOX_GID" /ccbox/.gitconfig 2>/dev/null || true
fi

[[ -d "$PWD/.git" ]] && { _log "Git repository detected"; git config --global --add safe.directory "$PWD" 2>/dev/null || true; }

# === GitHub CLI (gh) Token Support ===
# If GITHUB_TOKEN is set, configure git to use it for HTTPS operations
if [[ -n "$GITHUB_TOKEN" ]]; then
    _log "GitHub token configured (git + gh CLI)"
    git config --global credential.helper "!f() { echo \"username=x-access-token\"; echo \"password=\$GITHUB_TOKEN\"; }; f" 2>/dev/null || true
fi

# === Temp Directories ===
mkdir -p /ccbox/.cache/tmp /ccbox/.cache/tmp/.gradle 2>/dev/null || true

# === Verify Claude ===
command -v claude &>/dev/null || _die "claude command not found in PATH"
_log "Starting Claude Code..."

# === Priority Wrapper ===
PRIORITY_CMD=""
[[ -z "$CCBOX_UNRESTRICTED" ]] && PRIORITY_CMD="nice -n 10 ionice -c2 -n7"

# === User Switch ===
EXEC_PREFIX=""
if [[ "$(id -u)" == "0" && -n "$CCBOX_UID" && -n "$CCBOX_GID" ]]; then
    export HOME=/ccbox
    EXEC_PREFIX="gosu ccbox"
fi

# === fakepath.so Preload ===
FAKEPATH_PRELOAD=""
[[ -n "$CCBOX_WIN_ORIGINAL_PATH" && -f "/usr/lib/fakepath.so" ]] && FAKEPATH_PRELOAD="LD_PRELOAD=/usr/lib/fakepath.so"

# === Execute ===
if [[ -n "$CCBOX_CMD" ]]; then
    exec $EXEC_PREFIX env $FAKEPATH_PRELOAD $CCBOX_CMD "$@"
else
    # Direct execution (no tmux wrapper - cleaner, avoids multi-line arg issues)
    [[ -t 1 ]] && printf '\e[?2026h' 2>/dev/null || true
    if [[ -t 1 ]]; then
        exec $EXEC_PREFIX env $FAKEPATH_PRELOAD $PRIORITY_CMD claude "$@"
    else
        exec $EXEC_PREFIX env $FAKEPATH_PRELOAD stdbuf -oL -eL $PRIORITY_CMD claude "$@"
    fi
fi
