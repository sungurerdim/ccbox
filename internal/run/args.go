// Package run provides the Docker container execution pipeline for ccbox.
//
// This file contains the Docker run argument builder, which constructs the
// full docker run command with all volume mounts, environment variables,
// resource limits, and security constraints.
package run

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"

	"github.com/sungur/ccbox/internal/config"
	"github.com/sungur/ccbox/internal/paths"
	"github.com/sungur/ccbox/internal/platform"
)

// wslPathRe matches WSL mount paths like /mnt/c/Users/...
var wslPathRe = regexp.MustCompile(`^/mnt/([a-z])(/.*)?$`)

// --- Types ---

// ContainerConstraints holds resource limits and security settings.
// Override via environment variables: CCBOX_PIDS_LIMIT, CCBOX_TMP_SIZE, etc.
type ContainerConstraints struct {
	PidsLimit      int
	CapDrop        string
	EphemeralPaths []string
	Tmpfs          TmpfsConfig
}

// TmpfsConfig holds tmpfs mount sizes for transient directories.
type TmpfsConfig struct {
	Tmp    string // default "512m"
	VarTmp string // "256m"
	Run    string // "64m"
	Shm    string // "256m"
}

// RunOptions holds all options for building the docker run command.
type RunOptions struct {
	Fresh         bool
	EphemeralLogs bool
	Debug         int
	Headless      bool
	ProjectImage  string
	Unrestricted  bool
	EnvVars       []string
	ClaudeArgs    []string
	ZeroResidue   bool
	MemoryLimit   string
	CPULimit      string
	NetworkPolicy string
	ReadOnly      bool
}

// ClaudeArgsOptions holds options for building Claude CLI arguments.
type ClaudeArgsOptions struct {
	Debug           int
	Headless        bool
	PersistentPaths string
	ClaudeArgs      []string
}

// DockerRunConfig holds the fully built docker run configuration.
type DockerRunConfig struct {
	// Args contains all arguments after "docker" (e.g., ["run", "--rm", ...]).
	Args []string
	// Env is the environment for the docker process itself (MSYS_NO_PATHCONV, etc.).
	Env []string
	// Interactive is true when TTY should be allocated (-it vs -i).
	Interactive bool
	// ContainerName for reference and diagnostics.
	ContainerName string
	// ImageName for reference and diagnostics.
	ImageName string
	// EnvFile is the path to a temporary env file containing sensitive variables.
	// The caller must delete this file after the container exits.
	EnvFile string
}

// --- Module-level state ---

// Constraints returns the container constraints, reading overrides from environment.
func Constraints() ContainerConstraints {
	pidsLimit := config.DefaultPidsLimit
	if v := os.Getenv(config.Env.PidsLimit); v != "" {
		if parsed, err := strconv.Atoi(v); err == nil && parsed > 0 {
			pidsLimit = parsed
		}
	}

	tmpSize := "512m"
	if v := os.Getenv(config.Env.TmpSize); v != "" {
		tmpSize = v
	}

	shmSize := "256m"
	if v := os.Getenv(config.Env.ShmSize); v != "" {
		shmSize = v
	}

	return ContainerConstraints{
		PidsLimit:      pidsLimit,
		CapDrop:        "ALL",
		EphemeralPaths: []string{"/tmp", "/var/tmp", "~/.cache"},
		Tmpfs: TmpfsConfig{
			Tmp:    tmpSize,
			VarTmp: "256m",
			Run:    "64m",
			Shm:    shmSize,
		},
	}
}

// --- Public functions ---

