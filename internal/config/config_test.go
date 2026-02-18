package config

import (
	"strings"
	"testing"
)

func TestGetContainerName(t *testing.T) {
	tests := []struct {
		name       string
		project    string
		unique     bool
		wantPrefix string
	}{
		{"simple", "myproject", false, "ccbox_myproject"},
		{"with spaces", "my project", false, "ccbox_my-project"},
		{"uppercase", "MyProject", false, "ccbox_myproject"},
		{"empty", "", false, "ccbox_project"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := GetContainerName(tt.project, tt.unique)
			if !strings.HasPrefix(result, tt.wantPrefix) {
				t.Errorf("GetContainerName(%q, %v) = %q, want prefix %q", tt.project, tt.unique, result, tt.wantPrefix)
			}
		})
	}
}

func TestGetContainerNameUnique(t *testing.T) {
	result := GetContainerName("test", true)
	if !strings.HasPrefix(result, "ccbox_test_") {
		t.Errorf("unique name should start with ccbox_test_, got %q", result)
	}
	// Should have a 6-char hex suffix after the last underscore
	parts := strings.Split(result, "_")
	suffix := parts[len(parts)-1]
	if len(suffix) != 6 {
		t.Errorf("unique suffix should be 6 chars, got %q (%d chars)", suffix, len(suffix))
	}
}

func TestGetImageName(t *testing.T) {
	result := GetImageName("go")
	if result != "ccbox_go:latest" {
		t.Errorf("GetImageName(%q) = %q, want %q", "go", result, "ccbox_go:latest")
	}
}
