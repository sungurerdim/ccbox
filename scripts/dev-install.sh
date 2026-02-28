#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION="dev"
COMMIT=$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")
DATE=$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo "unknown")
MODULE="github.com/sungur/ccbox/internal/cli"
LDFLAGS="-s -w -X ${MODULE}.Version=${VERSION} -X ${MODULE}.Commit=${COMMIT} -X ${MODULE}.Date=${DATE}"

INSTALL_DIR="${HOME}/.local/bin"
mkdir -p "$INSTALL_DIR"
go build -ldflags "$LDFLAGS" -o "${INSTALL_DIR}/ccbox" ./cmd/ccbox
echo "Installed: ${INSTALL_DIR}/ccbox (${VERSION}@${COMMIT})"

# PATH check
case ":$PATH:" in
  *":${INSTALL_DIR}:"*) ;;
  *) echo "Warning: ${INSTALL_DIR} is not in PATH" ;;
esac
