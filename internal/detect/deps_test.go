package detect

import (
	"os"
	"path/filepath"
	"testing"
)

func TestDetectDependencies(t *testing.T) {
	tests := []struct {
		name      string
		files     map[string]string
		wantName  string
		wantEmpty bool
	}{
		{
			name:     "go project",
			files:    map[string]string{"go.mod": "module example.com/foo\n\ngo 1.21\n"},
			wantName: "go",
		},
		{
			name:     "npm with lockfile",
			files:    map[string]string{"package.json": `{"name":"foo"}`, "package-lock.json": "{}"},
			wantName: "npm",
		},
		{
			name:     "poetry",
			files:    map[string]string{"poetry.lock": "# lock", "pyproject.toml": "[tool.poetry]\nname = \"foo\"\n[build-system]\n"},
			wantName: "poetry",
		},
		{
			name:     "rust cargo",
			files:    map[string]string{"Cargo.toml": "[package]\nname = \"foo\"\n"},
			wantName: "cargo",
		},
		{
			name:      "empty directory",
			files:     map[string]string{},
			wantEmpty: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			dir := t.TempDir()
			for name, content := range tt.files {
				if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0644); err != nil {
					t.Fatal(err)
				}
			}

			results := DetectDependencies(dir)
			if tt.wantEmpty {
				if len(results) != 0 {
					t.Errorf("expected no deps, got %d: %v", len(results), results)
				}
				return
			}
			if len(results) == 0 {
				t.Fatal("expected deps, got none")
			}
			if results[0].Name != tt.wantName {
				t.Errorf("first dep name = %q, want %q", results[0].Name, tt.wantName)
			}
		})
	}
}

func TestGetInstallCommands(t *testing.T) {
	deps := []DepsInfo{
		{Name: "npm", InstallAll: "npm install", InstallProd: "npm install --production"},
		{Name: "pip", InstallAll: "pip install -r requirements.txt", InstallProd: "pip install -r requirements.txt"},
	}

	t.Run("all mode", func(t *testing.T) {
		cmds := GetInstallCommands(deps, DepsModeAll)
		if len(cmds) != 2 {
			t.Fatalf("expected 2 commands, got %d", len(cmds))
		}
		if cmds[0] != "npm install" {
			t.Errorf("cmds[0] = %q, want %q", cmds[0], "npm install")
		}
	})

	t.Run("prod mode", func(t *testing.T) {
		cmds := GetInstallCommands(deps, DepsModeProd)
		if len(cmds) != 2 {
			t.Fatalf("expected 2 commands, got %d", len(cmds))
		}
		if cmds[0] != "npm install --production" {
			t.Errorf("cmds[0] = %q, want %q", cmds[0], "npm install --production")
		}
	})

	t.Run("skip mode", func(t *testing.T) {
		cmds := GetInstallCommands(deps, DepsModeSkip)
		if cmds != nil {
			t.Errorf("skip mode should return nil, got %v", cmds)
		}
	})
}

func TestComputeHash(t *testing.T) {
	t.Run("same content same hash", func(t *testing.T) {
		dir := t.TempDir()
		os.WriteFile(filepath.Join(dir, "go.mod"), []byte("module foo\n"), 0644)

		deps := []DepsInfo{{Name: "go", Files: []string{"go.mod"}}}
		h1 := ComputeHash(deps, dir)
		h2 := ComputeHash(deps, dir)
		if h1 != h2 {
			t.Errorf("same content should produce same hash: %q != %q", h1, h2)
		}
	})

	t.Run("different content different hash", func(t *testing.T) {
		dir1 := t.TempDir()
		dir2 := t.TempDir()
		os.WriteFile(filepath.Join(dir1, "go.mod"), []byte("module foo\n"), 0644)
		os.WriteFile(filepath.Join(dir2, "go.mod"), []byte("module bar\n"), 0644)

		deps := []DepsInfo{{Name: "go", Files: []string{"go.mod"}}}
		h1 := ComputeHash(deps, dir1)
		h2 := ComputeHash(deps, dir2)
		if h1 == h2 {
			t.Errorf("different content should produce different hash: both %q", h1)
		}
	})

	t.Run("hash length 16", func(t *testing.T) {
		dir := t.TempDir()
		os.WriteFile(filepath.Join(dir, "go.mod"), []byte("module foo\n"), 0644)

		deps := []DepsInfo{{Name: "go", Files: []string{"go.mod"}}}
		h := ComputeHash(deps, dir)
		if len(h) != 16 {
			t.Errorf("hash length = %d, want 16", len(h))
		}
	})
}
