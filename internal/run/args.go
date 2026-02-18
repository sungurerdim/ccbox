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
	"github.com/sungur/ccbox/internal/git"
	"github.com/sungur/ccbox/internal/log"
	"github.com/sungur/ccbox/internal/paths"
	"github.com/sungur/ccbox/internal/platform"
)

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

// BuildContainerAwarenessPrompt generates the system prompt telling Claude
// it is running inside an isolated container.
func BuildContainerAwarenessPrompt(persistentPaths string) string {
	constraints := Constraints()
	hostOS := platform.HostOSName()

	windowsNote := ""
	p := platform.DetectHost()
	if p == platform.WindowsNative || p == platform.WindowsWSL {
		windowsNote = "\nPath format: D:\\GitHub\\x -> /D/GitHub/x (auto-translated)\n"
	}

	return strings.TrimSpace(fmt.Sprintf(`[CCBOX CONTAINER]

Isolated Debian container. Host: %s.
%s
PERSISTENCE:
  + %s -- survives container exit
  x /tmp, /root, /etc, apt packages, global installs -- ephemeral

CONSTRAINTS:
  - No Docker-in-Docker, systemd, or GUI
  - Local installs only: npm install (not -g), pip install -t .
  - Process limit: %d
  - /tmp is noexec -- use $TMPDIR for executables

INPUT MONITORING:
  - Check .claude/input/ at each turn for new files
  - Read and process any paste-*.png, paste-*.txt, or voice-*.txt files
  - After processing, move files to .claude/input/.processed/
  - Files are sent by ccbox bridge from host clipboard/microphone

TOOLS: git, gh, curl, wget, ssh, jq, yq, rg, fd, python3, pip3, gcc, make + stack tools`,
		hostOS, windowsNote, persistentPaths, constraints.PidsLimit))
}

// TransformSlashCommand fixes MSYS path translation for slash commands
// on Windows Git Bash. Git Bash (MSYS2) translates Unix paths like /command
// to C:/Program Files/Git/command. This reverses that translation.
func TransformSlashCommand(prompt string) string {
	if prompt == "" {
		return prompt
	}

	const msysPrefix = "C:/Program Files/Git/"
	if strings.HasPrefix(prompt, msysPrefix) {
		prompt = "/" + prompt[len(msysPrefix):]
	}

	return prompt
}

// GetHostUserIds returns the UID and GID to use for container processes.
//
// Platform behavior:
//   - Windows: Docker Desktop uses a Linux VM. Returns 1000:1000 (ccbox user).
//   - macOS/Linux/WSL: Returns actual host UID/GID for proper file ownership.
func GetHostUserIds() (uid, gid int) {
	if runtime.GOOS == "windows" {
		return 1000, 1000
	}
	return os.Getuid(), os.Getgid()
}

// GetHostTimezone returns the host timezone in IANA format.
//
// Detection order:
//  1. TZ environment variable
//  2. /etc/timezone (Debian/Ubuntu)
//  3. /etc/localtime symlink target
//  4. UTC fallback
func GetHostTimezone() string {
	// 1. Check TZ environment variable
	if tz := os.Getenv("TZ"); tz != "" && strings.Contains(tz, "/") {
		return tz
	}

	// On non-Windows, try filesystem detection
	if runtime.GOOS != "windows" {
		// 2. Try /etc/timezone (Debian/Ubuntu)
		if data, err := os.ReadFile("/etc/timezone"); err == nil {
			tz := strings.TrimSpace(string(data))
			if tz != "" && strings.Contains(tz, "/") {
				return tz
			}
		}

		// 3. Try /etc/localtime symlink
		if target, err := os.Readlink("/etc/localtime"); err == nil {
			if idx := strings.Index(target, "zoneinfo/"); idx >= 0 {
				tz := target[idx+len("zoneinfo/"):]
				if tz != "" && strings.Contains(tz, "/") {
					return tz
				}
			}
		}
	}

	// 4. Fallback to UTC
	return "UTC"
}

