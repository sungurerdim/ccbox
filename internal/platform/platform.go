// Package platform provides host platform detection and platform-specific
// configuration for Docker integration.
package platform

import (
	"os"
	"os/exec"
	"runtime"
	"strings"
	"sync"
)

// HostPlatform represents the detected host operating system environment.
type HostPlatform string

const (
	// WindowsWSL is Windows Subsystem for Linux (Docker Desktop via WSL backend).
	WindowsWSL HostPlatform = "windows-wsl"
	// WindowsNative is native Windows (Docker Desktop, Git Bash, PowerShell).
	WindowsNative HostPlatform = "windows-native"
	// MacOS is macOS (Docker Desktop).
	MacOS HostPlatform = "macos"
	// Linux is native Linux (Docker Engine).
	Linux HostPlatform = "linux"
)

var (
	detectedPlatform HostPlatform
	detectOnce       sync.Once
)

// DetectHost returns the current host platform, caching the result.
//
// Detection logic:
//   - runtime.GOOS == "windows" -> WindowsNative
//   - runtime.GOOS == "darwin"  -> MacOS
//   - runtime.GOOS == "linux" + /proc/version contains "microsoft" -> WindowsWSL
//   - runtime.GOOS == "linux" (fallback) -> Linux
func DetectHost() HostPlatform {
	detectOnce.Do(func() {
		switch runtime.GOOS {
		case "windows":
			detectedPlatform = WindowsNative
		case "darwin":
			detectedPlatform = MacOS
		case "linux":
			if isWSL() {
				detectedPlatform = WindowsWSL
			} else {
				detectedPlatform = Linux
			}
		default:
			// Unknown OS, assume Linux-like behavior
			detectedPlatform = Linux
		}
	})
	return detectedPlatform
}

// isWSL checks if running inside WSL by reading /proc/version.
func isWSL() bool {
	// Check /proc/version for "microsoft" (covers WSL1 and WSL2)
	data, err := os.ReadFile("/proc/version")
	if err == nil && strings.Contains(strings.ToLower(string(data)), "microsoft") {
		return true
	}
	// Fallback: check WSL-specific environment variables
	if os.Getenv("WSL_DISTRO_NAME") != "" || os.Getenv("WSLENV") != "" {
		return true
	}
	return false
}

// NeedsFuse returns whether the platform requires FUSE for path translation.
// Windows (both native and WSL) needs FUSE because Claude Code stores absolute
// host paths in config files that differ from container paths.
func NeedsFuse() bool {
	p := DetectHost()
	return p == WindowsNative || p == WindowsWSL
}

// NeedsPrivilegedForFuse returns whether the platform needs --privileged
// for FUSE to work. Only WindowsNative needs this because Docker Desktop
// on Windows does not support --device=/dev/fuse.
func NeedsPrivilegedForFuse() bool {
	return DetectHost() == WindowsNative
}

// DockerSocket returns the Docker socket path for the current platform.
// Windows native uses a named pipe; all others use the Unix socket.
func DockerSocket() string {
	if DetectHost() == WindowsNative {
		return "//./pipe/docker_engine"
	}
	return "/var/run/docker.sock"
}

// ClipboardImageCmd returns the command and arguments for reading an image
// from the system clipboard, or nil if not supported on the current platform.
func ClipboardImageCmd() []string {
	switch DetectHost() {
	case WindowsNative:
		return []string{"powershell", "-NoProfile", "-Command",
			"Add-Type -AssemblyName System.Windows.Forms; " +
				"$img = [System.Windows.Forms.Clipboard]::GetImage(); " +
				"if ($img) { $img.Save([Console]::OpenStandardOutput(), [System.Drawing.Imaging.ImageFormat]::Png) }"}
	case MacOS:
		return []string{"osascript", "-e",
			"set png to (the clipboard as «class PNGf»)",
			"-e", "set f to open for access POSIX file \"/dev/stdout\" with write permission",
			"-e", "write png to f",
			"-e", "close access f"}
	case Linux, WindowsWSL:
		if os.Getenv("WAYLAND_DISPLAY") != "" {
			return []string{"wl-paste", "--type", "image/png"}
		}
		return []string{"xclip", "-selection", "clipboard", "-t", "image/png", "-o"}
	default:
		return nil
	}
}

// ClipboardTextCmd returns the command and arguments for reading text
// from the system clipboard, or nil if not supported.
func ClipboardTextCmd() []string {
	switch DetectHost() {
	case WindowsNative:
		return []string{"powershell", "-NoProfile", "-Command", "Get-Clipboard"}
	case MacOS:
		return []string{"pbpaste"}
	case Linux, WindowsWSL:
		if os.Getenv("WAYLAND_DISPLAY") != "" {
			return []string{"wl-paste"}
		}
		return []string{"xclip", "-selection", "clipboard", "-o"}
	default:
		return nil
	}
}

// NeedsPathTranslation returns whether Docker volume mount paths need
// translation on this platform. Windows paths (D:\x) must become D:/x,
// and WSL paths (/mnt/d/x) must become /d/x.
func NeedsPathTranslation() bool {
	p := DetectHost()
	return p == WindowsNative || p == WindowsWSL
}

// HostOSName returns a human-readable OS name string.
func HostOSName() string {
	switch DetectHost() {
	case WindowsNative:
		return "Windows"
	case WindowsWSL:
		return "Windows (WSL)"
	case MacOS:
		return "macOS"
	case Linux:
		return "Linux"
	default:
		return "Unknown"
	}
}

// CommandExists checks whether a command is available in the system PATH.
func CommandExists(name string) bool {
	_, err := exec.LookPath(name)
	return err == nil
}
