package platform

import (
	"testing"
)

func TestHostOSName(t *testing.T) {
	name := HostOSName()
	if name == "" {
		t.Error("HostOSName() should not be empty")
	}

	validNames := map[string]bool{
		"Windows":      true,
		"Windows (WSL)": true,
		"macOS":        true,
		"Linux":        true,
		"Unknown":      true,
	}
	if !validNames[name] {
		t.Errorf("HostOSName() = %q, not a known value", name)
	}
}

func TestCommandExists(t *testing.T) {
	tests := []struct {
		name    string
		command string
		want    bool
	}{
		{"go should exist", "go", true},
		{"nonexistent command", "ccbox_nonexistent_cmd_12345", false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := CommandExists(tt.command)
			if got != tt.want {
				t.Errorf("CommandExists(%q) = %v, want %v", tt.command, got, tt.want)
			}
		})
	}
}

func TestDetectHost(t *testing.T) {
	// DetectHost should return a valid platform
	p := DetectHost()
	validPlatforms := map[HostPlatform]bool{
		WindowsWSL:    true,
		WindowsNative: true,
		MacOS:         true,
		Linux:         true,
	}
	if !validPlatforms[p] {
		t.Errorf("DetectHost() = %q, not a valid platform", p)
	}
}

func TestNeedsFuse(t *testing.T) {
	// Just verify it doesn't panic and returns a bool
	_ = NeedsFuse()
}

func TestNeedsPathTranslation(t *testing.T) {
	// NeedsPathTranslation should be consistent with NeedsFuse
	fuse := NeedsFuse()
	pathTrans := NeedsPathTranslation()
	if fuse != pathTrans {
		t.Errorf("NeedsFuse() = %v but NeedsPathTranslation() = %v, expected same", fuse, pathTrans)
	}
}
