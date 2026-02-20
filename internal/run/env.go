package run

import (
	"fmt"
	"os"
	"regexp"
	"runtime"
	"strings"

	"github.com/sungur/ccbox/internal/config"
	"github.com/sungur/ccbox/internal/git"
	"github.com/sungur/ccbox/internal/log"
)

// envVarKeyRe validates environment variable key format.
var envVarKeyRe = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

// sessionPathEncodeRe matches characters that Claude Code replaces with hyphens
// when encoding project paths as directory names under ~/.claude/projects/.
var sessionPathEncodeRe = regexp.MustCompile(`[:/\\. ]`)

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
func addCapabilityRestrictions(cmd *[]string, networkPolicy string) {
	constraints := Constraints()
	*cmd = append(*cmd,
		"--cap-drop="+constraints.CapDrop,
		"--cap-add=SETUID",    // gosu: change user ID
		"--cap-add=SETGID",    // gosu: change group ID
		"--cap-add=CHOWN",     // entrypoint: change file ownership
		"--cap-add=SYS_ADMIN", // FUSE: mount filesystem in userspace
	)
	// iptables requires NET_ADMIN for network isolation rules.
	if networkPolicy != "" && networkPolicy != "full" {
		*cmd = append(*cmd, "--cap-add=NET_ADMIN")
	}
	// Prevent privilege escalation via setuid binaries
	*cmd = append(*cmd, "--security-opt=no-new-privileges")
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

// encodePathForSession encodes a project path the same way Claude Code does
// when creating session directory names under ~/.claude/projects/.
// Characters [:/\. ] are replaced with hyphens.
//
// Examples:
//
//	/D/GitHub/ccbox   -> -D-GitHub-ccbox    (container path)
//	D:\GitHub\ccbox   -> D--GitHub-ccbox    (native Windows path)
//	/mnt/d/GitHub/x   -> -mnt-d-GitHub-x   (WSL path)
func encodePathForSession(p string) string {
	return sessionPathEncodeRe.ReplaceAllString(p, "-")
}
