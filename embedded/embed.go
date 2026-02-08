// Package embedded provides pre-compiled native binaries and source files
// for ccbox's FUSE filesystem and fakepath LD_PRELOAD library.
//
// These binaries are embedded into the Go binary at compile time using go:embed.
// They are written to the Docker build context during image builds.
//
// To rebuild the native binaries:
//
//	cd native && docker buildx build --platform linux/amd64,linux/arm64 -f Dockerfile.build --output type=local,dest=. .
//
// Then copy the outputs into this directory.
package embedded

import _ "embed"

// Pre-compiled FUSE binaries for kernel-level path transformation.
// FUSE intercepts ALL file operations including Bun/Zig direct syscalls.

//go:embed ccbox-fuse-linux-amd64
var FuseAmd64 []byte

//go:embed ccbox-fuse-linux-arm64
var FuseArm64 []byte

// Pre-compiled fakepath.so LD_PRELOAD libraries for Windows path compatibility.
// Intercepts getcwd, open, stat, etc. to translate /d/... <-> D:/...

//go:embed fakepath-linux-amd64.so
var FakepathAmd64 []byte

//go:embed fakepath-linux-arm64.so
var FakepathArm64 []byte

// Source file for in-container source builds if pre-compiled binary
// is incompatible with the target kernel.

//go:embed fakepath.c.txt
var FakepathSource []byte

// Entrypoint script for container initialization and Claude Code launcher.

//go:embed entrypoint.sh
var EntrypointSh []byte
