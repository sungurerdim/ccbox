// Package log provides a unified logging abstraction for ccbox.
//
// All ccbox output MUST go through this package.
// Uses lipgloss for terminal styling, stderr for warn/error, stdout for everything else.
package log

import (
	"fmt"
	"os"
	"sync"

	"github.com/charmbracelet/lipgloss"
)

// LogLevel controls the verbosity of log output.
type LogLevel int

const (
	// LevelDebug is the most verbose level.
	LevelDebug LogLevel = iota
	// LevelInfo is the default level.
	LevelInfo
	// LevelWarn shows only warnings and errors.
	LevelWarn
	// LevelError shows only errors.
	LevelError
	// LevelSilent suppresses all output.
	LevelSilent
)

// config holds the global logger configuration.
type config struct {
	mu     sync.RWMutex
	level  LogLevel
	prefix bool
	quiet  bool
}

var cfg = &config{
	level:  LevelInfo,
	prefix: false,
	quiet:  false,
}

// --- Lipgloss styles (package-level, initialized once) ---

var (
	dimStyle     = lipgloss.NewStyle().Faint(true)
	boldStyle    = lipgloss.NewStyle().Bold(true)
	redStyle     = lipgloss.NewStyle().Foreground(lipgloss.Color("9"))
	greenStyle   = lipgloss.NewStyle().Foreground(lipgloss.Color("10"))
	yellowStyle  = lipgloss.NewStyle().Foreground(lipgloss.Color("11"))
	blueStyle    = lipgloss.NewStyle().Foreground(lipgloss.Color("12"))
	cyanStyle    = lipgloss.NewStyle().Foreground(lipgloss.Color("14"))
	magentaStyle = lipgloss.NewStyle().Foreground(lipgloss.Color("13"))

	// Combination styles
	cyanBoldStyle    = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("14"))
	blueBoldStyle    = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("12"))
	redBoldStyle     = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("9"))
	greenBoldStyle   = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("10"))
	yellowBoldStyle  = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("11"))
)

// --- Configuration functions ---

// SetLevel sets the minimum log level. Messages below this level are suppressed.
func SetLevel(level LogLevel) {
	cfg.mu.Lock()
	defer cfg.mu.Unlock()
	cfg.level = level
}

// GetLevel returns the current log level.
func GetLevel() LogLevel {
	cfg.mu.RLock()
	defer cfg.mu.RUnlock()
	return cfg.level
}

// SetPrefix enables or disables the [ccbox] prefix on all messages.
func SetPrefix(enabled bool) {
	cfg.mu.Lock()
	defer cfg.mu.Unlock()
	cfg.prefix = enabled
}

// EnableQuietMode suppresses ALL output including errors.
// Only exit codes communicate success/failure.
func EnableQuietMode() {
	cfg.mu.Lock()
	defer cfg.mu.Unlock()
	cfg.quiet = true
	cfg.level = LevelSilent
}

// DisableQuietMode restores normal output.
func DisableQuietMode() {
	cfg.mu.Lock()
	defer cfg.mu.Unlock()
	cfg.quiet = false
	cfg.level = LevelInfo
}

// IsQuiet returns whether quiet mode is enabled.
func IsQuiet() bool {
	cfg.mu.RLock()
	defer cfg.mu.RUnlock()
	return cfg.quiet
}

// --- Internal helpers ---

// canOutput checks if output is allowed at the given level.
func canOutput(level LogLevel) bool {
	cfg.mu.RLock()
	defer cfg.mu.RUnlock()
	return !cfg.quiet && cfg.level <= level
}

// formatMessage applies the optional [ccbox] prefix.
func formatMessage(message string) string {
	cfg.mu.RLock()
	defer cfg.mu.RUnlock()
	if cfg.prefix {
		return "[ccbox] " + message
	}
	return message
}

// --- Log output functions ---

// Debug outputs a debug-level message (dim styling).
// Only shown when level <= LevelDebug.
func Debug(message string) {
	if canOutput(LevelDebug) {
		fmt.Fprintln(os.Stdout, dimStyle.Render(formatMessage(message)))
	}
}

// Debugf outputs a formatted debug-level message.
func Debugf(format string, args ...any) {
	if canOutput(LevelDebug) {
		Debug(fmt.Sprintf(format, args...))
	}
}

// Info outputs an info-level message (no styling).
func Info(message string) {
	if canOutput(LevelInfo) {
		fmt.Fprintln(os.Stdout, formatMessage(message))
	}
}

