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
	Progress      string
	Cache         bool
	EnvVars       []string
	ClaudeArgs    []string
	ZeroResidue   bool
	MemoryLimit   string
	CPULimit      string
	NetworkPolicy string
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
// Returns StackBase as the default if no specific language is detected.
func detectFromProject(projectPath string, verbose bool) config.LanguageStack {
	type detection struct {
		language   string
		stack      config.LanguageStack
		confidence int
		trigger    string
	}

	var detections []detection

	// Detection rules: check for language-specific files/patterns
	checks := []struct {
		files    []string
		language string
		stack    config.LanguageStack
		conf     int
	}{
		{[]string{"go.mod", "go.sum"}, "Go", config.StackGo, 9},
		{[]string{"Cargo.toml", "Cargo.lock"}, "Rust", config.StackRust, 9},
		{[]string{"package.json"}, "JavaScript/TypeScript", config.StackWeb, 7},
		{[]string{"tsconfig.json"}, "TypeScript", config.StackWeb, 8},
		{[]string{"pyproject.toml", "setup.py", "requirements.txt", "Pipfile"}, "Python", config.StackPython, 7},
		{[]string{"pom.xml", "build.gradle", "build.gradle.kts"}, "Java", config.StackJava, 8},
		{[]string{"CMakeLists.txt", "Makefile.am", "meson.build"}, "C/C++", config.StackCpp, 7},
		{[]string{"*.csproj", "*.sln", "*.fsproj"}, "C#/.NET", config.StackDotnet, 8},
		{[]string{"Package.swift"}, "Swift", config.StackSwift, 8},
		{[]string{"pubspec.yaml"}, "Dart", config.StackDart, 8},
		{[]string{"*.lua", "rockspec"}, "Lua", config.StackLua, 5},
		{[]string{"build.sbt", "project/build.properties"}, "Scala", config.StackJVM, 8},
		{[]string{"mix.exs"}, "Elixir", config.StackFunctional, 8},
		{[]string{"Gemfile", "*.gemspec"}, "Ruby", config.StackScripting, 7},
		{[]string{"composer.json"}, "PHP", config.StackScripting, 7},
		{[]string{"*.R", "DESCRIPTION"}, "R", config.StackData, 6},
		{[]string{"Project.toml"}, "Julia", config.StackData, 7},
		{[]string{"Dockerfile", "docker-compose.yml", "docker-compose.yaml"}, "Docker", config.StackBase, 3},
	}

	for _, check := range checks {
		for _, pattern := range check.files {
			matches, err := filepath.Glob(filepath.Join(projectPath, pattern))
			if err != nil {
				continue
			}
			if len(matches) > 0 {
				trigger := filepath.Base(matches[0])
				detections = append(detections, detection{
					language:   check.language,
					stack:      check.stack,
					confidence: check.conf,
					trigger:    trigger,
				})
				break // One match per check group is enough
			}
		}
	}

	// Report detection results
	if len(detections) > 0 {
		if verbose {
			log.Dim("Detection:")
			for _, d := range detections {
				log.Dim(fmt.Sprintf("  %-12s %2d  %s", d.language, d.confidence, d.trigger))
			}
		}

		// Pick highest confidence
		best := detections[0]
		for _, d := range detections[1:] {
			if d.confidence > best.confidence {
				best = d
			}
		}

		if verbose {
			log.Dim(fmt.Sprintf("  -> Stack: %s", best.stack))
		} else {
			summaryParts := make([]string, len(detections))
			for i, d := range detections {
				summaryParts[i] = fmt.Sprintf("%s (%d)", d.language, d.confidence)
			}
			log.Dim(fmt.Sprintf("Detection: %s -> %s", strings.Join(summaryParts, ", "), best.stack))
		}

		return best.stack
	}

	if verbose {
		log.Dim(fmt.Sprintf("Detection: no languages found -> %s", config.StackBase))
	}

	return config.StackBase
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
		return err
	}

	// Phase 2: Detect project type and resolve stack
	detection, err := DetectAndReportStack(opts.ProjectPath, opts.StackName, opts.Verbose)
	if err != nil {
		return err
	}

	stack := detection.Stack

	// Phase 3: Ensure images are built
	if err := ensureImages(string(stack), opts); err != nil {
		return err
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
	return executeContainer(runConfig, detection.ProjectName, opts.Debug, opts.Headless)
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

// ensureImages builds base and stack images if they don't exist.
func ensureImages(stack string, opts ExecuteOptions) error {
	// Check if stack image exists
	imageName := config.GetImageName(stack)
	if imageExists(imageName) {
		return nil
	}

	// Check if base image exists (required for most stacks)
	dep := config.StackDependencies[config.LanguageStack(stack)]
	if dep != "" {
		baseImage := config.GetImageName(string(dep))
		if !imageExists(baseImage) {
			log.Bold("First-time setup: building base image...")
			if err := buildImage(string(dep), opts.Progress, opts.Cache); err != nil {
				return fmt.Errorf("failed to build base image: %w", err)
			}
			log.Newline()
		}
	}

	// Build stack image
	log.Bold(fmt.Sprintf("Building %s image...", stack))
	if err := buildImage(stack, opts.Progress, opts.Cache); err != nil {
		return fmt.Errorf("failed to build %s image: %w", stack, err)
	}
	log.Newline()

	return nil
}

// imageExists checks if a Docker image exists locally.
func imageExists(imageName string) bool {
	ctx, cancel := context.WithTimeout(context.Background(), config.DockerCommandTimeout)
	defer cancel()

	return docker.Exists(ctx, imageName)
}

// buildImage builds a Docker image for the given stack.
func buildImage(stack string, _ string, cache bool) error {
	buildDir, err := generate.WriteBuildFiles(config.LanguageStack(stack))
	if err != nil {
		return fmt.Errorf("generate build files: %w", err)
	}

	imageName := config.GetImageName(stack)

	ctx, cancel := context.WithTimeout(context.Background(), config.DockerBuildTimeout)
	defer cancel()

	return docker.Build(ctx, buildDir, imageName, docker.BuildOptions{
		NoCache: !cache,
	})
}

// executeContainer runs the Docker container with the given configuration
// and handles exit codes and diagnostics.
func executeContainer(runConfig *DockerRunConfig, projectName string, debug int, headless bool) error {
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
		memLimit := config.DefaultMemoryLimit
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
	_, _ = docker.PruneContainers(ctx)

	// Prune build cache older than configured age
	_ = docker.PruneBuilder(ctx, config.PruneCacheAge)

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
