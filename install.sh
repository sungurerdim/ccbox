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
        x86_64|amd64) arch="amd64" ;;
        aarch64|arm64) arch="arm64" ;;
        *)
            echo -e "  ${RED}Unsupported architecture: $(uname -m)${NC}" >&2
            exit 1
            ;;
    esac

    echo "${os}_${arch}"
}

# Get latest version from GitHub
get_latest_version() {
    curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" | grep '"tag_name":' | sed -E 's/.*"([^"]+)".*/\1/'
}

# Download and install ccbox
install_ccbox() {
    local platform="$1"
    local version="$2"

    # GoReleaser archive naming: ccbox_{version}_{os}_{arch}.tar.gz (or .zip for windows)
    local ver_no_v="${version#v}"
    local archive_name="ccbox_${ver_no_v}_${platform}"
    local ext="tar.gz"
    if [[ "$platform" == windows_* ]]; then
        ext="zip"
    fi
    local archive_url="https://github.com/${REPO}/releases/download/${version}/${archive_name}.${ext}"

    local tmp_dir
    tmp_dir=$(mktemp -d)
    trap 'rm -rf "$tmp_dir"' EXIT

    task "Downloading ccbox ${version}"
    if curl -fsSL "$archive_url" -o "$tmp_dir/archive.${ext}"; then
        done_
    else
        fail_ "URL: $archive_url"
        exit 1
    fi

    task "Extracting"
    if [[ "$ext" == "tar.gz" ]]; then
        tar xzf "$tmp_dir/archive.tar.gz" -C "$tmp_dir"
    else
        unzip -q "$tmp_dir/archive.zip" -d "$tmp_dir"
    fi
    done_

    mkdir -p "$INSTALL_DIR"

    local binary="ccbox"
    if [[ "$platform" == windows_* ]]; then
        binary="ccbox.exe"
    fi

    mv "$tmp_dir/$binary" "$INSTALL_DIR/$binary"
    chmod +x "$INSTALL_DIR/$binary"

    echo ""
    echo -e "  ${DIM}Installed to${NC}  $INSTALL_DIR"
    echo -e "    ${CYAN}ccbox${NC}  ${DIM}$(du -h "$INSTALL_DIR/$binary" 2>/dev/null | cut -f1 || echo "binary")${NC}"
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
    echo ""
    echo -e "  ${BOLD}ccbox${NC} ${DIM}installer${NC}"
    echo ""

    local platform
    platform=$(detect_platform)

    local version
    if [[ -n "$VERSION" ]]; then
        version="$VERSION"
    else
        version=$(get_latest_version)
    fi

    step "Platform" "$platform"
    step "Version " "$version"
    echo ""

    install_ccbox "$platform" "$version"
    check_path
    check_docker

    echo ""
    echo -e "  ${GREEN}Done!${NC} ${DIM}Run${NC} ccbox --help ${DIM}to get started.${NC}"
    echo ""
}

main "$@"
