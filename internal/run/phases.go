package run

import (
	"bufio"
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/sungur/ccbox/internal/config"
	"github.com/sungur/ccbox/internal/detect"
	"github.com/sungur/ccbox/internal/docker"
	"github.com/sungur/ccbox/internal/generate"
	"github.com/sungur/ccbox/internal/log"
	"github.com/sungur/ccbox/internal/paths"
)

// --- Types ---

// ExecuteOptions holds all options for the run pipeline.
type ExecuteOptions struct {
	StackName     string // "" or stack name, "auto" for detection
	BuildOnly     bool
	ProjectPath   string
	Fresh         bool
	EphemeralLogs bool
	DepsMode      string // "all", "prod", "skip"
	Debug         int
	Headless      bool
	Unattended    bool
	Prune         bool
	Unrestricted  bool
	Verbose       bool
	Cache         bool
	EnvVars       []string
	ClaudeArgs    []string
	ZeroResidue   bool
	MemoryLimit   string
	CPULimit      string
	NetworkPolicy string
	Progress      string // Docker build progress mode: "auto", "plain", "tty"
	ReadOnly      bool
	NoPull        bool
	Version       string
}

// DetectionResult holds the outcome of project type detection and stack resolution.
type DetectionResult struct {
	ProjectPath string
	ProjectName string
	Stack       config.LanguageStack
}

// --- Detection ---

// DetectAndReportStack validates the project path, resolves the stack
// (from CLI flag or auto-detection), and logs detection results.
//
// When stackName is empty or "auto", the stack is auto-detected from project
// files. Otherwise, the specified stack name is validated and used directly.
func DetectAndReportStack(path string, stackName string, verbose bool) (*DetectionResult, error) {
	projectPath, err := paths.ValidateProjectPath(path)
	if err != nil {
		return nil, fmt.Errorf("invalid project path: %w", err)
	}

	projectName := filepath.Base(projectPath)

	// Resolve stack from CLI flag or auto-detection
	var stack config.LanguageStack

	if stackName != "" && stackName != "auto" {
		parsed, ok := config.ParseStack(stackName)
		if !ok {
			return nil, fmt.Errorf("invalid stack: %q. Use 'ccbox stacks' to see available options", stackName)
		}
		stack = parsed

		if verbose {
			log.Dim(fmt.Sprintf("Stack: %s (specified)", stack))
		}
	} else {
		// Auto-detect from project files
		stack = detectFromProject(projectPath, verbose)
	}

	return &DetectionResult{
		ProjectPath: projectPath,
		ProjectName: projectName,
		Stack:       stack,
	}, nil
}

// detectFromProject scans project files to determine the best language stack.
// Delegates to the detect package which provides confidence scoring,
// content validation, mutual exclusion, and promotion rules.
// Returns StackBase as the default if no specific language is detected.
func detectFromProject(projectPath string, verbose bool) config.LanguageStack {
	result := detect.DetectProjectType(projectPath, verbose)

	if len(result.DetectedLanguages) > 0 {
		if verbose {
			log.Dim("Detection:")
			for _, d := range result.DetectedLanguages {
				log.Dim(fmt.Sprintf("  %-12s %2d  %s", d.Language, d.Confidence, d.Trigger))
			}
			log.Dim(fmt.Sprintf("  -> Stack: %s", result.RecommendedStack))
		} else {
			summaryParts := make([]string, len(result.DetectedLanguages))
			for i, d := range result.DetectedLanguages {
				summaryParts[i] = fmt.Sprintf("%s (%d)", d.Language, d.Confidence)
			}
			log.Dim(fmt.Sprintf("Detection: %s -> %s",
				strings.Join(summaryParts, ", "), result.RecommendedStack))
		}
	} else if verbose {
		log.Dim(fmt.Sprintf("Detection: no languages found -> %s", config.StackBase))
	}

	return result.RecommendedStack
}

// --- Execute pipeline ---

