package docker

import (
	"testing"
)

func TestExtractProjectName(t *testing.T) {
	tests := []struct {
		name     string
		input    string
		expected string
	}{
		{"standard format", "/ccbox_myproject_a1b2c3", "myproject"},
		{"underscore in name", "/ccbox_my_app_a1b2c3", "my_app"},
		{"no suffix", "/ccbox_solo", "solo"},
		{"non-ccbox name", "other_container", "other_container"},
		{"slash prefix only", "/ccbox_test_123abc", "test"},
		{"no slash prefix", "ccbox_hello_world_ff00ff", "hello_world"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := ExtractProjectName(tt.input)
			if result != tt.expected {
				t.Errorf("ExtractProjectName(%q) = %q, want %q", tt.input, result, tt.expected)
			}
		})
	}
}
