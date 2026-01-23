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

# Download and install binary
install_ccbox() {
    local platform="$1"
    local version="$2"
    local download_url binary_name tmp_file

    # Construct download URL
    binary_name="ccbox-${version}-${platform}"
    download_url="https://github.com/${REPO}/releases/download/${version}/${binary_name}"

    info "Downloading ccbox ${version} for ${platform}..."

    # Create temp file
    tmp_file=$(mktemp)
    trap 'rm -f "$tmp_file"' EXIT

    # Download
    if ! curl -fsSL "$download_url" -o "$tmp_file"; then
        error "Failed to download ccbox"
        error "URL: $download_url"
        exit 1
    fi

    # Create install directory if it doesn't exist
    mkdir -p "$INSTALL_DIR"

    # Install binary
    local target="$INSTALL_DIR/ccbox"
    mv "$tmp_file" "$target"
    chmod +x "$target"

    success "Installed ccbox to $target"
}

# Check if install directory is in PATH and warn if not
check_path() {
    if [[ ":$PATH:" == *":$INSTALL_DIR:"* ]]; then
        return 0
    fi

    warn ""
    warn "WARNING: $INSTALL_DIR is not in your PATH"
    warn ""
    warn "Add it to your shell profile:"
    echo ""

    # Detect shell and provide specific instructions
    case "${SHELL:-/bin/bash}" in
        */zsh)
            echo "  echo 'export PATH=\"$INSTALL_DIR:\$PATH\"' >> ~/.zshrc"
            echo "  source ~/.zshrc"
            ;;
        */bash)
            if [[ "$(uname -s)" == "Darwin" ]]; then
                echo "  echo 'export PATH=\"$INSTALL_DIR:\$PATH\"' >> ~/.bash_profile"
                echo "  source ~/.bash_profile"
            else
                echo "  echo 'export PATH=\"$INSTALL_DIR:\$PATH\"' >> ~/.bashrc"
                echo "  source ~/.bashrc"
            fi
            ;;
        */fish)
            echo "  echo 'set -gx PATH \"$INSTALL_DIR\" \$PATH' >> ~/.config/fish/config.fish"
            echo "  source ~/.config/fish/config.fish"
            ;;
        *)
            echo "  export PATH=\"$INSTALL_DIR:\$PATH\""
            echo ""
            echo "  Add the above line to your shell profile (~/.profile, ~/.bashrc, etc.)"
            ;;
    esac
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