// GetTerminalSize returns the current terminal dimensions.
// Falls back to 120x40 if detection fails.
func GetTerminalSize() (columns, lines int) {
	columns = 120
	lines = 40

	// Try to get actual terminal size from environment (set by terminal emulators)
	if c := os.Getenv("COLUMNS"); c != "" {
		if v, err := strconv.Atoi(c); err == nil && v > 0 {
			columns = v
		}
	}
	if l := os.Getenv("LINES"); l != "" {
		if v, err := strconv.Atoi(l); err == nil && v > 0 {
			lines = v
		}
	}

	return columns, lines
}

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
	cmd = append(cmd, "--label", "ccbox.stack="+string(stack))
	cmd = append(cmd, "--label", "ccbox.project="+projectName)

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
	wslRe := regexp.MustCompile(`^/mnt/([a-z])(/.*)?$`)
	wslMatch := wslRe.FindStringSubmatch(originalPath)

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
		addCapabilityRestrictions(&cmd)
	}

	addTmpfsMounts(&cmd)
	addLogOptions(&cmd)
	addDnsOptions(&cmd)

	// host.docker.internal: Docker Desktop (Windows/macOS) provides this automatically.
	// On native Linux Docker Engine, we need to add it explicitly for MCP and host services.
	if runtime.GOOS == "linux" && !platform.NeedsFuse() {
		cmd = append(cmd, "--add-host=host.docker.internal:host-gateway")
	}

	// Debug, restricted/unrestricted mode flags
	if opts.Debug > 0 {
		cmd = append(cmd, "-e", fmt.Sprintf("%s=%d", config.Env.Debug, opts.Debug))
	}
	if opts.Unrestricted {
		cmd = append(cmd, "-e", config.Env.Unrestricted+"=1")
	} else {
		// Resource limits (can be overridden via --memory, --cpus flags)
		memLimit := opts.MemoryLimit
		if memLimit == "" {
			memLimit = config.DefaultMemoryLimit
		}
		cpuLimit := opts.CPULimit
		if cpuLimit == "" {
			cpuLimit = config.DefaultCPULimit
		}
		cmd = append(cmd, "--memory="+memLimit)
		cmd = append(cmd, "--cpus="+cpuLimit)
		cmd = append(cmd, "--cpu-shares=512")
	}

	// Zero-residue mode: disable all trace/cache/log artifacts
	if opts.ZeroResidue {
		cmd = append(cmd, "-e", config.Env.ZeroResidue+"=1")
	}

	// Network isolation policy
	if opts.NetworkPolicy != "" && opts.NetworkPolicy != "full" {
		cmd = append(cmd, "-e", config.Env.NetworkPolicy+"="+opts.NetworkPolicy)
		if opts.NetworkPolicy == "isolated" {
			cmd = append(cmd, "--network=bridge")
		}
	}

	// Environment variables
	cmd = append(cmd, "-e", "HOME=/ccbox")
	cmd = append(cmd, "-e", "CLAUDE_CONFIG_DIR=/ccbox/.claude")
	addTerminalEnv(&cmd)
	addClaudeEnv(&cmd)

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

	// FUSE path mapping: host paths -> container paths (for JSON config transformation).
	// Maps Windows paths (D:/...) to POSIX paths (/D/...) in session files.
	var pathMappings []string

	// Map project directory (Windows D:/... -> POSIX /D/...)
	if dockerProjectPath != hostProjectPath {
		pathMappings = append(pathMappings, dockerProjectPath+":"+hostProjectPath)
	}

	// Map WSL path if detected (/mnt/d/... -> /D/...)
	if wslMatch != nil {
		pathMappings = append(pathMappings, originalPath+":"+hostProjectPath)
	}

	// Map .claude config (unless fresh mode which uses minimal mount)
	if !opts.Fresh {
		normalizedClaudePath := strings.ReplaceAll(claudeConfig, "\\", "/")
		pathMappings = append(pathMappings, normalizedClaudePath+":/ccbox/.claude")
	}

	if len(pathMappings) > 0 {
		cmd = append(cmd, "-e", config.Env.PathMap+"="+strings.Join(pathMappings, ";"))
	}

	// Directory name mapping for session bridge (FUSE dirmap).
	// Claude Code encodes project paths as directory names: [:/\. ] -> -
	// Container sees /D/GitHub/ccbox -> encodes as -D-GitHub-ccbox
	// Native Windows sees D:\GitHub\ccbox -> encodes as D--GitHub-ccbox
	// Entrypoint creates symlink from container-encoded to native-encoded name.
	if dockerProjectPath != hostProjectPath {
		containerEncoded := encodePathForSession(hostProjectPath)
		nativeEncoded := encodePathForSession(absProjectPath)
		if containerEncoded != nativeEncoded {
			cmd = append(cmd, "-e", config.Env.DirMap+"="+containerEncoded+":"+nativeEncoded)
		}
	}

	// Git environment (name, email, token)
	addGitEnv(&cmd)

	// SSH Agent forwarding (if available on host)
	addSshAgent(&cmd)

	// User-provided environment variables (added last to allow overrides)
	for _, envVar := range opts.EnvVars {
		key, value, ok := parseEnvVar(envVar)
		if ok {
			cmd = append(cmd, "-e", key+"="+value)
		}
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
	}, nil
}

