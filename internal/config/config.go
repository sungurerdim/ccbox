// Package config provides configuration types, constants, and utilities for ccbox.
package config

import (
	"crypto/rand"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// --- CcboxConfig ---

// CcboxConfig represents the ccbox configuration model.
// All fields are optional (zero value = not set). CLI flags take precedence.
type CcboxConfig struct {
	// Stack selection
	Stack string `yaml:"stack,omitempty"`

	// Dependencies
	Deps string `yaml:"deps,omitempty"` // "all", "prod", or "skip"

	// Security
	ZeroResidue   *bool  `yaml:"zeroResidue,omitempty"`
	NetworkPolicy string `yaml:"networkPolicy,omitempty"` // "full", "isolated", or path to policy.json

	// Resource limits
	Memory string `yaml:"memory,omitempty"`
	CPUs   string `yaml:"cpus,omitempty"`

	// Docker
	Progress string `yaml:"progress,omitempty"` // "auto", "plain", or "tty"
	Cache    *bool  `yaml:"cache,omitempty"`    // pointer to distinguish unset from false
	Prune    *bool  `yaml:"prune,omitempty"`    // pointer to distinguish unset from false

	// Behavior
	Fresh        *bool `yaml:"fresh,omitempty"`
	Headless     *bool `yaml:"headless,omitempty"`
	Unrestricted *bool `yaml:"unrestricted,omitempty"`
	ReadOnly     *bool `yaml:"readOnly,omitempty"`
	Debug        int   `yaml:"debug,omitempty"`

	// Environment variables
	Env map[string]string `yaml:"env,omitempty"`
}

// --- Docker Timeouts ---

const (
	// DockerCommandTimeout is the timeout for quick docker commands (info, inspect, ps).
	DockerCommandTimeout = 30 * time.Second
	// DockerBuildTimeout is the timeout for image builds (10 minutes).
	DockerBuildTimeout = 600 * time.Second
	// DockerStartupTimeout is the timeout for waiting for Docker daemon to start.
	DockerStartupTimeout = 30 * time.Second
	// DockerCheckInterval is the interval between Docker status checks.
	DockerCheckInterval = 5 * time.Second
	// PruneTimeout is the timeout for prune operations.
	PruneTimeout = 60 * time.Second
)

// --- Prune Settings ---

const (
	// PruneCacheAge is the Docker build cache age threshold for pruning (7 days).
	PruneCacheAge = "168h"
)

// --- CCBOX Naming ---

const (
	// CcboxPrefix is the prefix used for all ccbox Docker resources.
	CcboxPrefix = "ccbox"

	// Docker container labels for ccbox resource identification.
	LabelStack   = "ccbox.stack"
	LabelProject = "ccbox.project"
)

// --- Path Constants ---

const (
	// ClaudeHostDir is the Claude config directory on the host (expandable).
	ClaudeHostDir = "~/.claude"
	// ContainerUser is the username inside the container.
	ContainerUser = "ccbox"
	// ContainerHome is the container home/base directory.
	ContainerHome = "/ccbox"
	// ContainerProjectDir is the project base directory inside the container.
	ContainerProjectDir = "/ccbox"
	// ContainerClaudeDir is the Claude config directory inside the container.
	ContainerClaudeDir = "/ccbox/.claude"
	// ContainerTmpDir is the tmpfs mount point inside the container.
	ContainerTmpDir = "/tmp"
	// BuildDir is the base directory for all Docker builds.
	BuildDir = "/tmp/ccbox/build"
)

// --- Tmpfs Configuration ---

const (
	// TmpfsSize is the default tmpfs size for /tmp.
	TmpfsSize = "64m"
	// TmpfsMode is the tmpfs permissions (sticky bit).
	TmpfsMode = "1777"
)

// --- Resource Limits ---

const (
	// DefaultPidsLimit is the process limit per container (fork bomb protection).
	DefaultPidsLimit = 2048
	// DefaultMemoryLimit is the default container memory limit.
	DefaultMemoryLimit = "4g"
	// DefaultCPULimit is the default container CPU limit.
	DefaultCPULimit = "2.0"
)

// --- CCBOX Environment Variables (SSOT for names) ---

// Env holds all ccbox environment variable names as constants.
var Env = struct {
	// Container configuration
	UID             string
	GID             string
	Debug           string
	Unrestricted    string
	MinimalMount    string
	PersistentPaths string
	ZeroResidue     string
	// Path mapping
	PathMap         string
	DirMap          string
	WinOriginalPath string
	// Resource limits
	PidsLimit   string
	TmpSize     string
	ShmSize     string
	MemoryLimit string
	CPULimit    string
	// Network isolation
	NetworkPolicy string
}{
	UID:             "CCBOX_UID",
	GID:             "CCBOX_GID",
	Debug:           "CCBOX_DEBUG",
	Unrestricted:    "CCBOX_UNRESTRICTED",
	MinimalMount:    "CCBOX_MINIMAL_MOUNT",
	PersistentPaths: "CCBOX_PERSISTENT_PATHS",
	ZeroResidue:     "CCBOX_ZERO_RESIDUE",
	PathMap:         "CCBOX_PATH_MAP",
	DirMap:          "CCBOX_DIR_MAP",
	WinOriginalPath: "CCBOX_WIN_ORIGINAL_PATH",
	PidsLimit:       "CCBOX_PIDS_LIMIT",
	TmpSize:         "CCBOX_TMP_SIZE",
	ShmSize:         "CCBOX_SHM_SIZE",
	MemoryLimit:     "CCBOX_MEMORY_LIMIT",
	CPULimit:        "CCBOX_CPU_LIMIT",
	NetworkPolicy:   "CCBOX_NETWORK_POLICY",
}

// --- Registry ---

// DefaultRegistry is the default container registry for pre-built ccbox images.
const DefaultRegistry = "ghcr.io/sungur/ccbox"

// RegistryImageName returns the fully qualified image reference for a stack.
func RegistryImageName(stack, version string) string {
	return fmt.Sprintf("%s/%s:%s", registryBase(), stack, version)
}

// registryRe validates registry format: host/path or host:port/path (no scheme).
var registryRe = regexp.MustCompile(`^[a-zA-Z0-9]([a-zA-Z0-9._-]*[a-zA-Z0-9])?(:[0-9]+)?(/[a-zA-Z0-9._/-]+)?$`)

// registryBase returns the registry base URL, allowing override via CCBOX_REGISTRY.
// Validates the override to prevent supply chain attacks via malicious registry URLs.
func registryBase() string {
	v := os.Getenv("CCBOX_REGISTRY")
	if v == "" {
		return DefaultRegistry
	}
	if !validateRegistry(v) {
		return DefaultRegistry
	}
	return v
}

// validateRegistry checks that a registry value is a valid Docker registry reference.
func validateRegistry(registry string) bool {
	// Reject URLs with scheme (Docker registries don't use scheme prefix)
	if strings.Contains(registry, "://") {
		return false
	}
	// Reject empty or whitespace-only
	if strings.TrimSpace(registry) == "" {
		return false
	}
	// Parse as URL to catch injection attempts
	if _, err := url.Parse("https://" + registry); err != nil {
		return false
	}
	// Must match Docker registry format
	return registryRe.MatchString(registry)
}

// --- Temp Paths ---

// GetCcboxTempDir returns the base temp directory for ccbox.
func GetCcboxTempDir() string {
	return filepath.Join(os.TempDir(), CcboxPrefix)
}

// GetCcboxTempBuild returns the temp directory for Docker builds.
// If subdir is non-empty, it is appended to the build path.
func GetCcboxTempBuild(subdir string) string {
	base := filepath.Join(GetCcboxTempDir(), "build")
	if subdir != "" {
		return filepath.Join(base, subdir)
	}
	return base
}

// GetCcboxTempClipboard returns the temp directory for clipboard operations.
func GetCcboxTempClipboard() string {
	return filepath.Join(GetCcboxTempDir(), "clipboard")
}

// GetCcboxTempVoice returns the temp directory for voice operations.
func GetCcboxTempVoice() string {
	return filepath.Join(GetCcboxTempDir(), "voice")
}

// --- Container/Image Naming ---

// safeNameRe matches characters not allowed in Docker container names.
var safeNameRe = regexp.MustCompile(`[^a-z0-9_-]`)
var multiHyphenRe = regexp.MustCompile(`-{2,}`)

// GetContainerName generates a Docker container name for a project.
// If unique is true, a random 6-character suffix is appended.
func GetContainerName(projectName string, unique bool) string {
	const maxProjectNameLength = 50

	safeName := strings.ToLower(projectName)
	safeName = safeNameRe.ReplaceAllString(safeName, "-")
	safeName = multiHyphenRe.ReplaceAllString(safeName, "-")
	safeName = strings.Trim(safeName, "-")

	if len(safeName) > maxProjectNameLength {
		safeName = safeName[:maxProjectNameLength]
		safeName = strings.TrimRight(safeName, "-")
	}

	if safeName == "" {
		safeName = "project"
	}

	if unique {
		suffix := randomHex(6)
		return fmt.Sprintf("ccbox_%s_%s", safeName, suffix)
	}
	return fmt.Sprintf("ccbox_%s", safeName)
}

// GetImageName returns the Docker image name for a language stack.
func GetImageName(stack string) string {
	return fmt.Sprintf("ccbox_%s:latest", stack)
}

// randomHex generates a random hex string of the specified length.
func randomHex(length int) string {
	b := make([]byte, (length+1)/2)
	_, _ = rand.Read(b)
	hex := fmt.Sprintf("%x", b)
	if len(hex) > length {
		hex = hex[:length]
	}
	return hex
}
