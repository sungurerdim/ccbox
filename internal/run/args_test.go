package run

import (
	"os"
	"strings"
	"testing"
)

func TestBuildContainerAwarenessPrompt(t *testing.T) {
	prompt := BuildContainerAwarenessPrompt("/ccbox/project, /ccbox/.claude")
	if !strings.Contains(prompt, "[CCBOX CONTAINER]") {
		t.Error("prompt should contain [CCBOX CONTAINER] header")
	}
	if !strings.Contains(prompt, "/ccbox/project") {
		t.Error("prompt should contain persistent paths")
	}
	if !strings.Contains(prompt, ".claude/input/") {
		t.Error("prompt should contain input monitoring section")
	}
}

func TestTransformSlashCommand(t *testing.T) {
	tests := []struct {
		input    string
		expected string
	}{
		{"", ""},
		{"/help", "/help"},
		{"C:/Program Files/Git/help", "/help"},
		{"regular text", "regular text"},
	}

	for _, tt := range tests {
		result := TransformSlashCommand(tt.input)
		if result != tt.expected {
			t.Errorf("TransformSlashCommand(%q) = %q, want %q", tt.input, result, tt.expected)
		}
	}
}

func TestGetHostTimezone(t *testing.T) {
	tz := GetHostTimezone()
	if tz == "" {
		t.Error("timezone should not be empty")
	}
}

func TestGetTerminalSize(t *testing.T) {
	cols, lines := GetTerminalSize()
	if cols <= 0 || lines <= 0 {
		t.Errorf("terminal size should be positive, got %dx%d", cols, lines)
	}
}

func TestBuildClaudeArgs(t *testing.T) {
	args := BuildClaudeArgs(ClaudeArgsOptions{
		Debug:           0,
		Headless:        false,
		PersistentPaths: "/ccbox/project",
	})

	if len(args) == 0 {
		t.Fatal("args should not be empty")
	}
	if args[0] != "--dangerously-skip-permissions" {
		t.Errorf("first arg should be --dangerously-skip-permissions, got %q", args[0])
	}

	// Check that --append-system-prompt is present
	found := false
	for _, a := range args {
		if a == "--append-system-prompt" {
			found = true
			break
		}
	}
	if !found {
		t.Error("args should contain --append-system-prompt")
	}
}

func TestBuildClaudeArgsHeadless(t *testing.T) {
	args := BuildClaudeArgs(ClaudeArgsOptions{
		Headless: true,
	})

	found := false
	for _, a := range args {
		if a == "--print" {
			found = true
			break
		}
	}
	if !found {
		t.Error("headless args should contain --print")
	}
}

func TestAddClaudeEnvAuthPassthrough(t *testing.T) {
	// Set a test API key
	os.Setenv("ANTHROPIC_API_KEY", "test-key-123")
	defer os.Unsetenv("ANTHROPIC_API_KEY")

	var cmd []string
	addClaudeEnv(&cmd)

	found := false
	for _, arg := range cmd {
		if arg == "ANTHROPIC_API_KEY=test-key-123" {
			found = true
			break
		}
	}
	if !found {
		t.Error("addClaudeEnv should pass through ANTHROPIC_API_KEY")
	}
}

func TestParseEnvVar(t *testing.T) {
	tests := []struct {
		input string
		key   string
		value string
		ok    bool
	}{
		{"FOO=bar", "FOO", "bar", true},
		{"MY_VAR=hello world", "MY_VAR", "hello world", true},
		{"EMPTY=", "EMPTY", "", true},
		{"=value", "", "", false},
		{"noequalssign", "", "", false},
		{"123INVALID=x", "", "", false},
	}

	for _, tt := range tests {
		key, value, ok := parseEnvVar(tt.input)
		if ok != tt.ok {
			t.Errorf("parseEnvVar(%q) ok=%v, want %v", tt.input, ok, tt.ok)
		}
		if ok && (key != tt.key || value != tt.value) {
			t.Errorf("parseEnvVar(%q) = (%q, %q), want (%q, %q)", tt.input, key, value, tt.key, tt.value)
		}
	}
}

func TestConstraints(t *testing.T) {
	c := Constraints()
	if c.PidsLimit <= 0 {
		t.Error("PidsLimit should be positive")
	}
	if c.CapDrop != "ALL" {
		t.Errorf("CapDrop should be ALL, got %q", c.CapDrop)
	}
	if c.Tmpfs.Tmp == "" {
		t.Error("Tmpfs.Tmp should not be empty")
	}
}
