package config

import (
	"testing"
)

func TestParseStack(t *testing.T) {
	tests := []struct {
		input     string
		wantOk    bool
		wantStack LanguageStack
	}{
		{"go", true, StackGo},
		{"Go", true, StackGo},
		{"GO", true, StackGo},
		{"python", true, StackPython},
		{"base", true, StackBase},
		{"web", true, StackWeb},
		{"invalid", false, ""},
		{"", false, ""},
	}

	for _, tt := range tests {
		t.Run(tt.input, func(t *testing.T) {
			stack, ok := ParseStack(tt.input)
			if ok != tt.wantOk {
				t.Errorf("ParseStack(%q) ok = %v, want %v", tt.input, ok, tt.wantOk)
			}
			if stack != tt.wantStack {
				t.Errorf("ParseStack(%q) = %q, want %q", tt.input, stack, tt.wantStack)
			}
		})
	}
}

func TestFilterStacks(t *testing.T) {
	t.Run("category core", func(t *testing.T) {
		results := FilterStacks("core")
		if len(results) == 0 {
			t.Error("core category should return stacks")
		}
		found := false
		for _, s := range results {
			if s == StackBase {
				found = true
				break
			}
		}
		if !found {
			t.Error("core category should include StackBase")
		}
	})

	t.Run("search by name", func(t *testing.T) {
		results := FilterStacks("go")
		found := false
		for _, s := range results {
			if s == StackGo {
				found = true
				break
			}
		}
		if !found {
			t.Error("searching 'go' should find StackGo")
		}
	})

	t.Run("no results", func(t *testing.T) {
		results := FilterStacks("nonexistent_xyz_999")
		if len(results) != 0 {
			t.Errorf("expected no results, got %d", len(results))
		}
	})
}

func TestGetStackValues(t *testing.T) {
	values := GetStackValues()
	if len(values) == 0 {
		t.Error("GetStackValues should return non-empty slice")
	}

	found := false
	for _, v := range values {
		if v == "base" {
			found = true
			break
		}
	}
	if !found {
		t.Error("GetStackValues should include 'base'")
	}
}
