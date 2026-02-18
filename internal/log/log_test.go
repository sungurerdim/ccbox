package log

import (
	"testing"
)

func resetLogger() {
	cfg.mu.Lock()
	defer cfg.mu.Unlock()
	cfg.level = LevelInfo
	cfg.prefix = false
	cfg.quiet = false
}

func TestLogLevels(t *testing.T) {
	defer resetLogger()

	SetLevel(LevelWarn)
	if GetLevel() != LevelWarn {
		t.Errorf("GetLevel() = %d, want %d", GetLevel(), LevelWarn)
	}

	SetLevel(LevelDebug)
	if GetLevel() != LevelDebug {
		t.Errorf("GetLevel() = %d, want %d", GetLevel(), LevelDebug)
	}
}

func TestQuietMode(t *testing.T) {
	defer resetLogger()

	EnableQuietMode()
	if !IsQuiet() {
		t.Error("IsQuiet() should be true after EnableQuietMode")
	}
	if GetLevel() != LevelSilent {
		t.Errorf("level should be LevelSilent after EnableQuietMode, got %d", GetLevel())
	}

	DisableQuietMode()
	if IsQuiet() {
		t.Error("IsQuiet() should be false after DisableQuietMode")
	}
	if GetLevel() != LevelInfo {
		t.Errorf("level should be LevelInfo after DisableQuietMode, got %d", GetLevel())
	}
}

func TestCanOutput(t *testing.T) {
	defer resetLogger()

	SetLevel(LevelWarn)

	tests := []struct {
		name  string
		level LogLevel
		want  bool
	}{
		{"Info at Warn", LevelInfo, false},
		{"Warn at Warn", LevelWarn, true},
		{"Error at Warn", LevelError, true},
		{"Debug at Warn", LevelDebug, false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := canOutput(tt.level)
			if got != tt.want {
				t.Errorf("canOutput(%d) = %v, want %v", tt.level, got, tt.want)
			}
		})
	}
}

func TestCanOutputQuietMode(t *testing.T) {
	defer resetLogger()

	EnableQuietMode()
	if canOutput(LevelError) {
		t.Error("canOutput should return false in quiet mode")
	}
}

func TestFormatMessage(t *testing.T) {
	defer resetLogger()

	t.Run("prefix off", func(t *testing.T) {
		SetPrefix(false)
		got := formatMessage("hello")
		if got != "hello" {
			t.Errorf("formatMessage(%q) = %q, want %q", "hello", got, "hello")
		}
	})

	t.Run("prefix on", func(t *testing.T) {
		SetPrefix(true)
		got := formatMessage("hello")
		if got != "[ccbox] hello" {
			t.Errorf("formatMessage(%q) = %q, want %q", "hello", got, "[ccbox] hello")
		}
	})
}