// BuildClaudeArgs builds the Claude CLI arguments list.
func BuildClaudeArgs(opts ClaudeArgsOptions) []string {
	args := []string{"--dangerously-skip-permissions"}

	if opts.Debug >= 2 {
		args = append(args, "--verbose")
	}

	// Container awareness prompt (always added)
	persistentPaths := opts.PersistentPaths
	if persistentPaths == "" {
		persistentPaths = "/ccbox/project, /ccbox/.claude"
	}
	containerPrompt := BuildContainerAwarenessPrompt(persistentPaths)

	// Check if user passed --append-system-prompt in claudeArgs.
	// If so, merge with container prompt; otherwise add standalone.
	userArgs := make([]string, len(opts.ClaudeArgs))
	copy(userArgs, opts.ClaudeArgs)

	aspIdx := -1
	for i, a := range userArgs {
		if a == "--append-system-prompt" {
			aspIdx = i
			break
		}
	}

	if aspIdx != -1 && aspIdx+1 < len(userArgs) {
		userSystemPrompt := userArgs[aspIdx+1]
		args = append(args, "--append-system-prompt", containerPrompt+"\n\n"+userSystemPrompt)
		// Remove --append-system-prompt and its value to avoid duplication
		userArgs = append(userArgs[:aspIdx], userArgs[aspIdx+2:]...)
	} else {
		args = append(args, "--append-system-prompt", containerPrompt)
	}

	// Headless mode: non-interactive output
	if opts.Headless || opts.Debug >= 2 {
		args = append(args, "--print", "--output-format", "stream-json")
	}

	// Append all remaining user claude args
	if len(userArgs) > 0 {
		args = append(args, userArgs...)
	}

	return args
}

