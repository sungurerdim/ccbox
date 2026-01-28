#!/usr/bin/env bash
#
# ccbox wrapper script for Linux, macOS, and WSL
#
# This wrapper handles:
#   - update: Download and install new binary
#   - uninstall: Remove ccbox completely
#   - version: Show wrapper and binary versions
#   - *: Pass-through to ccbox-bin
#

set -euo pipefail

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
DIM='\033[2m'
NC='\033[0m'

# Configuration
REPO="sungurerdim/ccbox"
GITHUB_API="https://api.github.com/repos/${REPO}/releases/latest"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CCBOX_BIN="${SCRIPT_DIR}/ccbox-bin"

# Print functions
info() { echo -e "${BLUE}$1${NC}"; }
success() { echo -e "${GREEN}$1${NC}"; }
warn() { echo -e "${YELLOW}$1${NC}"; }
error() { echo -e "${RED}$1${NC}" >&2; }
dim() { echo -e "${DIM}$1${NC}"; }

# Detect platform
detect_platform() {
    local os arch
    case "$(uname -s)" in
        Linux*)  os="linux" ;;
        Darwin*) os="darwin" ;;
        MINGW*|MSYS*|CYGWIN*) os="windows" ;;
        *)
            error "Unsupported OS: $(uname -s)"
            exit 1
            ;;
    esac

    case "$(uname -m)" in
        x86_64|amd64) arch="x64" ;;
        aarch64|arm64) arch="arm64" ;;
        *)
            error "Unsupported architecture: $(uname -m)"
            exit 1
            ;;
    esac

    echo "${os}-${arch}"
}

# Get current binary version
get_current_version() {
    if [[ -x "$CCBOX_BIN" ]]; then
        "$CCBOX_BIN" --version 2>/dev/null | head -n1 | sed 's/ccbox /v/' || echo "unknown"
    else
        echo "not installed"
    fi
}

# Fetch latest version from GitHub
fetch_latest_version() {
    local response
    response=$(curl -fsSL "$GITHUB_API" 2>/dev/null) || return 1
    echo "$response" | grep '"tag_name":' | sed -E 's/.*"([^"]+)".*/\1/'
}

