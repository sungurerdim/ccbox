// Package generate provides Dockerfile and build file generation for ccbox.
package generate

import "github.com/sungur/ccbox/embedded"

// GenerateEntrypoint returns the embedded entrypoint.sh content.
// The entrypoint script handles container initialization, user setup,
// FUSE path translation, git configuration, and Claude Code launch.
func GenerateEntrypoint() string {
	return string(embedded.EntrypointSh)
}
