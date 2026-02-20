// Package paths provides cross-platform path utilities for Docker mount compatibility.
//
// Handles path conversion between Windows, WSL, and Docker formats.
// Docker Desktop on Windows expects Windows paths with forward slashes: C:/Users/...
package paths

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"unicode/utf8"

	"golang.org/x/text/unicode/norm"
)

// PathError represents a path validation or access error.
type PathError struct {
	Message string
}

func (e *PathError) Error() string {
	return e.Message
}

// --- Path detection ---

// windowsPathRe matches Windows-style paths like D:\GitHub or C:/Users.
var windowsPathRe = regexp.MustCompile(`^[A-Za-z]:[/\\]`)

// uncPathRe matches UNC paths like \\server\share or //server/share.
var uncPathRe = regexp.MustCompile(`^(?:\\\\|//)[^/\\]+[/\\][^/\\]+`)

// wslMountRe matches WSL mount paths like /mnt/c/Users/...
var wslMountRe = regexp.MustCompile(`^/mnt/([a-z])(?:/(.*))?$`)

// IsWindowsPath checks if path is a Windows-style path (has drive letter).
func IsWindowsPath(path string) bool {
	return windowsPathRe.MatchString(path)
}

// IsUncPath checks if path is a Windows UNC path (\\server\share or //server/share).
func IsUncPath(path string) bool {
	return uncPathRe.MatchString(path)
}

// --- Path normalization ---

// normalizePathSeparators converts backslashes to forward slashes,
// collapses duplicate slashes, and removes trailing slashes.
func normalizePathSeparators(path string) string {
	// Convert backslashes to forward slashes
	normalized := strings.ReplaceAll(path, "\\", "/")
	// Collapse duplicate slashes
	for strings.Contains(normalized, "//") {
		normalized = strings.ReplaceAll(normalized, "//", "/")
	}
	// Remove trailing slash (unless it is root "/")
	if len(normalized) > 1 {
		normalized = strings.TrimRight(normalized, "/")
	}
	return normalized
}

// --- Path conversion ---

// windowsToDockerRe parses a Windows path into drive letter and rest components.
var windowsToDockerRe = regexp.MustCompile(`^([A-Za-z]):[/\\]*(.*)$`)

// WindowsToDockerPath converts a Windows path to Docker Desktop compatible format.
// D:\GitHub\Project -> D:/GitHub/Project
func WindowsToDockerPath(path string) string {
	match := windowsToDockerRe.FindStringSubmatch(path)
	if match == nil {
		return path
	}
	drive := strings.ToUpper(match[1])
	rest := match[2]
	normalizedRest := normalizePathSeparators(rest)
	if normalizedRest == "" || normalizedRest == "/" {
		return drive + ":/"
	}
	return drive + ":/" + normalizedRest
}

// WslToDockerPath converts a WSL path to Docker Desktop compatible format.
// /mnt/c/Users/name/project -> /C/Users/name/project
// Drive letter is uppercased to match Windows convention and container mount points.
func WslToDockerPath(path string) string {
	match := wslMountRe.FindStringSubmatch(path)
	if match == nil {
		return path
	}
	drive := strings.ToUpper(match[1])
	rest := match[2]
	normalizedRest := normalizePathSeparators(rest)
	if normalizedRest == "" || normalizedRest == "/" {
		return "/" + drive
	}
	return "/" + drive + "/" + normalizedRest
}

// --- Docker path validation ---

// validateDockerPath checks for path traversal and null bytes.
func validateDockerPath(original, resolved string) error {
	if strings.Contains(resolved, "..") {
		return &PathError{
			Message: fmt.Sprintf(
				"Path traversal not allowed: %q resolved to %q which contains \"..\" (expected absolute path without parent references)",
				original, resolved),
		}
	}
	if strings.ContainsRune(resolved, 0) {
		idx := strings.IndexRune(resolved, 0)
		return &PathError{
			Message: fmt.Sprintf(
				"Null bytes not allowed in path: %q contains null byte at position %d (expected printable characters only)",
				original, idx),
		}
	}
	return nil
}

// ResolveForDocker resolves a path to Docker-compatible format for volume mounts.
// This is the main function for preparing host paths for Docker -v flags.
//
// Handles:
//   - Windows paths (D:\GitHub\...) -> D:/GitHub/...
//   - WSL paths (/mnt/d/...) -> /D/... (for WSL Docker integration)
//   - Native Linux/macOS paths -> unchanged
func ResolveForDocker(path string) (string, error) {
	// Normalize backslashes for consistent pattern matching
	pathStr := strings.ReplaceAll(path, "\\", "/")

	// Case 1: Windows UNC path (//server/share/...)
	if IsUncPath(pathStr) {
		if err := validateDockerPath(path, pathStr); err != nil {
			return "", err
		}
		return pathStr, nil
	}

	// Case 2: Windows-style path (C:/...)
	if IsWindowsPath(pathStr) {
		result := WindowsToDockerPath(pathStr)
		if err := validateDockerPath(path, result); err != nil {
			return "", err
		}
		return result, nil
	}

	// Case 3: WSL mount path (/mnt/[a-z] or /mnt/[a-z]/...)
	if strings.HasPrefix(pathStr, "/mnt/") && len(pathStr) >= 6 {
		ch := pathStr[5]
		if ch >= 'a' && ch <= 'z' && (len(pathStr) == 6 || pathStr[6] == '/') {
			result := WslToDockerPath(pathStr)
			if err := validateDockerPath(path, result); err != nil {
				return "", err
			}
			return result, nil
		}
	}

	// Case 4: Native Linux/macOS path - use as-is
	if err := validateDockerPath(path, pathStr); err != nil {
		return "", err
	}
	return pathStr, nil
}