# Compare semantic versions
# Returns: 0 if equal, 1 if a > b, 2 if a < b
compare_versions() {
    local a="${1#v}" b="${2#v}"

    if [[ "$a" == "$b" ]]; then
        return 0
    fi

    local IFS='.'
    read -ra partsA <<< "$a"
    read -ra partsB <<< "$b"

    local i max
    max=$(( ${#partsA[@]} > ${#partsB[@]} ? ${#partsA[@]} : ${#partsB[@]} ))

    for ((i=0; i<max; i++)); do
        local numA=${partsA[i]:-0}
        local numB=${partsB[i]:-0}

        if ((numA > numB)); then
            return 1
        elif ((numA < numB)); then
            return 2
        fi
    done

    return 0
}

# Download file with progress
download_file() {
    local url="$1" dest="$2"
    curl -fsSL --progress-bar "$url" -o "$dest"
}

# Update command
cmd_update() {
    local force=false

    # Parse flags
    while [[ $# -gt 0 ]]; do
        case "$1" in
            -f|--force) force=true; shift ;;
            *) shift ;;
        esac
    done

    local current latest platform
    current=$(get_current_version)

    dim "Checking for updates..."
    latest=$(fetch_latest_version) || {
        error "Failed to fetch latest version (network error or rate limited)"
        exit 1
    }

    echo ""
    info "Current version: $current"
    info "Latest version:  $latest"
    echo ""

    # Compare versions
    set +e
    compare_versions "$current" "$latest"
    local cmp=$?
    set -e

    if [[ $cmp -eq 0 ]] || [[ $cmp -eq 1 ]]; then
        success "ccbox is already up to date"
        return 0
    fi

    # Confirm upgrade
    if [[ "$force" != true ]]; then
        echo -n "Update to $latest? [Y/n] "
        read -r answer
        case "$answer" in
            [nN]*)
                dim "Cancelled."
                return 0
                ;;
        esac
    fi

    # Detect platform and download
    platform=$(detect_platform)
    local binary_name="ccbox-bin-${latest}-${platform}"
    local download_url="https://github.com/${REPO}/releases/download/${latest}/${binary_name}"

    info "Downloading ccbox-bin ${latest} for ${platform}..."

    # Download to temp file
    local tmp_file
    tmp_file=$(mktemp)
    trap 'rm -f "$tmp_file" "${CCBOX_BIN}.bak" 2>/dev/null' EXIT

    if ! download_file "$download_url" "$tmp_file"; then
        error "Failed to download binary"
        error "URL: $download_url"
        exit 1
    fi

    # Backup and replace
    if [[ -f "$CCBOX_BIN" ]]; then
        mv "$CCBOX_BIN" "${CCBOX_BIN}.bak"
    fi

    mv "$tmp_file" "$CCBOX_BIN"
    chmod +x "$CCBOX_BIN"

    # Remove backup
    rm -f "${CCBOX_BIN}.bak" 2>/dev/null || true

    echo ""
    success "Updated to $latest"
}

# Uninstall command
cmd_uninstall() {
    local force=false

    # Parse flags
    while [[ $# -gt 0 ]]; do
        case "$1" in
            -f|--force) force=true; shift ;;
            *) shift ;;
        esac
    done

    warn "This will remove ccbox completely:"
    echo "  - ${CCBOX_BIN}"
    echo "  - ${SCRIPT_DIR}/ccbox (this wrapper)"
    echo ""

    if [[ "$force" != true ]]; then
        echo -n "Continue? [y/N] "
        read -r answer
        case "$answer" in
            [yY]*) ;;
            *)
                dim "Cancelled."
                return 0
                ;;
        esac
    fi

    # Remove binary
    if [[ -f "$CCBOX_BIN" ]]; then
        rm -f "$CCBOX_BIN"
        dim "Removed: $CCBOX_BIN"
    fi

    # Self-delete wrapper
    local wrapper="${SCRIPT_DIR}/ccbox"
    if [[ -f "$wrapper" ]]; then
        rm -f "$wrapper"
        dim "Removed: $wrapper"
    fi

    echo ""
    success "ccbox has been uninstalled"
}

# Version command
cmd_version() {
    local check=false

    # Parse flags
    while [[ $# -gt 0 ]]; do
        case "$1" in
            -c|--check) check=true; shift ;;
            *) shift ;;
        esac
    done

    local current
    current=$(get_current_version)

    echo "ccbox wrapper v1.0.0"
    echo "ccbox-bin    $current"

    if [[ "$check" == true ]]; then
        echo ""
        dim "Checking for updates..."

        local latest
        latest=$(fetch_latest_version) || {
            warn "Could not check for updates (network error or rate limited)"
            return 0
        }

        set +e
        compare_versions "$current" "$latest"
        local cmp=$?
        set -e

        if [[ $cmp -eq 0 ]] || [[ $cmp -eq 1 ]]; then
            success "ccbox is up to date"
        else
            warn "Update available: $current -> $latest"
            echo ""
            dim "Run 'ccbox update' to update"
        fi
    fi
}

# Pass-through to ccbox-bin
pass_through() {
    if [[ ! -x "$CCBOX_BIN" ]]; then
        error "ccbox-bin not found at: $CCBOX_BIN"
        echo ""
        dim "Run 'ccbox update' to install"
        exit 1
    fi

    exec "$CCBOX_BIN" "$@"
}

# Main
main() {
    # No arguments - pass through
    if [[ $# -eq 0 ]]; then
        pass_through
    fi

    # Handle wrapper commands
    case "$1" in
        update)
            shift
            cmd_update "$@"
            ;;
        uninstall)
            shift
            cmd_uninstall "$@"
            ;;
        version)
            shift
            cmd_version "$@"
            ;;
        *)
            # Pass through to ccbox-bin
            pass_through "$@"
            ;;
    esac
}

main "$@"
