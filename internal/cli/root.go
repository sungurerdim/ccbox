// Package cli defines the ccbox command-line interface using cobra.
//
// The root command IS the run command -- running "ccbox" in a project directory
// detects the language stack, builds images, and launches Claude Code in a
// container. Subcommands (clean, rebuild, stacks, etc.) are registered separately.
package cli

import (
	"os"

	"github.com/spf13/cobra"

	"github.com/sungur/ccbox/internal/config"
	"github.com/sungur/ccbox/internal/log"
)

// Version, Commit, and Date are set via ldflags at build time.
var (
	Version = "dev"
	Commit  = ""
	Date    = ""
)

var rootCmd = &cobra.Command{
	Use:   "ccbox [flags] [-- claude-args...]",
	Short: "Run Claude Code in isolated Docker containers",
	Long: `ccbox creates isolated Docker containers for running Claude Code.
It handles stack selection, image building, path translation, and
credential forwarding automatically.

Any flags not recognized by ccbox are passed through to the Claude CLI.
Use -- to explicitly separate ccbox flags from Claude flags.`,
	SilenceUsage:  true,
	SilenceErrors: true,
	// Allow unknown flags to pass through to Claude CLI
	FParseErrWhitelist: cobra.FParseErrWhitelist{UnknownFlags: true},
	RunE:               runDefault,
}

func init() {
	rootCmd.Version = Version
	rootCmd.SetVersionTemplate("ccbox v{{.Version}}\n")

	// --- Persistent flags (available to all subcommands) ---
	pf := rootCmd.PersistentFlags()
	pf.BoolP("yes", "y", false, "Unattended mode: auto-confirm all prompts")
	pf.BoolP("quiet", "q", false, "Suppress all output (exit code only)")

	// --- Local flags (root/run command only) ---
	f := rootCmd.Flags()
	f.StringP("stack", "s", "", "Language stack (auto=detect from project)")
	f.BoolP("build", "b", false, "Build image only (no container start)")
	f.String("path", ".", "Project path")
	f.StringP("chdir", "C", "", "Change to directory before running (like git -C)")
	f.Bool("fresh", false, "Fresh mode: auth only, clean slate (no rules/settings/commands)")
	f.Bool("no-debug-logs", false, "Ephemeral debug logs (tmpfs, not persisted)")
	f.Bool("deps", true, "Install all dependencies including dev")
	f.Bool("deps-prod", false, "Install production dependencies only")
	f.Bool("no-deps", false, "Skip dependency installation")
	f.CountP("debug", "d", "Debug mode (-d entrypoint logs, -dd + stream output)")
	f.Bool("headless", false, "Non-interactive mode (adds --print --output-format stream-json)")
	f.Bool("no-prune", false, "Skip automatic cleanup of stale Docker resources")
	f.BoolP("unrestricted", "U", false, "Remove CPU/memory limits (use full system resources)")
	f.Bool("zero-residue", false, "Zero-trace mode: no cache, logs, or artifacts left behind")
	f.String("memory", config.DefaultMemoryLimit, "Container memory limit (e.g., 4g, 2048m)")
	f.String("cpus", config.DefaultCPULimit, "Container CPU limit (e.g., 2.0)")
	f.String("network", "full", "Network policy: full (default), isolated, or path to policy.json")
	f.BoolP("verbose", "v", false, "Show detection details (which files triggered stack selection)")
	f.String("progress", "auto", "Docker build progress mode (auto|plain|tty)")
	f.Bool("cache", false, "Enable Docker build cache (default: no-cache for fresh installs)")
	f.Bool("attach-mode", false, "Container-only mode: skip bridge UI, run container directly")
	f.Bool("no-bridge", false, "Disable bridge mode (same as --attach-mode)")
	f.StringArrayP("env", "e", nil, "Pass environment variables to container (KEY=VALUE, repeatable)")

	// --- Subcommands ---
	rootCmd.AddCommand(cleanCmd)
	rootCmd.AddCommand(rebuildCmd)
	rootCmd.AddCommand(stacksCmd)
	rootCmd.AddCommand(updateCmd)
	rootCmd.AddCommand(voiceCmd)
	rootCmd.AddCommand(pasteCmd)
	rootCmd.AddCommand(uninstallCmd)
}

// Execute runs the root command and exits on error.
func Execute() {
	if err := rootCmd.Execute(); err != nil {
		log.Error(err.Error())
		os.Exit(1)
	}
}
