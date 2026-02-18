package config

import (
	"testing"
)

func TestParseSimpleYaml(t *testing.T) {
	tests := []struct {
		name    string
		input   string
		wantKey string
		wantVal any
	}{
		{"string value", "stack: go", "stack", "go"},
		{"bool true", "fresh: true", "fresh", true},
		{"bool false", "headless: false", "headless", false},
		{"integer", "debug: 2", "debug", 2},
		{"quoted string double", `stack: "web"`, "stack", "web"},
		{"quoted string single", "stack: 'web'", "stack", "web"},
		{"quoted float stays string", `cpus: "4.0"`, "cpus", "4.0"},
		{"quoted int stays string", `debug: "2"`, "debug", "2"},
		{"quoted bool stays string", `fresh: "true"`, "fresh", "true"},
		{"unquoted float", "cpus: 4.0", "cpus", 4.0},
		{"comment line", "# this is a comment\nstack: go", "stack", "go"},
		{"empty input", "", "", nil},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := parseSimpleYaml(tt.input)
			if tt.wantKey == "" {
				if len(result) != 0 {
					t.Errorf("expected empty map, got %v", result)
				}
				return
			}
			got, ok := result[tt.wantKey]
			if !ok {
				t.Errorf("key %q not found in result %v", tt.wantKey, result)
				return
			}
			if got != tt.wantVal {
				t.Errorf("result[%q] = %v (%T), want %v (%T)", tt.wantKey, got, got, tt.wantVal, tt.wantVal)
			}
		})
	}
}

func TestParseSimpleYamlEnvBlock(t *testing.T) {
	input := "env:\n  FOO: bar\n  BAZ: \"qux\"\nstack: go"
	result := parseSimpleYaml(input)

	envMap, ok := result["env"].(map[string]string)
	if !ok {
		t.Fatalf("env should be map[string]string, got %T", result["env"])
	}
	if envMap["FOO"] != "bar" {
		t.Errorf("env[FOO] = %q, want %q", envMap["FOO"], "bar")
	}
	if envMap["BAZ"] != "qux" {
		t.Errorf("env[BAZ] = %q, want %q", envMap["BAZ"], "qux")
	}
	if result["stack"] != "go" {
		t.Errorf("stack = %v, want %q", result["stack"], "go")
	}
}

func TestIsQuoted(t *testing.T) {
	tests := []struct {
		input string
		want  bool
	}{
		{`"hello"`, true},
		{`'hello'`, true},
		{`"4.0"`, true},
		{"hello", false},
		{`"`, false},
		{"", false},
		{`"mismatched'`, false},
	}

	for _, tt := range tests {
		got := isQuoted(tt.input)
		if got != tt.want {
			t.Errorf("isQuoted(%q) = %v, want %v", tt.input, got, tt.want)
		}
	}
}

func TestStripQuotes(t *testing.T) {
	tests := []struct {
		input string
		want  string
	}{
		{`"hello"`, "hello"},
		{`'hello'`, "hello"},
		{"hello", "hello"},
		{`""`, ""},
		{`''`, ""},
		{"", ""},
	}

	for _, tt := range tests {
		got := stripQuotes(tt.input)
		if got != tt.want {
			t.Errorf("stripQuotes(%q) = %q, want %q", tt.input, got, tt.want)
		}
	}
}

func TestMergeConfigs(t *testing.T) {
	t.Run("override string fields", func(t *testing.T) {
		base := &CcboxConfig{Stack: "go", Memory: "2g"}
		override := &CcboxConfig{Stack: "web"}

		result := mergeConfigs(base, override)
		if result.Stack != "web" {
			t.Errorf("Stack = %q, want %q", result.Stack, "web")
		}
		if result.Memory != "2g" {
			t.Errorf("Memory = %q, want %q", result.Memory, "2g")
		}
	})

	t.Run("nil handling", func(t *testing.T) {
		base := &CcboxConfig{Stack: "go"}
		result := mergeConfigs(nil, base, nil)
		if result.Stack != "go" {
			t.Errorf("Stack = %q, want %q", result.Stack, "go")
		}
	})

	t.Run("pointer bool Cache", func(t *testing.T) {
		cacheTrue := true
		cacheFalse := false
		base := &CcboxConfig{Cache: &cacheTrue}
		override := &CcboxConfig{Cache: &cacheFalse}

		result := mergeConfigs(base, override)
		if result.Cache == nil || *result.Cache != false {
			t.Errorf("Cache should be false after override")
		}
	})

	t.Run("env map merge", func(t *testing.T) {
		base := &CcboxConfig{Env: map[string]string{"A": "1", "B": "2"}}
		override := &CcboxConfig{Env: map[string]string{"B": "3", "C": "4"}}

		result := mergeConfigs(base, override)
		if result.Env["A"] != "1" {
			t.Errorf("Env[A] = %q, want %q", result.Env["A"], "1")
		}
		if result.Env["B"] != "3" {
			t.Errorf("Env[B] = %q, want %q (override)", result.Env["B"], "3")
		}
		if result.Env["C"] != "4" {
			t.Errorf("Env[C] = %q, want %q", result.Env["C"], "4")
		}
	})
}

func TestIsInteger(t *testing.T) {
	tests := []struct {
		input string
		want  bool
	}{
		{"42", true},
		{"-1", true},
		{"0", true},
		{"3.14", false},
		{"abc", false},
		{"", false},
	}

	for _, tt := range tests {
		got := isInteger(tt.input)
		if got != tt.want {
			t.Errorf("isInteger(%q) = %v, want %v", tt.input, got, tt.want)
		}
	}
}

func TestIsFloat(t *testing.T) {
	tests := []struct {
		input string
		want  bool
	}{
		{"3.14", true},
		{"-0.5", true},
		{"42", false},
		{"abc", false},
		{"", false},
		{"1.2.3", false},
	}

	for _, tt := range tests {
		got := isFloat(tt.input)
		if got != tt.want {
			t.Errorf("isFloat(%q) = %v, want %v", tt.input, got, tt.want)
		}
	}
}

func TestConfigEnvToArray(t *testing.T) {
	t.Run("nil map", func(t *testing.T) {
		cfg := CcboxConfig{}
		result := ConfigEnvToArray(cfg)
		if result != nil {
			t.Errorf("expected nil, got %v", result)
		}
	})

	t.Run("converts map to slice", func(t *testing.T) {
		cfg := CcboxConfig{Env: map[string]string{"FOO": "bar", "BAZ": "qux"}}
		result := ConfigEnvToArray(cfg)
		if len(result) != 2 {
			t.Fatalf("expected 2 items, got %d", len(result))
		}
		found := map[string]bool{}
		for _, r := range result {
			found[r] = true
		}
		if !found["FOO=bar"] {
			t.Error("missing FOO=bar")
		}
		if !found["BAZ=qux"] {
			t.Error("missing BAZ=qux")
		}
	})
}
