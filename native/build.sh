#!/usr/bin/env bash
# Build native components for both platforms and place binaries where ccbox CLI expects them.
# Usage: ./native/build.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

for arch in amd64 arm64; do
  echo "==> Building linux/$arch ..."
  docker buildx build --platform "linux/$arch" \
    -f "$SCRIPT_DIR/Dockerfile.build" \
    -o "type=local,dest=$TMPDIR/$arch" \
    "$SCRIPT_DIR"
  cp "$TMPDIR/$arch/ccbox-fuse"  "$SCRIPT_DIR/ccbox-fuse-linux-$arch"
  cp "$TMPDIR/$arch/fakepath.so" "$SCRIPT_DIR/fakepath-linux-$arch.so"
done

echo "==> Done. Binaries:"
ls -lh "$SCRIPT_DIR"/ccbox-fuse-linux-* "$SCRIPT_DIR"/fakepath-linux-*.so
