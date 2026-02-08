#!/usr/bin/env bash
# Build native components for both platforms and place binaries where ccbox CLI expects them.
#
# Go FUSE: cross-compiled natively (no Docker needed)
# fakepath.so: compiled in Docker (needs glibc headers)
#
# Usage: ./native/build.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

# === Go FUSE Binary (native cross-compile) ===
echo "==> Building Go FUSE binary..."
for arch in amd64 arm64; do
  echo "  -> linux/$arch"
  GOOS=linux GOARCH="$arch" CGO_ENABLED=0 \
    go build -ldflags="-s -w" -o "$PROJECT_DIR/embedded/ccbox-fuse-linux-$arch" \
    "$PROJECT_DIR/cmd/ccbox-fuse/"
done

# === fakepath.so (Docker cross-compile) ===
echo "==> Building fakepath.so..."
for arch in amd64 arm64; do
  echo "  -> linux/$arch"
  docker buildx build --platform "linux/$arch" \
    -f "$SCRIPT_DIR/Dockerfile.build" \
    -o "type=local,dest=$TMPDIR/$arch" \
    "$SCRIPT_DIR"
  cp "$TMPDIR/$arch/fakepath.so" "$PROJECT_DIR/embedded/fakepath-linux-$arch.so"
done

# === Update embedded source copies ===
cp "$SCRIPT_DIR/fakepath.c" "$PROJECT_DIR/embedded/fakepath.c.txt"

echo "==> Done. Binaries:"
ls -lh "$PROJECT_DIR/embedded"/ccbox-fuse-linux-* "$PROJECT_DIR/embedded"/fakepath-linux-*.so
