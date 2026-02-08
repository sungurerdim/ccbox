package cli

import (
	"fmt"
	"os"
	"regexp"
	"strings"

	"github.com/spf13/cobra"
	"github.com/spf13/pflag"

	"github.com/sungur/ccbox/internal/config"
	"github.com/sungur/ccbox/internal/log"
	"github.com/sungur/ccbox/internal/run"
)

// runDefault is the default action when no subcommand is given.
// It determines bridge vs attach mode and delegates to the run pipeline.
func runDefault(cmd *cobra.Command, args []string) error {
	f := cmd.Flags()

	// Apply quiet mode before anything else
	if quiet, _ := f.GetBool("quiet"); quiet {
		log.EnableQuietMode()
	}

	// Change directory if --chdir/-C specified (like git -C)
	if chdir, _ := f.GetString("chdir"); chdir != "" {
		if err := os.Chdir(chdir); err != nil {
			return fmt.Errorf("cannot change to directory %q: %w", chdir, err)
		}
	}

	projectPath, _ := f.GetString("path")

	// Validate user-provided env vars before any work
	envVars, _ := f.GetStringArray("env")
	for _, e := range envVars {
		if err := validateEnvVar(e); err != nil {
			return err
		}
	}

	// Load config file (ccbox.yaml or .ccboxrc)
	fileConfig := config.LoadConfig(projectPath)

	// Collect passthrough args for Claude CLI (unknown flags + args after --)
	claudeArgs := collectClaudeArgs(args)

	// Determine bridge vs attach mode.
	// Bridge is default unless: --attach-mode, --no-bridge, -b (build only), or --headless.
	attachMode, _ := f.GetBool("attach-mode")
	noBridge, _ := f.GetBool("no-bridge")
	buildOnly, _ := f.GetBool("build")
	headless, _ := f.GetBool("headless")

	useBridgeMode := !attachMode && !noBridge && !buildOnly && !headless

	if useBridgeMode {
		return runBridgeMode(cmd, fileConfig, claudeArgs, projectPath)
	}

	return runAttachMode(cmd, fileConfig, claudeArgs, projectPath)
}

// runAttachMode runs the container directly in the current terminal.
// This is the non-bridge (container-only) execution path.
func runAttachMode(cmd *cobra.Command, fileConfig config.CcboxConfig, claudeArgs []string, projectPath string) error {
	f := cmd.Flags()

	// Resolve stack (CLI flag > config file)
	stack, _ := f.GetString("stack")
	if stack == "" && fileConfig.Stack != "" {
		stack = fileConfig.Stack
	}

	// Resolve deps mode (CLI flags > config file > default)
	depsMode := resolveDepsMode(f, fileConfig)

	// Merge env vars: config file + CLI (CLI wins on conflict)
	envVars, _ := f.GetStringArray("env")
	configEnvVars := config.ConfigEnvToArray(fileConfig)
	mergedEnvVars := append(configEnvVars, envVars...)

	// Read all flag values
	buildOnly, _ := f.GetBool("build")
	fresh, _ := f.GetBool("fresh")
	noDebugLogs, _ := f.GetBool("no-debug-logs")
	debug, _ := f.GetCount("debug")
	headless, _ := f.GetBool("headless")
	noPrune, _ := f.GetBool("no-prune")
	unrestricted, _ := f.GetBool("unrestricted")
	verbose, _ := f.GetBool("verbose")
	progress, _ := f.GetString("progress")
	cache, _ := f.GetBool("cache")
	zeroResidue, _ := f.GetBool("zero-residue")
	memory, _ := f.GetString("memory")
	cpus, _ := f.GetString("cpus")
	network, _ := f.GetString("network")
	yes, _ := f.GetBool("yes")

	// Merge CLI flags with config file (CLI takes precedence)
	return run.Execute(run.ExecuteOptions{
		StackName:     stack,
		BuildOnly:     buildOnly,
		ProjectPath:   projectPath,
		Fresh:         fresh || fileConfig.Fresh,
		EphemeralLogs: noDebugLogs,
		DepsMode:      depsMode,
		Debug:         maxInt(debug, fileConfig.Debug),
		Headless:      headless || fileConfig.Headless,
		Unattended:    yes,
		Prune:         !noPrune && boolPtrDefault(fileConfig.Prune, true),
		Unrestricted:  unrestricted || fileConfig.Unrestricted,
		Verbose:       verbose,
		Progress:      firstNonEmpty(progress, fileConfig.Progress),
		Cache:         cache || boolPtrDefault(fileConfig.Cache, false),
		EnvVars:       mergedEnvVars,
		ClaudeArgs:    claudeArgs,
		ZeroResidue:   zeroResidue || fileConfig.ZeroResidue,
		MemoryLimit:   firstNonEmpty(memory, fileConfig.Memory),
		CPULimit:      firstNonEmpty(cpus, fileConfig.CPUs),
		NetworkPolicy: firstNonEmpty(network, fileConfig.NetworkPolicy),
	})
}

// runBridgeMode launches the container in a separate terminal and shows
// the bridge control UI for voice/paste input. Falls back to attach mode
// if the bridge package is not available.
func runBridgeMode(cmd *cobra.Command, fileConfig config.CcboxConfig, claudeArgs []string, projectPath string) error {
	// Build the ccbox args that the bridge will pass to the container terminal
	ccboxArgs := buildCcboxArgsForBridge(cmd, fileConfig, claudeArgs)

	// Try to import and run bridge mode
	// Bridge mode opens a new terminal window for the container and shows
	// a control UI in the current terminal for voice/paste operations.
	//
	// We use a late-binding approach: try to call the bridge package,
	// and fall back to attach mode if it fails or is not compiled in.
	if bridgeRunner != nil {
		return bridgeRunner(projectPath, ccboxArgs)
	}

	// Bridge not available -- fall back to attach mode
	log.Dim("Bridge mode not available, using attach mode")
	return runAttachMode(cmd, fileConfig, claudeArgs, projectPath)
}