// BuildDockerRunConfig builds the complete docker run configuration.
// This is the core function that assembles all Docker run arguments including
// volume mounts, environment variables, resource limits, and security constraints.
//
//nolint:gocyclo // inherent complexity from many Docker configuration options
func BuildDockerRunConfig(
	projectPath string,
	projectName string,
	stack config.LanguageStack,
	opts RunOptions,
) (*DockerRunConfig, error) {
	imageName := opts.ProjectImage
	if imageName == "" {
		imageName = config.GetImageName(string(stack))
	}

	claudeConfig := paths.GetClaudeConfigDir()
	containerName := config.GetContainerName(projectName, true)

	absProjectPath, err := filepath.Abs(projectPath)
	if err != nil {
		return nil, fmt.Errorf("cannot resolve project path: %w", err)
	}

	dockerProjectPath, err := paths.ResolveForDocker(absProjectPath)
	if err != nil {
		return nil, fmt.Errorf("cannot resolve Docker path: %w", err)
	}

	cmd := []string{"run", "--rm"}

	// TTY allocation: interactive sessions need -it, headless/debug needs -i only
	isHeadless := opts.Headless || opts.Debug >= 2
	isInteractive := !isHeadless
	if isInteractive {
		cmd = append(cmd, "-it")
	} else {
		cmd = append(cmd, "-i")
	}

	cmd = append(cmd, "--name", containerName)

	// Container labels for bridge TUI filtering and metadata
	cmd = append(cmd, "--label", "ccbox=true")
	cmd = append(cmd, "--label", config.LabelStack+"="+string(stack))
	cmd = append(cmd, "--label", config.LabelProject+"="+projectName)

	// Host project path for session compatibility.
	// Claude Code uses pwd to determine project path for sessions.
	// Mount directly to host-like path so sessions match across environments.
	// Dockerfile creates /{a..z} directories for Windows drive letter support.
	hostProjectPath := paths.DriveLetterToContainerPath(dockerProjectPath)

	// Project mount (always) - mount to host-like path for session compatibility
	cmd = append(cmd, "-v", dockerProjectPath+":"+hostProjectPath+":rw")

	// Git worktree support: if .git is a file (not a directory), this is a worktree.
	// The main repo's .git directory must be mounted for git to work inside container.
	gitPath := filepath.Join(absProjectPath, ".git")
	if info, statErr := os.Lstat(gitPath); statErr == nil && !info.IsDir() {
		addWorktreeMount(&cmd, absProjectPath, gitPath)
	}

	// Detect original path for WSL mapping
	originalPath := absProjectPath
	wslMatch := wslPathRe.FindStringSubmatch(originalPath)

	// Claude config mount modes:
	// - Fresh mode (--fresh): only credentials + settings (vanilla Claude experience)
	// - Normal mode: full .claude mount with FUSE in-place overlay
	dockerClaudeConfig, err := paths.ResolveForDocker(claudeConfig)
	if err != nil {
		return nil, fmt.Errorf("cannot resolve Claude config path: %w", err)
	}

	useMinimalMount := opts.Fresh

	if useMinimalMount {
		addMinimalMounts(&cmd, claudeConfig, dockerClaudeConfig)
	} else {
		// Mount global .claude directly - FUSE does in-place overlay in entrypoint
		cmd = append(cmd, "-v", dockerClaudeConfig+":/ccbox/.claude:rw")

		// FUSE device access for kernel-level path transformation.
		// Only needed on Windows/WSL where host paths differ from container POSIX paths.
		if platform.NeedsFuse() {
			if platform.NeedsPrivilegedForFuse() {
				cmd = append(cmd, "--privileged")
			} else {
				cmd = append(cmd, "--device", "/dev/fuse")
			}
		}
	}

	// Mount ~/.claude.json for onboarding state (hasCompletedOnboarding flag).
	// Claude Code maintains this in two locations simultaneously:
	//   1. ~/.claude.json         -- mount explicitly below
	//   2. ~/.claude/.claude.json -- already included via the .claude/ mount
	if !useMinimalMount {
		addClaudeJsonMount(&cmd, claudeConfig)
	}

	// Working directory - use host path for session compatibility
	cmd = append(cmd, "-w", hostProjectPath)

	// User mapping
	addUserMapping(&cmd)

	// Container essentials (init, resource limits) -- always applied
	addContainerEssentials(&cmd)

	// Capability restrictions -- only when not using --privileged.
	// Windows native + FUSE uses --privileged which already grants all capabilities.
	usesPrivileged := platform.NeedsPrivilegedForFuse() && platform.NeedsFuse() && !useMinimalMount
	if !usesPrivileged {
		addCapabilityRestrictions(&cmd, opts.NetworkPolicy)
	}

	// Read-only root filesystem (opt-in, not available in privileged mode)
	if opts.ReadOnly && !usesPrivileged {
		addReadOnlyRoot(&cmd)
	}

	addTmpfsMounts(&cmd)
	addLogOptions(&cmd)
	addDnsOptions(&cmd)

	// host.docker.internal: Docker Desktop (Windows/macOS) provides this automatically.
	// On native Linux Docker Engine, we need to add it explicitly for MCP and host services.
	if runtime.GOOS == "linux" && !platform.NeedsFuse() {
		cmd = append(cmd, "--add-host=host.docker.internal:host-gateway")
	}

	addResourceLimits(&cmd, opts)

	// Environment variables
	cmd = append(cmd, "-e", "HOME=/ccbox")
	cmd = append(cmd, "-e", "CLAUDE_CONFIG_DIR=/ccbox/.claude")
	addTerminalEnv(&cmd)

	// fakepath.so: original Windows path for LD_PRELOAD-based getcwd translation.
	// Makes git, npm, and other glibc-based tools see the original host path.
	if dockerProjectPath != hostProjectPath {
		cmd = append(cmd, "-e", config.Env.WinOriginalPath+"="+dockerProjectPath)
	}

	// Debug logs: ephemeral if requested, otherwise normal (persisted to host)
	if opts.EphemeralLogs {
		cmd = append(cmd, "--tmpfs", "/ccbox/.claude/debug:rw,size=512m,mode=0777")
	}

	// Persistent paths for container awareness.
	// Fresh mode: only project dir persists (.claude is ephemeral).
	// Normal mode (including base): both project and .claude persist.
	var persistentPaths string
	if opts.Fresh {
		persistentPaths = hostProjectPath
	} else {
		persistentPaths = hostProjectPath + ", /ccbox/.claude"
	}
	cmd = append(cmd, "-e", config.Env.PersistentPaths+"="+persistentPaths)

	addPathMapping(&cmd, dockerProjectPath, hostProjectPath, originalPath, claudeConfig, wslMatch, opts.Fresh)
	addDirMapping(&cmd, dockerProjectPath, hostProjectPath, absProjectPath)

	// Collect sensitive environment variables for --env-file
	// (prevents token exposure in /proc/pid/cmdline)
	var secrets []string

	// Git environment (name, email, token)
	addGitEnv(&cmd, &secrets)

	// SSH Agent forwarding (if available on host)
	addSshAgent(&cmd)

	// Claude environment (API keys, tokens)
	addClaudeEnv(&cmd, &secrets)

	// User-provided environment variables (added last to allow overrides)
	for _, envVar := range opts.EnvVars {
		key, value, ok := parseEnvVar(envVar)
		if ok {
			cmd = append(cmd, "-e", key+"="+value)
		}
	}

	// Write sensitive vars to temp env file
	envFile, err := writeSecretsEnvFile(secrets)
	if err != nil {
		return nil, fmt.Errorf("write secrets env file: %w", err)
	}
	if envFile != "" {
		cmd = append(cmd, "--env-file", envFile)
	}

	// Image name
	cmd = append(cmd, imageName)

	// Claude CLI arguments
	claudeArgs := BuildClaudeArgs(ClaudeArgsOptions{
		Debug:           opts.Debug,
		Headless:        opts.Headless,
		PersistentPaths: persistentPaths,
		ClaudeArgs:      opts.ClaudeArgs,
	})
	cmd = append(cmd, claudeArgs...)

	return &DockerRunConfig{
		Args:          cmd,
		Env:           paths.GetDockerEnv(),
		Interactive:   isInteractive,
		ContainerName: containerName,
		ImageName:     imageName,
		EnvFile:       envFile,
	}, nil
}

