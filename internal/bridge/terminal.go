package bridge

import (
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"strings"
)

// DetectTerminal returns the name of the current terminal program based on
// well-known environment variables, falling back to platform defaults.
func DetectTerminal() string {
	if t := os.Getenv("TERM_PROGRAM"); t != "" {
		return t
	}
	if os.Getenv("WT_SESSION") != "" {
		return "windows-terminal"
	}
	if os.Getenv("KITTY_WINDOW_ID") != "" {
		return "kitty"
	}
	if os.Getenv("WEZTERM_PANE") != "" {
		return "wezterm"
	}
	if os.Getenv("GHOSTTY_RESOURCES_DIR") != "" {
		return "ghostty"
	}
	if os.Getenv("ALACRITTY_SOCKET") != "" {
		return "alacritty"
	}

	switch runtime.GOOS {
	case "darwin":
		return "Terminal.app"
	case "windows":
		return "cmd"
	default:
		return "xterm"
	}
}

// openTerminalWithCommand opens a new terminal window running the given
// command with the provided arguments. The new process is detached so it
// survives the parent TUI exiting.
func openTerminalWithCommand(command string, args []string) error {
	fullCmd := append([]string{command}, args...)
	cmdStr := strings.Join(fullCmd, " ")

	var cmd *exec.Cmd

	switch runtime.GOOS {
	case "darwin":
		// Use AppleScript to tell Terminal.app (or iTerm) to run the command.
		script := fmt.Sprintf(`tell application "Terminal" to do script "%s"`, cmdStr)
		cmd = exec.Command("osascript", "-e", script)

	case "windows":
		terminal := DetectTerminal()
		switch terminal {
		case "windows-terminal":
			// Windows Terminal: open a new tab with the command.
			wtArgs := append([]string{"new-tab", "--", command}, args...)
			cmd = exec.Command("wt", wtArgs...)
		default:
			// Fallback: use cmd.exe /c start to open a new console window.
			startArgs := append([]string{"/c", "start", command}, args...)
			cmd = exec.Command("cmd", startArgs...)
		}

	default:
		// Linux: try detected/known terminals in order of preference.
		cmd = buildLinuxTerminalCmd(fullCmd)
	}

	return cmd.Start()
}

// buildLinuxTerminalCmd attempts to find a usable terminal emulator on Linux
// and returns an exec.Cmd that opens it running the given command.
func buildLinuxTerminalCmd(fullCmd []string) *exec.Cmd {
	type termDef struct {
		bin     string
		builder func(fullCmd []string) *exec.Cmd
	}

	terminals := []termDef{
		{"kitty", func(fc []string) *exec.Cmd {
			return exec.Command("kitty", append([]string{"--"}, fc...)...)
		}},
		{"wezterm", func(fc []string) *exec.Cmd {
			return exec.Command("wezterm", append([]string{"start", "--"}, fc...)...)
		}},
		{"ghostty", func(fc []string) *exec.Cmd {
			cmdStr := strings.Join(fc, " ")
			return exec.Command("ghostty", "-e", cmdStr)
		}},
		{"alacritty", func(fc []string) *exec.Cmd {
			return exec.Command("alacritty", append([]string{"-e"}, fc...)...)
		}},
		{"gnome-terminal", func(fc []string) *exec.Cmd {
			return exec.Command("gnome-terminal", append([]string{"--"}, fc...)...)
		}},
		{"xterm", func(fc []string) *exec.Cmd {
			return exec.Command("xterm", append([]string{"-e"}, fc...)...)
		}},
	}

	for _, t := range terminals {
		if _, err := exec.LookPath(t.bin); err == nil {
			return t.builder(fullCmd)
		}
	}

	// Last resort fallback.
	return exec.Command("xterm", append([]string{"-e"}, fullCmd...)...)
}
