package generate

import (
	"os"
	"path/filepath"

	"github.com/sungur/ccbox/embedded"
	"github.com/sungur/ccbox/internal/config"
)

// WriteBuildFiles writes Dockerfile, entrypoint, and native binaries
// to a temporary build directory for Docker image building.
// Returns the build directory path.
func WriteBuildFiles(stack config.LanguageStack) (string, error) {
	buildDir := config.GetCcboxTempBuild(string(stack))
	if err := os.MkdirAll(buildDir, 0o755); err != nil {
		return "", err
	}

	// Generate and write Dockerfile (Unix line endings)
	dockerfile := GenerateDockerfile(stack)
	if err := os.WriteFile(filepath.Join(buildDir, "Dockerfile"), []byte(dockerfile), 0o644); err != nil {
		return "", err
	}

	// Generate and write entrypoint.sh
	entrypoint := GenerateEntrypoint()
	if err := os.WriteFile(filepath.Join(buildDir, "entrypoint.sh"), []byte(entrypoint), 0o755); err != nil {
		return "", err
	}

	// Write pre-compiled FUSE binaries (both architectures, Docker selects at build time)
	if err := os.WriteFile(filepath.Join(buildDir, "ccbox-fuse-amd64"), embedded.FuseAmd64, 0o755); err != nil {
		return "", err
	}
	if err := os.WriteFile(filepath.Join(buildDir, "ccbox-fuse-arm64"), embedded.FuseArm64, 0o755); err != nil {
		return "", err
	}

	// Write architecture selector script
	archSelector := `#!/bin/sh
# Select correct binary based on architecture
ARCH=${TARGETARCH:-amd64}
if [ "$ARCH" = "arm64" ]; then
  cp /tmp/ccbox-fuse-arm64 /usr/local/bin/ccbox-fuse
else
  cp /tmp/ccbox-fuse-amd64 /usr/local/bin/ccbox-fuse
fi
chmod 755 /usr/local/bin/ccbox-fuse
`
	if err := os.WriteFile(filepath.Join(buildDir, "install-fuse.sh"), []byte(archSelector), 0o755); err != nil {
		return "", err
	}

	// Write pre-compiled fakepath.so binaries
	if err := os.WriteFile(filepath.Join(buildDir, "fakepath-amd64.so"), embedded.FakepathAmd64, 0o755); err != nil {
		return "", err
	}
	if err := os.WriteFile(filepath.Join(buildDir, "fakepath-arm64.so"), embedded.FakepathArm64, 0o755); err != nil {
		return "", err
	}

	// Write fakepath.c source for in-container source builds if needed
	if err := os.WriteFile(filepath.Join(buildDir, "fakepath.c"), embedded.FakepathSource, 0o644); err != nil {
		return "", err
	}

	return buildDir, nil
}