// --- Helper functions ---

// addWorktreeMount detects git worktrees and mounts the main .git directory.
func addWorktreeMount(cmd *[]string, absProjectPath, gitPath string) {
	data, err := os.ReadFile(gitPath)
	if err != nil {
		log.Warnf("Worktree detection failed: %v", err)
		return
	}

	content := strings.TrimSpace(string(data))
	gitdirRe := regexp.MustCompile(`^gitdir:\s*(.+)$`)
	match := gitdirRe.FindStringSubmatch(content)
	if match == nil {
		return
	}

	// Resolve relative to project dir, then find the main .git root.
	// gitdir points to .git/worktrees/<name>, we need the parent .git dir.
	worktreeGitDir := filepath.Join(absProjectPath, match[1])
	worktreeGitDir = filepath.Clean(worktreeGitDir)
	normalizedWorktree := strings.ReplaceAll(worktreeGitDir, "\\", "/")

	worktreesIdx := strings.Index(normalizedWorktree, "/.git/worktrees/")
	if worktreesIdx == -1 {
		return
	}

	mainGitDir := worktreeGitDir[:worktreesIdx+5] // include /.git
	dockerGitDir, err := paths.ResolveForDocker(mainGitDir)
	if err != nil {
		log.Warnf("Worktree mount path resolution failed: %v", err)
		return
	}

	containerGitDir := paths.DriveLetterToContainerPath(dockerGitDir)

	// Only mount if not already under project path
	if !strings.HasPrefix(mainGitDir, absProjectPath) {
		*cmd = append(*cmd, "-v", dockerGitDir+":"+containerGitDir+":rw")
		log.Debugf("Worktree detected: mounting main .git at %s", containerGitDir)
	}
}

// addMinimalMounts adds only essential files for a vanilla Claude Code experience.
// Used with --fresh flag for clean slate testing.
func addMinimalMounts(cmd *[]string, claudeConfig, dockerClaudeConfig string) {
	uid, gid := GetHostUserIds()

	// Ephemeral .claude directory (tmpfs, lost on container exit)
	*cmd = append(*cmd, "--tmpfs",
		fmt.Sprintf("/ccbox/.claude:rw,size=64m,uid=%d,gid=%d,mode=0755", uid, gid))

	// Mount only essential files for auth and preferences
	essentialFiles := []string{".credentials.json", "settings.json", "settings.local.json"}
	for _, f := range essentialFiles {
		hostFile := filepath.Join(claudeConfig, f)
		if _, err := os.Stat(hostFile); err == nil {
			dockerPath, resolveErr := paths.ResolveForDocker(hostFile)
			if resolveErr == nil {
				*cmd = append(*cmd, "-v", dockerPath+":/ccbox/.claude/"+f+":rw")
			}
		}
	}

	// Mount .claude.json onboarding state (both locations)
	homeDir := filepath.Dir(claudeConfig)
	mountClaudeJson(cmd, homeDir, claudeConfig)

	// Signal minimal mount mode
	*cmd = append(*cmd, "-e", config.Env.MinimalMount+"=1")
}

