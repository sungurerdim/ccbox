package cli

import (
	"fmt"
	"os"
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
		return runBridgeMode(cmd, claudeArgs, projectPath, fileConfig)
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
	cache, _ := f.GetBool("cache")
	zeroResidue, _ := f.GetBool("zero-residue")
	readOnly, _ := f.GetBool("read-only")
	noPull, _ := f.GetBool("no-pull")
	yes, _ := f.GetBool("yes")

	// String flags with non-empty defaults: prefer CLI only if explicitly set,
	// otherwise fall back to config file, then flag default.
	memory := resolveStringFlag(f, "memory", fileConfig.Memory)
	cpus := resolveStringFlag(f, "cpus", fileConfig.CPUs)
	network := resolveStringFlag(f, "network", fileConfig.NetworkPolicy)
	progress := resolveStringFlag(f, "progress", fileConfig.Progress)

	// Merge CLI flags with config file (CLI takes precedence)
	return run.Execute(run.ExecuteOptions{
		StackName:     stack,
		BuildOnly:     buildOnly,
		ProjectPath:   projectPath,
		Fresh:         fresh || boolPtrDefault(fileConfig.Fresh, false),
		EphemeralLogs: noDebugLogs,
		DepsMode:      depsMode,
		Debug:         max(debug, fileConfig.Debug),
		Headless:      headless || boolPtrDefault(fileConfig.Headless, false),
		Unattended:    yes,
		Prune:         !noPrune && boolPtrDefault(fileConfig.Prune, true),
		Unrestricted:  unrestricted || boolPtrDefault(fileConfig.Unrestricted, false),
		Verbose:       verbose,
		Cache:         cache || boolPtrDefault(fileConfig.Cache, false),
		EnvVars:       mergedEnvVars,
		ClaudeArgs:    claudeArgs,
		ZeroResidue:   zeroResidue || boolPtrDefault(fileConfig.ZeroResidue, false),
		ReadOnly:      readOnly || boolPtrDefault(fileConfig.ReadOnly, false),
		NoPull:        noPull,
		MemoryLimit:   memory,
		CPULimit:      cpus,
		NetworkPolicy: network,
		Progress:      progress,
	})
}

// runBridgeMode launches the container in a separate terminal and shows
// the bridge control UI for voice/paste input. Falls back to attach mode
// if the bridge package is not available.
func runBridgeMode(cmd *cobra.Command, claudeArgs []string, projectPath string, fileConfig config.CcboxConfig) error {
	// Build the ccbox args that the bridge will pass to the container terminal.
	// Uses dynamic flag forwarding — only ccbox-bridge-specific flags are excluded.
	ccboxArgs := buildCcboxArgsForBridge(cmd, claudeArgs)

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

// bridgeExcludeFlags lists flags that should NOT be forwarded to child containers.
// These are bridge-specific or already handled by the launch mechanism.
// All other explicitly-set flags are forwarded automatically — no hardcoded list
// to maintain when new flags are added.
var bridgeExcludeFlags = map[string]bool{
	"attach-mode": true, // added by launchNewContainer
	"no-bridge":   true, // bridge-specific, child always runs attach
	"build":       true, // build-only mode, child needs to run
	"headless":    true, // prevents bridge; child runs interactively
	"path":        true, // passed separately by launchNewContainer
	"chdir":       true, // already applied in parent process
	"quiet":       true, // parent terminal only
	"no-pull":     true, // build-time only, not relevant for child container
}

// buildCcboxArgsForBridge constructs the ccbox CLI arguments that the bridge
// will pass when launching the container terminal. Dynamically forwards all
// explicitly-set flags except bridge-specific ones. The child process loads
// its own config file from --path, so config-file values don't need forwarding.
func buildCcboxArgsForBridge(cmd *cobra.Command, claudeArgs []string) []string {
	var args []string

	cmd.Flags().Visit(func(fl *pflag.Flag) {
		if bridgeExcludeFlags[fl.Name] {
			return
		}

		switch fl.Value.Type() {
		case "bool":
			if fl.Value.String() == "true" {
				args = append(args, "--"+fl.Name)
			}
		case "count":
			count, _ := cmd.Flags().GetCount(fl.Name)
			for i := 0; i < count; i++ {
				args = append(args, "--"+fl.Name)
			}
		case "stringArray":
			vals, _ := cmd.Flags().GetStringArray(fl.Name)
			for _, v := range vals {
				args = append(args, "--"+fl.Name, v)
			}
		default: // string, int, etc.
			args = append(args, "--"+fl.Name+"="+fl.Value.String())
		}
	})

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
	if !run.EnvVarKeyRe.MatchString(key) {
		return fmt.Errorf("invalid env var key %q: must match [A-Za-z_][A-Za-z0-9_]*", key)
	}
	return nil
}

// --- Utility helpers ---

// boolPtrDefault dereferences a *bool, returning defaultVal if nil.
// Used for config fields where nil means "not set" (use default).
func boolPtrDefault(ptr *bool, defaultVal bool) bool {
	if ptr == nil {
		return defaultVal
	}
	return *ptr
}

// resolveStringFlag returns the CLI flag value if explicitly set by the user,
// otherwise the config file value if non-empty, otherwise the flag default.
// This prevents flags with non-empty defaults (e.g., --memory "4g") from
// always shadowing config file values.
func resolveStringFlag(f *pflag.FlagSet, name string, configValue string) string {
	if f.Changed(name) {
		val, _ := f.GetString(name)
		return val
	}
	if configValue != "" {
		return configValue
	}
	val, _ := f.GetString(name)
	return val
}