// Infof outputs a formatted info-level message.
func Infof(format string, args ...any) {
	if canOutput(LevelInfo) {
		Info(fmt.Sprintf(format, args...))
	}
}

// Warn outputs a warning message (yellow, to stderr).
func Warn(message string) {
	if canOutput(LevelWarn) {
		fmt.Fprintln(os.Stderr, yellowStyle.Render(formatMessage(message)))
	}
}

// Warnf outputs a formatted warning message.
func Warnf(format string, args ...any) {
	if canOutput(LevelWarn) {
		Warn(fmt.Sprintf(format, args...))
	}
}

// Error outputs an error message (red, to stderr).
func Error(message string) {
	if canOutput(LevelError) {
		fmt.Fprintln(os.Stderr, redStyle.Render(formatMessage(message)))
	}
}

// Errorf outputs a formatted error message.
func Errorf(format string, args ...any) {
	if canOutput(LevelError) {
		Error(fmt.Sprintf(format, args...))
	}
}

// Success outputs a success message (green, info level).
func Success(message string) {
	if canOutput(LevelInfo) {
		fmt.Fprintln(os.Stdout, greenStyle.Render(formatMessage(message)))
	}
}

// Dim outputs a subtle/dim message (info level).
func Dim(message string) {
	if canOutput(LevelInfo) {
		fmt.Fprintln(os.Stdout, dimStyle.Render(formatMessage(message)))
	}
}

// Bold outputs a bold/emphasized message (info level).
func Bold(message string) {
	if canOutput(LevelInfo) {
		fmt.Fprintln(os.Stdout, boldStyle.Render(formatMessage(message)))
	}
}

// Cyan outputs a cyan-colored message (info level).
func Cyan(message string) {
	if canOutput(LevelInfo) {
		fmt.Fprintln(os.Stdout, cyanStyle.Render(formatMessage(message)))
	}
}

// Blue outputs a blue-colored message (info level).
func Blue(message string) {
	if canOutput(LevelInfo) {
		fmt.Fprintln(os.Stdout, blueStyle.Render(formatMessage(message)))
	}
}

// Yellow outputs a yellow-colored message (info level, not warning).
func Yellow(message string) {
	if canOutput(LevelInfo) {
		fmt.Fprintln(os.Stdout, yellowStyle.Render(formatMessage(message)))
	}
}

// Green outputs a green-colored message (info level).
func Green(message string) {
	if canOutput(LevelInfo) {
		fmt.Fprintln(os.Stdout, greenStyle.Render(formatMessage(message)))
	}
}

// Red outputs a red-colored message (info level, not error).
func Red(message string) {
	if canOutput(LevelInfo) {
		fmt.Fprintln(os.Stdout, redStyle.Render(formatMessage(message)))
	}
}

// Raw outputs a message without any styling (for pre-styled content).
// Respects log level (info).
func Raw(message string) {
	if canOutput(LevelInfo) {
		fmt.Fprintln(os.Stdout, message)
	}
}

// Newline outputs an empty line. Respects log level (info).
func Newline() {
	if canOutput(LevelInfo) {
		fmt.Fprintln(os.Stdout)
	}
}

// Write outputs a message without a trailing newline (for progress indicators).
func Write(message string) {
	if canOutput(LevelInfo) {
		fmt.Fprint(os.Stdout, message)
	}
}

// --- Style builders (return styled strings without printing) ---

// Style provides string styling functions that return styled strings
// without printing them. Use with Raw() for complex compositions.
var Style = struct {
	Dim         func(...string) string
	Bold        func(...string) string
	Red         func(...string) string
	Green       func(...string) string
	Yellow      func(...string) string
	Blue        func(...string) string
	Cyan        func(...string) string
	Magenta     func(...string) string
	CyanBold    func(...string) string
	BlueBold    func(...string) string
	RedBold     func(...string) string
	GreenBold   func(...string) string
	YellowBold  func(...string) string
}{
	Dim:         dimStyle.Render,
	Bold:        boldStyle.Render,
	Red:         redStyle.Render,
	Green:       greenStyle.Render,
	Yellow:      yellowStyle.Render,
	Blue:        blueStyle.Render,
	Cyan:        cyanStyle.Render,
	Magenta:     magentaStyle.Render,
	CyanBold:    cyanBoldStyle.Render,
	BlueBold:    blueBoldStyle.Render,
	RedBold:     redBoldStyle.Render,
	GreenBold:   greenBoldStyle.Render,
	YellowBold:  yellowBoldStyle.Render,
}