// BridgeRunnerFunc is the function signature for the bridge mode runner.
// Set by the bridge package via RegisterBridgeRunner during init.
type BridgeRunnerFunc func(projectPath string, ccboxArgs []string) error

// bridgeRunner holds the registered bridge mode function.
// Nil if bridge mode is not compiled in.
var bridgeRunner BridgeRunnerFunc

// RegisterBridgeRunner registers the bridge mode implementation.
// Called by the bridge package's init() function.
func RegisterBridgeRunner(fn BridgeRunnerFunc) {
	bridgeRunner = fn
}

// buildCcboxArgsForBridge constructs the ccbox CLI arguments that the bridge
// will pass when launching the container terminal. Only includes non-default values.
func buildCcboxArgsForBridge(cmd *cobra.Command, fileConfig config.CcboxConfig, claudeArgs []string) []string {
	var args []string
	f := cmd.Flags()

	// Always add --attach-mode so the child process doesn't recurse into bridge
	args = append(args, "--attach-mode")

	// Stack
	stack, _ := f.GetString("stack")
	if stack == "" && fileConfig.Stack != "" {
		stack = fileConfig.Stack
	}
	if stack != "" {
		args = append(args, "--stack="+stack)
	}

	// Fresh mode
	if fresh, _ := f.GetBool("fresh"); fresh || fileConfig.Fresh {
		args = append(args, "--fresh")
	}

	// Debug level
	debug, _ := f.GetCount("debug")
	d := maxInt(debug, fileConfig.Debug)
	for i := 0; i < d; i++ {
		args = append(args, "-d")
	}

	// Unrestricted
	if unrestricted, _ := f.GetBool("unrestricted"); unrestricted || fileConfig.Unrestricted {
		args = append(args, "--unrestricted")
	}

	// Memory (only if non-default)
	if memory, _ := f.GetString("memory"); memory != "" && memory != "4g" {
		args = append(args, "--memory="+memory)
	}

	// CPU (only if non-default)
	if cpus, _ := f.GetString("cpus"); cpus != "" && cpus != "2.0" {
		args = append(args, "--cpus="+cpus)
	}

	// Zero residue
	if zeroResidue, _ := f.GetBool("zero-residue"); zeroResidue || fileConfig.ZeroResidue {
		args = append(args, "--zero-residue")
	}

	// Network (only if non-default)
	if network, _ := f.GetString("network"); network != "" && network != "full" {
		args = append(args, "--network="+network)
	}

	// Environment variables
	if envVars, _ := f.GetStringArray("env"); len(envVars) > 0 {
		for _, e := range envVars {
			args = append(args, "-e", e)
		}
	}

	// Pass through Claude args
	if len(claudeArgs) > 0 {
		args = append(args, "--")
		args = append(args, claudeArgs...)
	}

	return args
}

// --- Deps mode resolution ---

// resolveDepsMode determines the dependency installation mode from CLI flags
// and config file. CLI flags take precedence over config file.
func resolveDepsMode(f *pflag.FlagSet, fileConfig config.CcboxConfig) string {
	if noDeps, _ := f.GetBool("no-deps"); noDeps {
		return "skip"
	}
	if depsProd, _ := f.GetBool("deps-prod"); depsProd {
		return "prod"
	}
	if fileConfig.Deps != "" {
		return fileConfig.Deps
	}
	return "all"
}

// --- Claude args collection ---

// collectClaudeArgs gathers arguments that should be passed through to Claude CLI.
// Includes cobra's unrecognized positional args and anything after "--".
func collectClaudeArgs(cobraArgs []string) []string {
	var result []string
	result = append(result, cobraArgs...)

	// Also capture anything after "--" from os.Args
	osArgs := os.Args[1:]
	for i, a := range osArgs {
		if a == "--" && i+1 < len(osArgs) {
			result = append(result, osArgs[i+1:]...)
			break
		}
	}

	return result
}

// --- Env var validation ---

// validateEnvVar checks that an environment variable string is in KEY=VALUE format
// with a valid POSIX key: [A-Za-z_][A-Za-z0-9_]*
func validateEnvVar(envVar string) error {
	idx := strings.Index(envVar, "=")
	if idx <= 0 {
		return fmt.Errorf("invalid env var format %q: must be KEY=VALUE", envVar)
	}
	key := envVar[:idx]
	re := regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)
	if !re.MatchString(key) {
		return fmt.Errorf("invalid env var key %q: must match [A-Za-z_][A-Za-z0-9_]*", key)
	}
	return nil
}

// --- Utility helpers ---

// maxInt returns the larger of two integers.
func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}

// firstNonEmpty returns a if non-empty, otherwise b.
func firstNonEmpty(a, b string) string {
	if a != "" {
		return a
	}
	return b
}

// boolPtrDefault dereferences a *bool, returning defaultVal if nil.
// Used for config fields where nil means "not set" (use default).
func boolPtrDefault(ptr *bool, defaultVal bool) bool {
	if ptr == nil {
		return defaultVal
	}
	return *ptr
}