// driveLetterRe matches a Windows drive letter prefix like "D:" or "c:".
var driveLetterRe = regexp.MustCompile(`^([A-Za-z]):`)

// DriveLetterToContainerPath converts a Docker-style Windows path (D:/GitHub/x)
// to a container POSIX path (/D/GitHub/x). Case is preserved from the host to
// avoid mismatches on case-sensitive container filesystems.
func DriveLetterToContainerPath(dockerPath string) string {
	return driveLetterRe.ReplaceAllStringFunc(dockerPath, func(match string) string {
		return "/" + match[:1]
	})
}

// ContainerPath formats a container path to prevent MSYS path translation on Windows.
// Git Bash (MSYS2) translates Unix-style paths like /ccbox to C:/Program Files/Git/ccbox.
// A double slash prefix prevents this translation.
func ContainerPath(path string) string {
	if runtime.GOOS == "windows" && strings.HasPrefix(path, "/") {
		return "/" + path
	}
	return path
}

// GetDockerEnv returns environment variables for running Docker commands.
// On Windows, MSYS_NO_PATHCONV=1 and MSYS2_ARG_CONV_EXCL=* are set to
// prevent Git Bash from translating Docker volume mount paths.
func GetDockerEnv() []string {
	env := os.Environ()
	if runtime.GOOS == "windows" {
		env = append(env, "MSYS_NO_PATHCONV=1")
		env = append(env, "MSYS2_ARG_CONV_EXCL=*")
	}
	return env
}

// --- Path validation ---

// ValidateProjectPath validates and resolves a project directory path.
// Returns the resolved absolute path or an error if the path is invalid.
func ValidateProjectPath(path string) (string, error) {
	projectPath, err := filepath.Abs(path)
	if err != nil {
		return "", &PathError{Message: fmt.Sprintf("cannot resolve path: %s", path)}
	}

	info, err := os.Lstat(projectPath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return "", &PathError{Message: fmt.Sprintf("project path does not exist: %s", projectPath)}
		}
		return "", &PathError{Message: fmt.Sprintf("cannot access path: %s: %v", projectPath, err)}
	}

	// Reject symlinks to prevent symlink-based path traversal
	if info.Mode()&os.ModeSymlink != 0 {
		return "", &PathError{Message: fmt.Sprintf("project path cannot be a symlink: %s", projectPath)}
	}

	if !info.IsDir() {
		return "", &PathError{Message: fmt.Sprintf("project path must be a directory: %s", projectPath)}
	}

	return projectPath, nil
}

// GetClaudeConfigDir returns the default Claude config directory path (~/.claude).
func GetClaudeConfigDir() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return filepath.Join(".", ".claude")
	}
	return filepath.Join(home, ".claude")
}

// --- Project directory name handling ---

const maxDirNameBytes = 255

// NormalizeProjectDirName normalizes a project directory name for cross-platform compatibility.
//
// Transformations applied:
//  1. Unicode NFC normalization
//  2. Remove null bytes
//  3. Remove control characters
//  4. Trim whitespace
//  5. Remove Windows-reserved trailing chars (space, dot)
//  6. Truncate if exceeds filesystem byte limit (255 bytes)
func NormalizeProjectDirName(dirName string) string {
	if dirName == "" {
		return "project"
	}

	normalized := dirName

	// 1. Unicode NFC normalization
	normalized = norm.NFC.String(normalized)

	// 2. Remove null bytes
	normalized = strings.ReplaceAll(normalized, "\x00", "")

	// 3. Remove control characters (U+0000-U+001F, U+007F-U+009F)
	normalized = strings.Map(func(r rune) rune {
		if r <= 0x1F || (r >= 0x7F && r <= 0x9F) {
			return -1 // drop
		}
		return r
	}, normalized)

	// 4. Trim whitespace
	normalized = strings.TrimSpace(normalized)

	// 5. Remove trailing spaces and dots (Windows compatibility)
	normalized = strings.TrimRight(normalized, ". ")

	// 6. Truncate if exceeds filesystem byte limit
	if len(normalized) > maxDirNameBytes {
		for len(normalized) > maxDirNameBytes && len(normalized) > 0 {
			_, size := utf8.DecodeLastRuneInString(normalized)
			normalized = normalized[:len(normalized)-size]
		}
		normalized = strings.TrimSpace(normalized)
	}

	if normalized == "" {
		return "project"
	}

	return normalized
}

// dockerSafeRe matches characters not allowed in Docker identifiers.
var dockerSafeRe = regexp.MustCompile(`[^a-z0-9._-]`)

// dockerMultiHyphenRe matches consecutive hyphens for collapsing.
var dockerMultiHyphenRe = regexp.MustCompile(`-{2,}`)

// SanitizeForDocker sanitizes a project name for Docker identifiers
// (container names, image tags). Docker requires: lowercase, alphanumeric,
// hyphens, underscores, dots. Max length for container names is 64 characters.
func SanitizeForDocker(name string, maxLength int) string {
	if maxLength <= 0 {
		maxLength = 50
	}
	if name == "" {
		return "project"
	}

	// Lowercase
	safe := strings.ToLower(name)

	// Replace non-allowed characters with hyphen
	safe = dockerSafeRe.ReplaceAllString(safe, "-")

	// Collapse multiple hyphens
	safe = dockerMultiHyphenRe.ReplaceAllString(safe, "-")

	// Remove leading/trailing hyphens, dots, underscores
	safe = strings.Trim(safe, "-_.")

	// Apply max length
	if len(safe) > maxLength {
		safe = safe[:maxLength]
		safe = strings.TrimRight(safe, "-_.")
	}

	if safe == "" {
		return "project"
	}
	return safe
}

