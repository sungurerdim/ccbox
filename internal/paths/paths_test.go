package paths

import (
	"testing"
)

func TestDriveLetterToContainerPath(t *testing.T) {
	tests := []struct {
		input    string
		expected string
	}{
		{"D:/GitHub/ccbox", "/D/GitHub/ccbox"},
		{"C:/Users/test", "/C/Users/test"},
		{"/usr/local/bin", "/usr/local/bin"}, // No drive letter
		{"d:/lower", "/d/lower"},             // lowercase drive preserved
		{"D:/", "/D/"},                       // Root
		{"", ""},                             // Empty
	}

	for _, tt := range tests {
		result := DriveLetterToContainerPath(tt.input)
		if result != tt.expected {
			t.Errorf("DriveLetterToContainerPath(%q) = %q, want %q", tt.input, result, tt.expected)
		}
	}
}

func TestWindowsToDockerPath(t *testing.T) {
	tests := []struct {
		input    string
		expected string
	}{
		{`D:\GitHub\Project`, "D:/GitHub/Project"},
		{`C:\Users\test`, "C:/Users/test"},
		{`D:\`, "D:/"},
		{"not-a-windows-path", "not-a-windows-path"},
	}

	for _, tt := range tests {
		result := WindowsToDockerPath(tt.input)
		if result != tt.expected {
			t.Errorf("WindowsToDockerPath(%q) = %q, want %q", tt.input, result, tt.expected)
		}
	}
}

func TestWslToDockerPath(t *testing.T) {
	tests := []struct {
		input    string
		expected string
	}{
		{"/mnt/c/Users/test", "/C/Users/test"},
		{"/mnt/d/GitHub/project", "/D/GitHub/project"},
		{"/mnt/c", "/C"},
		{"/home/user", "/home/user"}, // Not a WSL mount
	}

	for _, tt := range tests {
		result := WslToDockerPath(tt.input)
		if result != tt.expected {
			t.Errorf("WslToDockerPath(%q) = %q, want %q", tt.input, result, tt.expected)
		}
	}
}

func TestIsWindowsPath(t *testing.T) {
	tests := []struct {
		input    string
		expected bool
	}{
		{`D:\GitHub`, true},
		{"C:/Users", true},
		{"/usr/local", false},
		{"", false},
	}

	for _, tt := range tests {
		result := IsWindowsPath(tt.input)
		if result != tt.expected {
			t.Errorf("IsWindowsPath(%q) = %v, want %v", tt.input, result, tt.expected)
		}
	}
}

func TestNormalizeProjectDirName(t *testing.T) {
	tests := []struct {
		input    string
		expected string
	}{
		{"", "project"},
		{"myproject", "myproject"},
		{"  spaces  ", "spaces"},
		{"trailing.", "trailing"},
		{"\x00null", "null"},
	}

	for _, tt := range tests {
		result := NormalizeProjectDirName(tt.input)
		if result != tt.expected {
			t.Errorf("NormalizeProjectDirName(%q) = %q, want %q", tt.input, result, tt.expected)
		}
	}
}

func TestSanitizeForDocker(t *testing.T) {
	tests := []struct {
		input    string
		max      int
		expected string
	}{
		{"MyProject", 50, "myproject"},
		{"My Project!!", 50, "my-project"},
		{"", 50, "project"},
		{"a--b", 50, "a-b"},
	}

	for _, tt := range tests {
		result := SanitizeForDocker(tt.input, tt.max)
		if result != tt.expected {
			t.Errorf("SanitizeForDocker(%q, %d) = %q, want %q", tt.input, tt.max, result, tt.expected)
		}
	}
}

func TestResolveForDocker(t *testing.T) {
	tests := []struct {
		input    string
		expected string
		hasErr   bool
	}{
		{`D:\GitHub\Project`, "D:/GitHub/Project", false},
		{"/mnt/c/Users/test", "/C/Users/test", false},
		{"/home/user/project", "/home/user/project", false},
	}

	for _, tt := range tests {
		result, err := ResolveForDocker(tt.input)
		if tt.hasErr && err == nil {
			t.Errorf("ResolveForDocker(%q) should return error", tt.input)
		}
		if !tt.hasErr && err != nil {
			t.Errorf("ResolveForDocker(%q) unexpected error: %v", tt.input, err)
		}
		if !tt.hasErr && result != tt.expected {
			t.Errorf("ResolveForDocker(%q) = %q, want %q", tt.input, result, tt.expected)
		}
	}
}
