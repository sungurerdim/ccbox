package run

import (
	"fmt"
	"os"
	"runtime"
	"strconv"
	"strings"

	"github.com/sungur/ccbox/internal/platform"
)

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