// Execute runs the full ccbox pipeline: detect -> build -> run.
//
// Pipeline phases:
//  1. Validate project path
//  2. Detect project type (or use specified stack)
//  3. Ensure Docker is running
//  4. Build base image if needed
//  5. Detect dependencies -> build project image if deps found
//  6. Build docker run config
//  7. Run container
//  8. Return exit code
func Execute(opts ExecuteOptions) error {
	// Phase 1: Ensure Docker is available
	if err := checkDockerRunning(); err != nil {
		return fmt.Errorf("check docker: %w", err)
	}

	// Phase 2: Detect project type and resolve stack
	detection, err := DetectAndReportStack(opts.ProjectPath, opts.StackName, opts.Verbose)
	if err != nil {
		return fmt.Errorf("detect project: %w", err)
	}

	stack := detection.Stack

	// Phase 3: Ensure images are built
	if err := ensureImages(string(stack), opts); err != nil {
		return fmt.Errorf("prepare images: %w", err)
	}

	if opts.BuildOnly {
		log.Success("Build complete")
		return nil
	}

	// Phase 4: Build docker run config
	runOpts := RunOptions{
		Fresh:         opts.Fresh,
		EphemeralLogs: opts.EphemeralLogs,
		Debug:         opts.Debug,
		Headless:      opts.Headless,
		Unrestricted:  opts.Unrestricted,
		EnvVars:       opts.EnvVars,
		ClaudeArgs:    opts.ClaudeArgs,
		ZeroResidue:   opts.ZeroResidue,
		MemoryLimit:   opts.MemoryLimit,
		CPULimit:      opts.CPULimit,
		NetworkPolicy: opts.NetworkPolicy,
		ReadOnly:      opts.ReadOnly,
	}

	runConfig, err := BuildDockerRunConfig(
		detection.ProjectPath,
		detection.ProjectName,
		stack,
		runOpts,
	)
	if err != nil {
		return fmt.Errorf("failed to build docker run config: %w", err)
	}

	// Phase 5: Run container
	return executeContainer(runConfig, detection.ProjectName, opts.Debug, opts.Headless, opts.MemoryLimit)
}

// --- Docker operations ---

// checkDockerRunning verifies that the Docker daemon is available.
func checkDockerRunning() error {
	ctx, cancel := context.WithTimeout(context.Background(), config.DockerCommandTimeout)
	defer cancel()

	if err := docker.EnsureRunning(ctx, config.DockerStartupTimeout); err != nil {
		return fmt.Errorf("Docker is not running. Start Docker and try again")
	}
	return nil
}

// ensureImages ensures the stack image exists locally, trying pull then build.
func ensureImages(stack string, opts ExecuteOptions) error {
	// Check if stack image exists
	imageName := config.GetImageName(stack)
	if imageExists(imageName) {
		return nil
	}

	// Try pulling pre-built image first (unless --no-pull)
	if !opts.NoPull {
		version := opts.Version
		if version == "" {
			version = "latest"
		}
		if pullImage(stack, imageName, version, opts.Progress) {
			return nil
		}
	}

	// Fallback: build locally
	// Check if base image exists (required for most stacks)
	dep := config.StackDependencies[config.LanguageStack(stack)]
	if dep != "" {
		baseImage := config.GetImageName(string(dep))
		if !imageExists(baseImage) {
			if !opts.NoPull {
				version := opts.Version
				if version == "" {
					version = "latest"
				}
				pullImage(string(dep), baseImage, version, opts.Progress)
			}
			if !imageExists(baseImage) {
				log.Bold("First-time setup: building base image...")
				if err := buildImage(string(dep), opts.Cache, opts.Progress); err != nil {
					return fmt.Errorf("failed to build base image: %w", err)
				}
				log.Newline()
			}
		}
	}

	// Build stack image
	log.Bold(fmt.Sprintf("Building %s image...", stack))
	if err := buildImage(stack, opts.Cache, opts.Progress); err != nil {
		return fmt.Errorf("failed to build %s image: %w", stack, err)
	}
	log.Newline()

	return nil
}

// pullImage attempts to pull a pre-built image from the registry and tag it locally.
// Returns true if the pull and tag succeeded.
func pullImage(stack, localName, version, progress string) bool {
	ref := config.RegistryImageName(stack, version)
	log.Dim("Pulling " + ref + "...")

	ctx, cancel := context.WithTimeout(context.Background(), config.DockerBuildTimeout)
	defer cancel()

	if err := docker.Pull(ctx, ref, progress); err != nil {
		log.Debugf("Pull failed: %v", err)
		return false
	}
	if err := docker.Tag(ctx, ref, localName); err != nil {
		log.Debugf("Tag failed: %v", err)
		return false
	}
	log.Dim("Using pre-built image: " + ref)
	return true
}

// imageExists checks if a Docker image exists locally.
func imageExists(imageName string) bool {
	ctx, cancel := context.WithTimeout(context.Background(), config.DockerCommandTimeout)
	defer cancel()

	return docker.Exists(ctx, imageName)
}

