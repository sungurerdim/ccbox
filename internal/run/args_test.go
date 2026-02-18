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

func TestEncodePathForSession(t *testing.T) {
	tests := []struct {
		name  string
		input string
		want  string
	}{
		{
			name:  "container path: /D/GitHub/ccbox",
			input: "/D/GitHub/ccbox",
			want:  "-D-GitHub-ccbox",
		},
		{
			name:  "native Windows path: D:\\GitHub\\ccbox",
			input: `D:\GitHub\ccbox`,
			want:  "D--GitHub-ccbox",
		},
		{
			name:  "Windows forward slash: D:/GitHub/ccbox",
			input: "D:/GitHub/ccbox",
			want:  "D--GitHub-ccbox",
		},
		{
			name:  "WSL path: /mnt/d/GitHub/ccbox",
			input: "/mnt/d/GitHub/ccbox",
			want:  "-mnt-d-GitHub-ccbox",
		},
		{
			name:  "path with spaces",
			input: "/D/My Projects/test app",
			want:  "-D-My-Projects-test-app",
		},
		{
			name:  "path with dots",
			input: "C:/Users/Sungur/.claude",
			want:  "C--Users-Sungur--claude",
		},
		{
			name:  "container and native encode differently",
			input: "/D/GitHub/ccbox",
			want:  "-D-GitHub-ccbox", // vs D--GitHub-ccbox for D:\GitHub\ccbox
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := encodePathForSession(tt.input)
			if got != tt.want {
				t.Errorf("encodePathForSession(%q) = %q, want %q", tt.input, got, tt.want)
			}
		})
	}
}

func TestSessionEncodingDivergence(t *testing.T) {
	// This test verifies the core problem that DirMap solves:
	// Container and native Windows encode the SAME project differently.
	// Without DirMap, sessions created natively would be invisible to containerized Claude.

	containerPath := "/D/GitHub/ccbox"
	nativeWindowsPath := `D:\GitHub\ccbox`

	containerEncoded := encodePathForSession(containerPath)
	nativeEncoded := encodePathForSession(nativeWindowsPath)

	if containerEncoded == nativeEncoded {
		t.Fatal("container and native encodings should differ (this is why DirMap exists)")
	}

	if containerEncoded != "-D-GitHub-ccbox" {
		t.Errorf("container encoded = %q, want -D-GitHub-ccbox", containerEncoded)
	}
	if nativeEncoded != "D--GitHub-ccbox" {
		t.Errorf("native encoded = %q, want D--GitHub-ccbox", nativeEncoded)
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