// addClaudeJsonMount mounts the ~/.claude.json file for non-fresh mode.
func addClaudeJsonMount(cmd *[]string, claudeConfig string) {
	homeDir := filepath.Dir(claudeConfig)
	claudeJsonHome := filepath.Join(homeDir, ".claude.json")

	// Create empty file if missing (Docker would create a directory instead)
	if _, err := os.Stat(claudeJsonHome); os.IsNotExist(err) {
		_ = os.MkdirAll(homeDir, 0755)
		_ = os.WriteFile(claudeJsonHome, []byte("{}"), 0644)
	}

	dockerPath, err := paths.ResolveForDocker(claudeJsonHome)
	if err == nil {
		*cmd = append(*cmd, "-v", dockerPath+":/ccbox/.claude.json:rw")
	}
	// .claude/.claude.json is already available via the .claude/ directory mount
}

// mountClaudeJson mounts both .claude.json locations for minimal mount mode.
func mountClaudeJson(cmd *[]string, homeDir, claudeConfig string) {
	// Mount 1: ~/.claude.json -> /ccbox/.claude.json
	claudeJsonHome := filepath.Join(homeDir, ".claude.json")
	if _, err := os.Stat(claudeJsonHome); os.IsNotExist(err) {
		_ = os.MkdirAll(homeDir, 0755)
		_ = os.WriteFile(claudeJsonHome, []byte("{}"), 0644)
	}
	if dockerPath, err := paths.ResolveForDocker(claudeJsonHome); err == nil {
		*cmd = append(*cmd, "-v", dockerPath+":/ccbox/.claude.json:rw")
	}

	// Mount 2: ~/.claude/.claude.json -> /ccbox/.claude/.claude.json
	claudeJsonConfig := filepath.Join(claudeConfig, ".claude.json")
	if _, err := os.Stat(claudeJsonConfig); os.IsNotExist(err) {
		_ = os.MkdirAll(claudeConfig, 0755)
		_ = os.WriteFile(claudeJsonConfig, []byte("{}"), 0644)
	}
	if dockerPath, err := paths.ResolveForDocker(claudeJsonConfig); err == nil {
		*cmd = append(*cmd, "-v", dockerPath+":/ccbox/.claude/.claude.json:rw")
	}
}

// addGitEnv adds git identity and token environment variables.
func addGitEnv(cmd *[]string) {
	creds := git.GetCredentials()

	if creds.Name != "" {
		*cmd = append(*cmd, "-e", "GIT_AUTHOR_NAME="+creds.Name)
		*cmd = append(*cmd, "-e", "GIT_COMMITTER_NAME="+creds.Name)
	}
	if creds.Email != "" {
		*cmd = append(*cmd, "-e", "GIT_AUTHOR_EMAIL="+creds.Email)
		*cmd = append(*cmd, "-e", "GIT_COMMITTER_EMAIL="+creds.Email)
	}
	if creds.Token != "" {
		*cmd = append(*cmd, "-e", "GITHUB_TOKEN="+creds.Token)
	}

	// Log summary
	if creds.Token != "" || creds.Name != "" {
		var parts []string
		if creds.Name != "" {
			parts = append(parts, creds.Name)
		}
		if creds.Token != "" {
			parts = append(parts, "token")
		}
		log.Dim("Git: " + strings.Join(parts, " + "))
	}
}

// addSshAgent adds SSH agent forwarding if available on host.
// Mounts SSH_AUTH_SOCK socket into container for key-based auth.
// Private keys stay on host -- only the agent socket is shared.
//
// Platform behavior:
//   - Linux/macOS/WSL: forwards SSH_AUTH_SOCK Unix domain socket
//   - Windows native: forwards OpenSSH named pipe (\\.\pipe\openssh-ssh-agent)
func addSshAgent(cmd *[]string) {
	sshAuthSock := os.Getenv("SSH_AUTH_SOCK")

	// Windows native: try OpenSSH named pipe if SSH_AUTH_SOCK is not set
	if sshAuthSock == "" && runtime.GOOS == "windows" {
		const winSSHPipe = `\\.\pipe\openssh-ssh-agent`
		if _, err := os.Stat(winSSHPipe); err == nil {
			// Docker Desktop can forward Windows named pipes
			*cmd = append(*cmd, "-v", winSSHPipe+":/run/ssh-agent.sock:ro")
			*cmd = append(*cmd, "-e", "SSH_AUTH_SOCK=/run/ssh-agent.sock")
			log.Dim("SSH: agent forwarded (Windows pipe)")
			return
		}
	}

	if sshAuthSock == "" {
		return
	}

	// Verify socket exists (avoid mount errors)
	if _, err := os.Stat(sshAuthSock); err != nil {
		log.Debugf("SSH_AUTH_SOCK set but socket not found: %s", sshAuthSock)
		return
	}

	// Mount the socket and set env var in container
	*cmd = append(*cmd, "-v", sshAuthSock+":"+sshAuthSock+":ro")
	*cmd = append(*cmd, "-e", "SSH_AUTH_SOCK="+sshAuthSock)

	log.Dim("SSH: agent forwarded")
}