// buildImage builds a Docker image for the given stack.
func buildImage(stack string, cache bool, progress string) error {
	buildDir, err := generate.WriteBuildFiles(config.LanguageStack(stack))
	if err != nil {
		return fmt.Errorf("generate build files: %w", err)
	}

	imageName := config.GetImageName(stack)

	ctx, cancel := context.WithTimeout(context.Background(), config.DockerBuildTimeout)
	defer cancel()

	return docker.Build(ctx, buildDir, imageName, docker.BuildOptions{
		NoCache:  !cache,
		Progress: progress,
	})
}

// executeContainer runs the Docker container with the given configuration
// and handles exit codes and diagnostics.
//
// Design decision: This uses exec.Command("docker", ...) instead of the Docker
// SDK's container.Run API. The SDK approach (used for builds, listing, cleanup)
// requires manual TTY/pty setup and raw terminal mode management, while
// exec.Command inherits the host's terminal directly — giving correct TTY
// pass-through, signal propagation, and window resize handling for free.
// The SDK is used everywhere else where programmatic control matters more
// than terminal fidelity (build output, container inspection, exec).
func executeContainer(runConfig *DockerRunConfig, projectName string, debug int, headless bool, memoryLimit string) error {
	log.Dim("Starting Claude Code...")
	log.Newline()

	if debug >= 2 {
		log.Dim("Docker command: docker " + strings.Join(runConfig.Args, " "))
	}

	cmd := exec.Command("docker", runConfig.Args...)
	cmd.Env = runConfig.Env

	// stdin: inherit for interactive, nil for headless/watch-only (-dd)
	if headless || debug >= 2 {
		cmd.Stdin = nil
	} else {
		cmd.Stdin = os.Stdin
	}

	cmd.Stdout = os.Stdout

	// Filter Docker warnings from stderr
	stderrPipe, err := cmd.StderrPipe()
	if err != nil {
		cmd.Stderr = os.Stderr
	}

	if startErr := cmd.Start(); startErr != nil {
		return fmt.Errorf("failed to start container: %w", startErr)
	}

	// Filter stderr in a goroutine if pipe was created
	if err == nil {
		go func() {
			scanner := bufio.NewScanner(stderrPipe)
			for scanner.Scan() {
				line := scanner.Text()
				if !strings.HasPrefix(line, "WARNING:") {
					fmt.Fprintln(os.Stderr, line)
				}
			}
		}()
	}

	waitErr := cmd.Wait()
	exitCode := 0
	if waitErr != nil {
		if exitErr, ok := waitErr.(*exec.ExitError); ok {
			exitCode = exitErr.ExitCode()
		} else {
			return fmt.Errorf("container execution error: %w", waitErr)
		}
	}

	// Handle exit codes
	switch exitCode {
	case 0:
		return nil
	case 130:
		// Ctrl+C -- normal user interruption
		return nil
	case 137:
		memLimit := memoryLimit
		if memLimit == "" {
			memLimit = config.DefaultMemoryLimit
		}
		log.Warn(fmt.Sprintf("Container was killed (OOM or manual stop, limit: %s)", memLimit))
		log.Dim("Try: ccbox --unrestricted (removes memory limits)")
	case 139:
		log.Warn("Container crashed (segmentation fault)")
	case 143:
		// SIGTERM -- normal shutdown via quit/stop, no message needed
		return nil
	default:
		log.Warnf("Container exited with code %d", exitCode)
		log.Dim("Try: ccbox --debug for more information")
	}

	os.Exit(exitCode)
	return nil // unreachable, but satisfies compiler
}

// --- Prune ---

// PruneStaleResources removes old containers and build cache.
func PruneStaleResources(debug bool) {
	ctx, cancel := context.WithTimeout(context.Background(), config.PruneTimeout)
	defer cancel()

	// Remove stopped ccbox containers
	if _, err := docker.PruneContainers(ctx); err != nil {
		log.Debugf("Prune containers: %v", err)
	}

	// Prune build cache older than configured age
	if err := docker.PruneBuilder(ctx, config.PruneCacheAge); err != nil {
		log.Debugf("Prune build cache: %v", err)
	}

	if debug {
		log.Debug("Pruned stale Docker resources")
	}
}

// CleanOrphanedBuildDirs removes leftover build directories in the temp folder.
func CleanOrphanedBuildDirs() {
	buildBase := config.GetCcboxTempBuild("")
	entries, err := os.ReadDir(buildBase)
	if err != nil {
		return
	}

	cutoff := time.Now().Add(-24 * time.Hour)
	for _, entry := range entries {
		info, err := entry.Info()
		if err != nil {
			continue
		}
		if info.ModTime().Before(cutoff) {
			_ = os.RemoveAll(filepath.Join(buildBase, entry.Name()))
		}
	}
}
