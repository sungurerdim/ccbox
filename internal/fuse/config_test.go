package fuse

import (
	"testing"
)

func TestNormalizePath(t *testing.T) {
	tests := []struct {
		input string
		want  string
	}{
		{`D:\GitHub\ccbox`, "D:/GitHub/ccbox"},
		{"D:/GitHub/ccbox/", "D:/GitHub/ccbox"},
		{"D:/GitHub/ccbox///", "D:/GitHub/ccbox"},
		{"/", "/"},
		{"", ""},
		{"/mnt/d/project", "/mnt/d/project"},
		{`C:\Users\Sungur\.claude`, "C:/Users/Sungur/.claude"},
	}

	for _, tt := range tests {
		t.Run(tt.input, func(t *testing.T) {
			got := normalizePath(tt.input)
			if got != tt.want {
				t.Errorf("normalizePath(%q) = %q, want %q", tt.input, got, tt.want)
			}
		})
	}
}

func TestParseConfig(t *testing.T) {
	t.Run("basic config", func(t *testing.T) {
		cfg := ParseConfig(
			"/ccbox/.claude",
			"D:/GitHub/ccbox:/D/GitHub/ccbox;C:/Users/Sungur/.claude:/ccbox/.claude",
			"-D-GitHub-ccbox:D--GitHub-ccbox",
			".json,.jsonl",
			0,
		)

		if cfg.SourceDir != "/ccbox/.claude" {
			t.Errorf("SourceDir = %q, want /ccbox/.claude", cfg.SourceDir)
		}
		if len(cfg.PathMappings) != 2 {
			t.Fatalf("PathMappings count = %d, want 2", len(cfg.PathMappings))
		}

		// First mapping: D:/GitHub/ccbox -> /D/GitHub/ccbox
		m0 := cfg.PathMappings[0]
		if m0.From != "D:/GitHub/ccbox" {
			t.Errorf("mapping[0].From = %q, want D:/GitHub/ccbox", m0.From)
		}
		if m0.To != "/D/GitHub/ccbox" {
			t.Errorf("mapping[0].To = %q, want /D/GitHub/ccbox", m0.To)
		}
		if m0.Drive != 'd' {
			t.Errorf("mapping[0].Drive = %c, want d", m0.Drive)
		}
		if m0.IsUNC || m0.IsWSL {
			t.Error("mapping[0] should not be UNC or WSL")
		}

		// Second mapping: C:/Users/Sungur/.claude -> /ccbox/.claude
		m1 := cfg.PathMappings[1]
		if m1.From != "C:/Users/Sungur/.claude" {
			t.Errorf("mapping[1].From = %q", m1.From)
		}
		if m1.Drive != 'c' {
			t.Errorf("mapping[1].Drive = %c, want c", m1.Drive)
		}

		// DirMap
		if len(cfg.DirMappings) != 1 {
			t.Fatalf("DirMappings count = %d, want 1", len(cfg.DirMappings))
		}
		if cfg.DirMappings[0].ContainerName != "-D-GitHub-ccbox" {
			t.Errorf("DirMappings[0].ContainerName = %q", cfg.DirMappings[0].ContainerName)
		}
		if cfg.DirMappings[0].NativeName != "D--GitHub-ccbox" {
			t.Errorf("DirMappings[0].NativeName = %q", cfg.DirMappings[0].NativeName)
		}

		// Extensions
		if len(cfg.Extensions) != 2 {
			t.Fatalf("Extensions count = %d, want 2", len(cfg.Extensions))
		}
	})

	t.Run("WSL mapping", func(t *testing.T) {
		cfg := ParseConfig("", "/mnt/d/GitHub/ccbox:/D/GitHub/ccbox", "", "", 0)
		if len(cfg.PathMappings) != 1 {
			t.Fatalf("count = %d, want 1", len(cfg.PathMappings))
		}
		m := cfg.PathMappings[0]
		if !m.IsWSL {
			t.Error("should be WSL mapping")
		}
		if m.Drive != 'd' {
			t.Errorf("Drive = %c, want d", m.Drive)
		}
	})

	t.Run("UNC mapping", func(t *testing.T) {
		cfg := ParseConfig("", "//server/share:/mnt/share", "", "", 0)
		if len(cfg.PathMappings) != 1 {
			t.Fatalf("count = %d, want 1", len(cfg.PathMappings))
		}
		m := cfg.PathMappings[0]
		if !m.IsUNC {
			t.Error("should be UNC mapping")
		}
	})

	t.Run("empty pathmap", func(t *testing.T) {
		cfg := ParseConfig("/src", "", "", "", 0)
		if len(cfg.PathMappings) != 0 {
			t.Errorf("expected no mappings, got %d", len(cfg.PathMappings))
		}
	})

	t.Run("default extensions", func(t *testing.T) {
		cfg := ParseConfig("/src", "", "", "", 0)
		if len(cfg.Extensions) != 2 {
			t.Fatalf("default extensions = %d, want 2", len(cfg.Extensions))
		}
		if cfg.Extensions[0] != ".json" {
			t.Errorf("ext[0] = %q, want .json", cfg.Extensions[0])
		}
		if cfg.Extensions[1] != ".jsonl" {
			t.Errorf("ext[1] = %q, want .jsonl", cfg.Extensions[1])
		}
	})

	t.Run("extensions without dot prefix", func(t *testing.T) {
		cfg := ParseConfig("/src", "", "", "json,jsonl,yaml", 0)
		for _, ext := range cfg.Extensions {
			if ext[0] != '.' {
				t.Errorf("extension %q should start with dot", ext)
			}
		}
	})

	t.Run("source dir trailing slash stripped", func(t *testing.T) {
		cfg := ParseConfig("/ccbox/.claude/", "", "", "", 0)
		if cfg.SourceDir != "/ccbox/.claude" {
			t.Errorf("SourceDir = %q, want trailing slash stripped", cfg.SourceDir)
		}
	})
}

func TestNeedsTransform(t *testing.T) {
	cfg := ParseConfig("/src", "D:/x:/D/x", "", ".json,.jsonl", 0)

	tests := []struct {
		path string
		want bool
	}{
		{"/projects/session.jsonl", true},
		{"/settings.json", true},
		{"/data.txt", false},
		{"/noext", false},
		{"/code.go", false},
		{"/file.JSON", true}, // case-insensitive
	}

	for _, tt := range tests {
		t.Run(tt.path, func(t *testing.T) {
			got := cfg.NeedsTransform(tt.path)
			if got != tt.want {
				t.Errorf("NeedsTransform(%q) = %v, want %v", tt.path, got, tt.want)
			}
		})
	}

	t.Run("no mappings", func(t *testing.T) {
		cfg2 := ParseConfig("/src", "", "", "", 0)
		if cfg2.NeedsTransform("/file.json") {
			t.Error("should return false when no path mappings")
		}
	})
}

func TestToLowerByte(t *testing.T) {
	if toLowerByte('D') != 'd' {
		t.Error("toLowerByte('D') should be 'd'")
	}
	if toLowerByte('d') != 'd' {
		t.Error("toLowerByte('d') should be 'd'")
	}
	if toLowerByte('Z') != 'z' {
		t.Error("toLowerByte('Z') should be 'z'")
	}
}

func TestIsAlpha(t *testing.T) {
	if !isAlpha('D') {
		t.Error("isAlpha('D') should be true")
	}
	if !isAlpha('d') {
		t.Error("isAlpha('d') should be true")
	}
	if isAlpha('1') {
		t.Error("isAlpha('1') should be false")
	}
	if isAlpha('/') {
		t.Error("isAlpha('/') should be false")
	}
}
