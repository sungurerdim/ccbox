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
BOLD='\033[1m'
DIM='\033[2m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
RED='\033[0;31m'
NC='\033[0m'

# Configuration
REPO="sungurerdim/ccbox"
INSTALL_DIR="${CCBOX_INSTALL_DIR:-$HOME/.local/bin}"
VERSION="${CCBOX_VERSION:-}"

# Output helpers
step()    { echo -e "  ${DIM}$1${NC}  $2"; }
task()    { printf "  %s ..." "$1"; }
done_()   { echo -e " ${GREEN}done${NC}"; }
fail_()   { echo -e " ${RED}failed${NC}"; echo -e "  ${RED}$1${NC}" >&2; }

# Detect OS and architecture
detect_platform() {
    local os arch

    case "$(uname -s)" in
        Linux*)  os="linux" ;;
        Darwin*) os="darwin" ;;
        MINGW*|MSYS*|CYGWIN*) os="windows" ;;
        *)
            echo -e "  ${RED}Unsupported OS: $(uname -s)${NC}" >&2
            exit 1
            ;;
    esac

    case "$(uname -m)" in
        x86_64|amd64) arch="x64" ;;
        aarch64|arm64) arch="arm64" ;;
        *)
            echo -e "  ${RED}Unsupported architecture: $(uname -m)${NC}" >&2
            exit 1
            ;;
    esac

    echo "${os}-${arch}"
}

# Get latest version from GitHub
get_latest_version() {
    curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" | grep '"tag_name":' | sed -E 's/.*"([^"]+)".*/\1/'
}

# Download and install ccbox
install_ccbox() {
    local platform="$1"
    local version="$2"

    local binary_name="ccbox-bin-${version}-${platform}"
    local binary_url="https://github.com/${REPO}/releases/download/${version}/${binary_name}"
    local wrapper_url="https://raw.githubusercontent.com/${REPO}/${version}/scripts/wrapper/ccbox.sh"

    local tmp_binary tmp_wrapper
    tmp_binary=$(mktemp)
    tmp_wrapper=$(mktemp)
    trap 'rm -f "$tmp_binary" "$tmp_wrapper"' EXIT

    # Download binary
    task "Downloading ccbox-bin"
    if curl -fsSL "$binary_url" -o "$tmp_binary"; then
        done_
    else
        fail_ "URL: $binary_url"
        exit 1
    fi

    # Download wrapper
    task "Downloading ccbox wrapper"
    if curl -fsSL "$wrapper_url" -o "$tmp_wrapper"; then
        done_
    else
        fail_ "URL: $wrapper_url"
        exit 1
    fi

    # Install
    mkdir -p "$INSTALL_DIR"

    mv "$tmp_binary" "$INSTALL_DIR/ccbox-bin"
    chmod +x "$INSTALL_DIR/ccbox-bin"

    mv "$tmp_wrapper" "$INSTALL_DIR/ccbox"
    chmod +x "$INSTALL_DIR/ccbox"

    echo ""
    echo -e "  ${DIM}Installed to${NC}  $INSTALL_DIR"
    echo -e "    ${CYAN}ccbox${NC}      ${DIM}wrapper${NC}"
    echo -e "    ${CYAN}ccbox-bin${NC}  ${DIM}binary${NC}"
}

# Check if install directory is in PATH and add if not
check_path() {
    if [[ ":$PATH:" == *":$INSTALL_DIR:"* ]]; then
        return 0
    fi

    local profile_file=""
    local path_line="export PATH=\"$INSTALL_DIR:\$PATH\""

    case "${SHELL:-/bin/bash}" in
        */zsh)  profile_file="$HOME/.zshrc" ;;
        */bash)
            if [[ "$(uname -s)" == "Darwin" ]]; then
                profile_file="$HOME/.bash_profile"
            else
                profile_file="$HOME/.bashrc"
            fi
            ;;
        */fish)
            profile_file="$HOME/.config/fish/config.fish"
            path_line="set -gx PATH \"$INSTALL_DIR\" \$PATH"
            ;;
        *)      profile_file="$HOME/.profile" ;;
    esac

    if [[ -f "$profile_file" ]] && grep -q "$INSTALL_DIR" "$profile_file" 2>/dev/null; then
        return 0
    fi

    if [[ ! -f "$profile_file" ]]; then
        mkdir -p "$(dirname "$profile_file")"
        touch "$profile_file"
    fi

    echo "" >> "$profile_file"
    echo "# Added by ccbox installer" >> "$profile_file"
    echo "$path_line" >> "$profile_file"

    echo ""
    echo -e "  ${DIM}Added to${NC} $profile_file"
    echo -e "  ${YELLOW}Restart your terminal or run:${NC}  source $profile_file"
}

# Check Docker
check_docker() {
    if ! command -v docker &> /dev/null; then
        echo ""
        echo -e "  ${YELLOW}Docker${NC} ${YELLOW}not found - install from https://docs.docker.com/get-docker/${NC}"
    fi
}

# Main
main() {
    # Banner
    echo ""
    echo -e "  ${BOLD}ccbox${NC} ${DIM}installer${NC}"
    echo ""

    # Detect platform
    local platform
    platform=$(detect_platform)

    # Get version
    local version
    if [[ -n "$VERSION" ]]; then
        version="$VERSION"
    else
        version=$(get_latest_version)
    fi

    # Info
    step "Platform" "$platform"
    step "Version " "$version"
    echo ""

    # Install
    install_ccbox "$platform" "$version"

    # Check PATH
    check_path

    # Check Docker
    check_docker

    # Footer
    echo ""
    echo -e "  ${GREEN}Done!${NC} ${DIM}Run${NC} ccbox --help ${DIM}to get started.${NC}"
    echo ""
}

main "$@"