// addTerminalEnv adds terminal-related environment variables.
func addTerminalEnv(cmd *[]string) {
	term := os.Getenv("TERM")
	if term == "" {
		term = "xterm-256color"
	}
	colorterm := os.Getenv("COLORTERM")
	if colorterm == "" {
		colorterm = "truecolor"
	}

	*cmd = append(*cmd, "-e", "TERM="+term)
	*cmd = append(*cmd, "-e", "COLORTERM="+colorterm)

	columns, lines := GetTerminalSize()
	*cmd = append(*cmd, "-e", fmt.Sprintf("COLUMNS=%d", columns))
	*cmd = append(*cmd, "-e", fmt.Sprintf("LINES=%d", lines))

	// Passthrough terminal-specific variables
	passthroughVars := []string{
		"TERM_PROGRAM",
		"TERM_PROGRAM_VERSION",
		"ITERM_SESSION_ID",
		"ITERM_PROFILE",
		"KITTY_WINDOW_ID",
		"KITTY_PID",
		"WEZTERM_PANE",
		"WEZTERM_UNIX_SOCKET",
		"GHOSTTY_RESOURCES_DIR",
		"ALACRITTY_SOCKET",
		"ALACRITTY_LOG",
		"VSCODE_GIT_IPC_HANDLE",
		"VSCODE_INJECTION",
		"WT_SESSION",
		"WT_PROFILE_ID",
		"KONSOLE_VERSION",
		"KONSOLE_DBUS_SESSION",
		"TMUX",
		"TMUX_PANE",
		"STY",
	}

	for _, varName := range passthroughVars {
		if value := os.Getenv(varName); value != "" {
			*cmd = append(*cmd, "-e", varName+"="+value)
		}
	}
}

// addUserMapping adds UID/GID environment variables for container user mapping.
// Container starts as root for setup, then drops to non-root user via gosu.
func addUserMapping(cmd *[]string) {
	uid, gid := GetHostUserIds()
	*cmd = append(*cmd, "-e", fmt.Sprintf("%s=%d", config.Env.UID, uid))
	*cmd = append(*cmd, "-e", fmt.Sprintf("%s=%d", config.Env.GID, gid))
}

// addContainerEssentials adds init process, resource limits, and shared memory.
func addContainerEssentials(cmd *[]string) {
	constraints := Constraints()
	*cmd = append(*cmd,
		fmt.Sprintf("--pids-limit=%d", constraints.PidsLimit),
		"--init",
		fmt.Sprintf("--shm-size=%s", constraints.Tmpfs.Shm),
		"--ulimit", "nofile=65535:65535",
		"--memory-swappiness=0",
	)
}

// addCapabilityRestrictions drops all capabilities and adds only required ones.
// Skipped when --privileged is used (Windows + FUSE).
func addCapabilityRestrictions(cmd *[]string) {
	constraints := Constraints()
	*cmd = append(*cmd,
		"--cap-drop="+constraints.CapDrop,
		"--cap-add=SETUID",    // gosu: change user ID
		"--cap-add=SETGID",    // gosu: change group ID
		"--cap-add=CHOWN",     // entrypoint: change file ownership
		"--cap-add=SYS_ADMIN", // FUSE: mount filesystem in userspace
	)
}