// addResourceLimits adds debug, resource, zero-residue, and network policy flags.
func addResourceLimits(cmd *[]string, opts RunOptions) {
	if opts.Debug > 0 {
		*cmd = append(*cmd, "-e", fmt.Sprintf("%s=%d", config.Env.Debug, opts.Debug))
	}
	if opts.Unrestricted {
		*cmd = append(*cmd, "-e", config.Env.Unrestricted+"=1")
	} else {
		memLimit := opts.MemoryLimit
		if memLimit == "" {
			memLimit = config.DefaultMemoryLimit
		}
		cpuLimit := opts.CPULimit
		if cpuLimit == "" {
			cpuLimit = config.DefaultCPULimit
		}
		*cmd = append(*cmd, "--memory="+memLimit)
		*cmd = append(*cmd, "--cpus="+cpuLimit)
		*cmd = append(*cmd, "--cpu-shares=512")
	}
	if opts.ZeroResidue {
		*cmd = append(*cmd, "-e", config.Env.ZeroResidue+"=1")
	}
	if opts.NetworkPolicy != "" && opts.NetworkPolicy != "full" {
		*cmd = append(*cmd, "-e", config.Env.NetworkPolicy+"="+opts.NetworkPolicy)
		if opts.NetworkPolicy == "isolated" {
			*cmd = append(*cmd, "--network=bridge")
		}
	}
}

// addPathMapping adds FUSE path mapping environment variables (CCBOX_PATH_MAP).
func addPathMapping(cmd *[]string, dockerProjectPath, hostProjectPath, originalPath, claudeConfig string, wslMatch []string, fresh bool) {
	var pathMappings []string

	if dockerProjectPath != hostProjectPath {
		pathMappings = append(pathMappings, dockerProjectPath+":"+hostProjectPath)
	}
	if wslMatch != nil {
		pathMappings = append(pathMappings, originalPath+":"+hostProjectPath)
	}
	if !fresh {
		normalizedClaudePath := strings.ReplaceAll(claudeConfig, "\\", "/")
		pathMappings = append(pathMappings, normalizedClaudePath+":/ccbox/.claude")
	}
	if len(pathMappings) > 0 {
		*cmd = append(*cmd, "-e", config.Env.PathMap+"="+strings.Join(pathMappings, ";"))
	}
}

// addDirMapping adds FUSE directory name mapping (CCBOX_DIR_MAP) for session compatibility.
func addDirMapping(cmd *[]string, dockerProjectPath, hostProjectPath, absProjectPath string) {
	if dockerProjectPath != hostProjectPath {
		containerEncoded := encodePathForSession(hostProjectPath)
		nativeEncoded := encodePathForSession(absProjectPath)
		if containerEncoded != nativeEncoded {
			*cmd = append(*cmd, "-e", config.Env.DirMap+"="+containerEncoded+":"+nativeEncoded)
		}
	}
}
