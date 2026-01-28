#!/usr/bin/env bash
#
# ccbox installer for Linux, macOS, and WSL
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/sungurerdim/ccbox/main/install.sh | bash
#
# Environment variables:
#   CCBOX_INSTALL_DIR  - Installation directory (default: ~/.local/bin)
#   CCBOX_VERSION      - Specific version to install (default: latest)
#

set -euo pipefail

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
REPO="sungurerdim/ccbox"
# ~/.local/bin is in default PATH on modern Linux distros (Ubuntu 20.04+, Fedora, Debian)
# per XDG Base Directory Specification
INSTALL_DIR="${CCBOX_INSTALL_DIR:-$HOME/.local/bin}"
VERSION="${CCBOX_VERSION:-}"

# Print colored message
info() { echo -e "${BLUE}$1${NC}"; }
success() { echo -e "${GREEN}$1${NC}"; }
warn() { echo -e "${YELLOW}$1${NC}"; }
error() { echo -e "${RED}$1${NC}" >&2; }

# Detect OS and architecture
detect_platform() {
    local os arch

    case "$(uname -s)" in
        Linux*)  os="linux" ;;
        Darwin*) os="darwin" ;;
        MINGW*|MSYS*|CYGWIN*) os="windows" ;;
        *)
            error "Unsupported operating system: $(uname -s)"
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

# Get latest version from GitHub
get_latest_version() {
    local latest
    latest=$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" | grep '"tag_name":' | sed -E 's/.*"([^"]+)".*/\1/')
    echo "$latest"
}

# Download and install ccbox
install_ccbox() {
    local platform="$1"
    local version="$2"
    local binary_url wrapper_url binary_name tmp_binary tmp_wrapper

    # Construct download URLs
    binary_name="ccbox-bin-${version}-${platform}"
    binary_url="https://github.com/${REPO}/releases/download/${version}/${binary_name}"
    wrapper_url="https://raw.githubusercontent.com/${REPO}/${version}/scripts/wrapper/ccbox.sh"

    info "Downloading ccbox ${version} for ${platform}..."

    # Create temp files
    tmp_binary=$(mktemp)
    tmp_wrapper=$(mktemp)
    trap 'rm -f "$tmp_binary" "$tmp_wrapper"' EXIT

    # Download binary
    if ! curl -fsSL "$binary_url" -o "$tmp_binary"; then
        error "Failed to download ccbox-bin"
        error "URL: $binary_url"
        exit 1
    fi

    # Download wrapper
    if ! curl -fsSL "$wrapper_url" -o "$tmp_wrapper"; then
        error "Failed to download wrapper script"
        error "URL: $wrapper_url"
        exit 1
    fi

    # Create install directory if it doesn't exist
    mkdir -p "$INSTALL_DIR"

    # Install binary
    local target_binary="$INSTALL_DIR/ccbox-bin"
    mv "$tmp_binary" "$target_binary"
    chmod +x "$target_binary"

    # Install wrapper
    local target_wrapper="$INSTALL_DIR/ccbox"
    mv "$tmp_wrapper" "$target_wrapper"
    chmod +x "$target_wrapper"

    success "Installed ccbox to $INSTALL_DIR"
    echo "  - ccbox (wrapper)"
    echo "  - ccbox-bin (binary)"
}

# Check if install directory is in PATH and add if not
check_path() {
    if [[ ":$PATH:" == *":$INSTALL_DIR:"* ]]; then
        return 0
    fi

    info "Adding $INSTALL_DIR to PATH..."

    local profile_file=""
    local path_line="export PATH=\"$INSTALL_DIR:\$PATH\""

    # Detect shell and profile file
    case "${SHELL:-/bin/bash}" in
        */zsh)
            profile_file="$HOME/.zshrc"
            ;;
        */bash)
            if [[ "$(uname -s)" == "Darwin" ]]; then
                # macOS uses .bash_profile for login shells
                profile_file="$HOME/.bash_profile"
            else
                profile_file="$HOME/.bashrc"
            fi
            ;;
        */fish)
            profile_file="$HOME/.config/fish/config.fish"
            path_line="set -gx PATH \"$INSTALL_DIR\" \$PATH"
            ;;
        *)
            profile_file="$HOME/.profile"
            ;;
    esac

    # Check if already added (avoid duplicates)
    if [[ -f "$profile_file" ]] && grep -q "$INSTALL_DIR" "$profile_file" 2>/dev/null; then
        info "PATH entry already exists in $profile_file"
        return 0
    fi

    # Create profile file if it doesn't exist
    if [[ ! -f "$profile_file" ]]; then
        mkdir -p "$(dirname "$profile_file")"
        touch "$profile_file"
    fi

    # Add PATH entry
    echo "" >> "$profile_file"
    echo "# Added by ccbox installer" >> "$profile_file"
    echo "$path_line" >> "$profile_file"

    success "Added to $profile_file"
    warn ""
    warn "Run this to use ccbox immediately:"
    echo "  source $profile_file"
    warn ""
    warn "Or open a new terminal window."
    echo ""
}

# Check Docker
check_docker() {
    if ! command -v docker &> /dev/null; then
        warn ""
        warn "Docker is required but not found."
        warn "Install Docker: https://docs.docker.com/get-docker/"
    fi
}

# Main
main() {
    echo ""
    info "ccbox Installer"
    echo ""

    # Detect platform
    local platform
    platform=$(detect_platform)
    info "Detected platform: $platform"

    # Get version
    local version
    if [[ -n "$VERSION" ]]; then
        version="$VERSION"
    else
        info "Fetching latest version..."
        version=$(get_latest_version)
    fi
    info "Version: $version"
    echo ""

    # Install
    install_ccbox "$platform" "$version"

    # Check PATH and warn if needed
    check_path

    # Check Docker
    check_docker

    echo ""
    success "Installation complete!"
    echo ""
    echo "Get started:"
    echo "  ccbox --help"
    echo ""
}

main "$@"
