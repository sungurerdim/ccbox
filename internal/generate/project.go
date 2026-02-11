package generate

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/sungur/ccbox/internal/detect"
)

// guardedBinaries is the set of runtime binaries that get a "which" guard
// so they gracefully skip when the stack doesn't include that runtime.
var guardedBinaries = map[string]bool{
	"python3": true, "pip": true, "poetry": true, "pdm": true, "uv": true, "conda": true, "pipenv": true,
	"npm": true, "npx": true, "yarn": true, "pnpm": true, "bun": true, "bunx": true, "deno": true,
	"go": true, "cargo": true, "dotnet": true, "nuget": true, "mix": true, "rebar3": true, "gleam": true,
	"stack": true, "cabal": true, "swift": true, "dart": true, "flutter": true, "julia": true,
	"lein": true, "clojure": true, "zig": true, "nimble": true, "opam": true, "cpanm": true,
	"conan": true, "vcpkg": true, "luarocks": true, "Rscript": true,
	"gem": true, "bundle": true, "bundler": true, "composer": true, "mvn": true, "gradle": true, "sbt": true,
}

// GenerateProjectDockerfile generates a project-specific Dockerfile with dependencies.
func GenerateProjectDockerfile(baseImage string, depsList []detect.DepsInfo, depsMode detect.DepsMode, projectPath string) string {
	var lines []string
	lines = append(lines,
		"# Project-specific image with dependencies",
		fmt.Sprintf("FROM %s", baseImage),
		"",
		"USER root",
		"WORKDIR /tmp/deps",
		"",
	)

	// Collect candidate dependency files
	candidateFiles := make(map[string]bool)
	for _, deps := range depsList {
		for _, f := range deps.Files {
			if !strings.Contains(f, "*") {
				candidateFiles[f] = true
			}
		}
	}

	// Add common dependency files
	commonFiles := []string{
		"pyproject.toml", "setup.py", "setup.cfg",
		"package.json", "package-lock.json", "yarn.lock", "pnpm-lock.yaml",
		"go.mod", "go.sum",
		"Cargo.toml", "Cargo.lock",
		"Gemfile", "Gemfile.lock",
		"composer.json", "composer.lock",
	}
	for _, f := range commonFiles {
		candidateFiles[f] = true
	}

	// Filter to only files that actually exist
	var existingFiles []string
	for f := range candidateFiles {
		if _, err := os.Stat(filepath.Join(projectPath, f)); err == nil {
			existingFiles = append(existingFiles, f)
		}
	}
	sort.Strings(existingFiles)

	// Copy only existing dependency files
	if len(existingFiles) > 0 {
		lines = append(lines, "# Copy dependency files")
		for _, f := range existingFiles {
			lines = append(lines, fmt.Sprintf("COPY %s ./", f))
		}
	}

	lines = append(lines, "")

	// Get install commands
	installCmds := detect.GetInstallCommands(depsList, depsMode)

	if len(installCmds) > 0 {
		lines = append(lines, "# Install dependencies (skip if runtime not available in stack)")
		for _, cmd := range installCmds {
			// Extract the binary name from the command
			binary := extractBinaryName(cmd)
			if guardedBinaries[binary] {
				lines = append(lines, fmt.Sprintf(`RUN which %s >/dev/null 2>&1 && %s || echo "Skipping %s (not in stack)"`, binary, cmd, binary))
			} else {
				lines = append(lines, fmt.Sprintf("RUN %s", cmd))
			}
		}
	}

	lines = append(lines,
		"",
		"# Return to project directory (entrypoint will handle user switching via gosu)",
		"WORKDIR /ccbox",
		"",
	)

	return strings.Join(lines, "\n")
}

// extractBinaryName extracts the first binary/command name from a shell command string.
func extractBinaryName(cmd string) string {
	// Split on whitespace and shell operators
	for i, ch := range cmd {
		if ch == ' ' || ch == '|' || ch == '&' || ch == ';' || ch == '>' {
			return strings.TrimSpace(cmd[:i])
		}
	}
	return strings.TrimSpace(cmd)
}
