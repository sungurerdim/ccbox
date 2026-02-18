package voice

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestResolveModelPath(t *testing.T) {
	path := resolveModelPath("base.en")
	if path == "" {
		t.Error("resolveModelPath should return a non-empty path")
	}
	if !strings.Contains(path, "ggml-base.en.bin") {
		t.Errorf("resolveModelPath should contain model filename, got %q", path)
	}
}

func TestResolveModelPathDirect(t *testing.T) {
	// When model is a direct path that exists, it should return that path
	tmpFile := filepath.Join(os.TempDir(), "test-model-file.bin")
	if err := os.WriteFile(tmpFile, []byte("test"), 0o600); err != nil {
		t.Skip("cannot create temp file")
	}
	defer os.Remove(tmpFile)

	path := resolveModelPath(tmpFile)
	if path != tmpFile {
		t.Errorf("resolveModelPath should return direct path %q, got %q", tmpFile, path)
	}
}

func TestInputFormat(t *testing.T) {
	format := inputFormat()
	if format == "" {
		t.Error("inputFormat should return a non-empty format")
	}
	// On any platform, it should be one of the known formats
	known := map[string]bool{
		"avfoundation": true,
		"pulse":        true,
		"alsa":         true,
		"dshow":        true,
	}
	if !known[format] {
		t.Errorf("inputFormat returned unknown format %q", format)
	}
}

func TestInputDevice(t *testing.T) {
	device := inputDevice()
	if device == "" {
		t.Error("inputDevice should return a non-empty device")
	}
}

func TestCommandExists(t *testing.T) {
	// "go" should exist in test environment
	if !commandExists("go") {
		t.Error("commandExists(\"go\") should be true in test environment")
	}
	if commandExists("nonexistent-command-xyz-123") {
		t.Error("commandExists should be false for nonexistent command")
	}
}

func TestPipelineOptions(t *testing.T) {
	// Test that options defaults are applied
	opts := Options{}
	if opts.Duration != 0 {
		t.Error("default Duration should be 0 (set by Pipeline)")
	}
	if opts.Model != "" {
		t.Error("default Model should be empty (set by Pipeline)")
	}
}
