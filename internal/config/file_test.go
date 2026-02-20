package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLoadConfigFile(t *testing.T) {
	tests := []struct {
		name    string
		content string
		check   func(t *testing.T, cfg *CcboxConfig)
	}{
		{
			name:    "string fields",
			content: "stack: go\ndeps: prod\nmemory: 8g\ncpus: \"4.0\"\n",
			check: func(t *testing.T, cfg *CcboxConfig) {
				if cfg.Stack != "go" {
					t.Errorf("Stack = %q, want %q", cfg.Stack, "go")
				}
				if cfg.Deps != "prod" {
					t.Errorf("Deps = %q, want %q", cfg.Deps, "prod")
				}
				if cfg.Memory != "8g" {
					t.Errorf("Memory = %q, want %q", cfg.Memory, "8g")
				}
				if cfg.CPUs != "4.0" {
					t.Errorf("CPUs = %q, want %q", cfg.CPUs, "4.0")
				}
			},
		},
		{
			name:    "bool pointer fields",
			content: "fresh: true\nheadless: false\nunrestricted: true\n",
			check: func(t *testing.T, cfg *CcboxConfig) {
				if cfg.Fresh == nil || !*cfg.Fresh {
					t.Error("Fresh should be *true")
				}
				if cfg.Headless == nil || *cfg.Headless {
					t.Error("Headless should be *false")
				}
				if cfg.Unrestricted == nil || !*cfg.Unrestricted {
					t.Error("Unrestricted should be *true")
				}
			},
		},
		{
			name:    "int field",
			content: "debug: 2\n",
			check: func(t *testing.T, cfg *CcboxConfig) {
				if cfg.Debug != 2 {
					t.Errorf("Debug = %d, want 2", cfg.Debug)
				}
			},
		},
		{
			name:    "pointer bool fields",
			content: "cache: true\nprune: false\n",
			check: func(t *testing.T, cfg *CcboxConfig) {
				if cfg.Cache == nil || !*cfg.Cache {
					t.Error("Cache should be *true")
				}
				if cfg.Prune == nil || *cfg.Prune {
					t.Error("Prune should be *false")
				}
			},
		},
		{
			name:    "env map",
			content: "env:\n  FOO: bar\n  BAZ: \"qux\"\n",
			check: func(t *testing.T, cfg *CcboxConfig) {
				if cfg.Env == nil {
					t.Fatal("Env should not be nil")
				}
				if cfg.Env["FOO"] != "bar" {
					t.Errorf("Env[FOO] = %q, want %q", cfg.Env["FOO"], "bar")
				}
				if cfg.Env["BAZ"] != "qux" {
					t.Errorf("Env[BAZ] = %q, want %q", cfg.Env["BAZ"], "qux")
				}
			},
		},
		{
			name:    "empty file",
			content: "",
			check: func(t *testing.T, cfg *CcboxConfig) {
				if cfg == nil {
					t.Fatal("empty file should return non-nil config")
				}
				if cfg.Stack != "" {
					t.Errorf("Stack should be empty, got %q", cfg.Stack)
				}
			},
		},
		{
			name:    "full config",
			content: "stack: web\nnetworkPolicy: isolated\nzeroResidue: true\nprogress: plain\n",
			check: func(t *testing.T, cfg *CcboxConfig) {
				if cfg.Stack != "web" {
					t.Errorf("Stack = %q, want %q", cfg.Stack, "web")
				}
				if cfg.NetworkPolicy != "isolated" {
					t.Errorf("NetworkPolicy = %q, want %q", cfg.NetworkPolicy, "isolated")
				}
				if cfg.ZeroResidue == nil || !*cfg.ZeroResidue {
					t.Error("ZeroResidue should be *true")
				}
				if cfg.Progress != "plain" {
					t.Errorf("Progress = %q, want %q", cfg.Progress, "plain")
				}
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			dir := t.TempDir()
			path := filepath.Join(dir, "ccbox.yaml")
			if err := os.WriteFile(path, []byte(tt.content), 0644); err != nil {
				t.Fatalf("write temp file: %v", err)
			}
			cfg := loadConfigFile(path)
			if cfg == nil {
				t.Fatal("loadConfigFile returned nil")
			}
			tt.check(t, cfg)
		})
	}

	t.Run("nonexistent file", func(t *testing.T) {
		cfg := loadConfigFile("/nonexistent/path/ccbox.yaml")
		if cfg != nil {
			t.Error("expected nil for nonexistent file")
		}
	})
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

	t.Run("bool pointer override false", func(t *testing.T) {
		bTrue := true
		bFalse := false
		base := &CcboxConfig{Unrestricted: &bTrue}
		override := &CcboxConfig{Unrestricted: &bFalse}

		result := mergeConfigs(base, override)
		if result.Unrestricted == nil || *result.Unrestricted != false {
			t.Errorf("Unrestricted should be false after override")
		}
	})

	t.Run("bool pointer nil preserves base", func(t *testing.T) {
		bTrue := true
		base := &CcboxConfig{Unrestricted: &bTrue}
		override := &CcboxConfig{} // Unrestricted is nil

		result := mergeConfigs(base, override)
		if result.Unrestricted == nil || *result.Unrestricted != true {
			t.Errorf("Unrestricted should remain true when override is nil")
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