// addTmpfsMounts adds tmpfs mounts for transient data to reduce disk I/O.
// All temp files go to RAM -- zero SSD wear, 15-20x faster.
func addTmpfsMounts(cmd *[]string) {
	constraints := Constraints()
	*cmd = append(*cmd,
		"--tmpfs", fmt.Sprintf("/tmp:rw,size=%s,mode=1777,noexec,nosuid,nodev", constraints.Tmpfs.Tmp),
		"--tmpfs", fmt.Sprintf("/var/tmp:rw,size=%s,mode=1777,noexec,nosuid,nodev", constraints.Tmpfs.VarTmp),
		"--tmpfs", fmt.Sprintf("/run:rw,size=%s,mode=755", constraints.Tmpfs.Run),
	)
}

// addLogOptions adds log rotation options to limit disk usage.
func addLogOptions(cmd *[]string) {
	*cmd = append(*cmd,
		"--log-driver", "json-file",
		"--log-opt", "max-size=10m",
		"--log-opt", "max-file=3",
		"--log-opt", "compress=true",
	)
}

// addDnsOptions adds DNS resolver options for faster lookups.
func addDnsOptions(cmd *[]string) {
	*cmd = append(*cmd,
		"--dns-opt", "ndots:1",
		"--dns-opt", "timeout:1",
		"--dns-opt", "attempts:1",
	)
}

// addClaudeEnv adds Claude Code and runtime environment variables.
func addClaudeEnv(cmd *[]string) {
	tz := GetHostTimezone()
	*cmd = append(*cmd, "-e", "TZ="+tz)

	// Authentication: pass through API keys and OAuth tokens if set on host
	authVars := []string{
		"ANTHROPIC_API_KEY",
		"CLAUDE_CODE_API_KEY",
		"CLAUDE_CODE_OAUTH_TOKEN",
	}
	for _, v := range authVars {
		if val := os.Getenv(v); val != "" {
			*cmd = append(*cmd, "-e", v+"="+val)
		}
	}

	envVars := []string{
		"FORCE_COLOR=1",
		"CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1",
		"CLAUDE_CODE_HIDE_ACCOUNT_INFO=1",
		"CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL=1",
		"CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=85",
		"CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR=1",
		"BASH_DEFAULT_TIMEOUT_MS=600000",
		"BASH_MAX_TIMEOUT_MS=1800000",
		"DISABLE_NON_ESSENTIAL_MODEL_CALLS=1",
		"FORCE_AUTOUPDATE_PLUGINS=true",
		"DISABLE_AUTOUPDATER=1",
		"PYTHONUNBUFFERED=1",
		"DO_NOT_TRACK=1",
		"BUN_RUNTIME_TRANSPILER_CACHE_PATH=0",
	}

	for _, e := range envVars {
		*cmd = append(*cmd, "-e", e)
	}
}

// parseEnvVar parses a KEY=VALUE string into key and value components.
// Returns false if the format is invalid.
func parseEnvVar(envVar string) (key, value string, ok bool) {
	idx := strings.Index(envVar, "=")
	if idx <= 0 {
		return "", "", false
	}
	key = envVar[:idx]
	value = envVar[idx+1:]

	// Validate key: [A-Za-z_][A-Za-z0-9_]*
	if !envVarKeyRe.MatchString(key) {
		return "", "", false
	}
	return key, value, true
}

// envVarKeyRe validates environment variable key format.
var envVarKeyRe = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

// sessionPathEncodeRe matches characters that Claude Code replaces with hyphens
// when encoding project paths as directory names under ~/.claude/projects/.
var sessionPathEncodeRe = regexp.MustCompile(`[:/\\. ]`)

// encodePathForSession encodes a project path the same way Claude Code does
// when creating session directory names under ~/.claude/projects/.
// Characters [:/\. ] are replaced with hyphens.
//
// Examples:
//
//	/D/GitHub/ccbox   → -D-GitHub-ccbox    (container path)
//	D:\GitHub\ccbox   → D--GitHub-ccbox    (native Windows path)
//	/mnt/d/GitHub/x   → -mnt-d-GitHub-x   (WSL path)
func encodePathForSession(p string) string {
	return sessionPathEncodeRe.ReplaceAllString(p, "-")
}
