package detect

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/sungur/ccbox/internal/config"
)

func TestDetectProjectType(t *testing.T) {
	tests := []struct {
		name      string
		files     map[string]string // filename -> content
		wantStack config.LanguageStack
	}{
		{
			name:      "go project",
			files:     map[string]string{"go.mod": "module example.com/foo\n\ngo 1.21\n"},
			wantStack: config.StackGo,
		},
		{
			name:      "rust project",
			files:     map[string]string{"Cargo.toml": "[package]\nname = \"foo\"\n"},
			wantStack: config.StackRust,
		},
		{
			name:      "node project",
			files:     map[string]string{"package.json": `{"name":"foo"}`},
			wantStack: config.StackWeb,
		},
		{
			name:      "typescript project",
			files:     map[string]string{"tsconfig.json": "{}", "package.json": `{"name":"foo"}`},
			wantStack: config.StackWeb,
		},
		{
			name: "python project valid pyproject",
			files: map[string]string{
				"pyproject.toml": "[project]\nname = \"foo\"\n[build-system]\n",
			},
			wantStack: config.StackPython,
		},
		{
			name: "python project invalid pyproject",
			files: map[string]string{
				"pyproject.toml": "random content without markers",
			},
			wantStack: config.StackBase,
		},
		{
			name: "fullstack promotion web+python",
			files: map[string]string{
				"package.json":     `{"name":"foo"}`,
				"requirements.txt": "flask\n",
			},
			wantStack: config.StackFullstack,
		},
		{
			name:      "empty directory",
			files:     map[string]string{},
			wantStack: config.StackBase,
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

			result := DetectProjectType(dir, false)
			if result.RecommendedStack != tt.wantStack {
				t.Errorf("DetectProjectType() stack = %q, want %q", result.RecommendedStack, tt.wantStack)
			}
		})
	}
}

func TestDetectProjectTypeNonexistentDir(t *testing.T) {
	result := DetectProjectType("/nonexistent/path/xyz", false)
	if result.RecommendedStack != config.StackBase {
		t.Errorf("nonexistent dir should return StackBase, got %q", result.RecommendedStack)
	}
}

func TestDetectProjectTypeMakefileDemotion(t *testing.T) {
	dir := t.TempDir()
	// Go project with Makefile -> Makefile-triggered cpp should be demoted
	os.WriteFile(filepath.Join(dir, "go.mod"), []byte("module foo\n\ngo 1.21\n"), 0644)
	os.WriteFile(filepath.Join(dir, "Makefile"), []byte("all:\n\tgo build\n"), 0644)

	result := DetectProjectType(dir, false)
	if result.RecommendedStack != config.StackGo {
		t.Errorf("Go+Makefile should resolve to StackGo, got %q", result.RecommendedStack)
	}

	// Check that cpp detection is demoted
	for _, d := range result.DetectedLanguages {
		if d.Language == "cpp" && d.Confidence > ConfMakefileDemoted {
			t.Errorf("cpp from Makefile should be demoted to %d, got %d", ConfMakefileDemoted, d.Confidence)
		}
	}
}

func TestLanguageToStack(t *testing.T) {
	tests := []struct {
		lang string
		want config.LanguageStack
	}{
		{"go", config.StackGo},
		{"rust", config.StackRust},
		{"python", config.StackPython},
		{"typescript", config.StackWeb},
		{"node", config.StackWeb},
		{"bun", config.StackWeb},
		{"deno", config.StackWeb},
		{"java", config.StackJava},
		{"scala", config.StackJVM},
		{"kotlin", config.StackJVM},
		{"clojure", config.StackJVM},
		{"ruby", config.StackScripting},
		{"php", config.StackScripting},
		{"perl", config.StackScripting},
		{"dotnet", config.StackDotnet},
		{"swift", config.StackSwift},
		{"dart", config.StackDart},
		{"lua", config.StackLua},
		{"cpp", config.StackCpp},
		{"zig", config.StackSystems},
		{"nim", config.StackSystems},
		{"elixir", config.StackFunctional},
		{"haskell", config.StackFunctional},
		{"ocaml", config.StackFunctional},
		{"gleam", config.StackFunctional},
		{"r", config.StackData},
		{"julia", config.StackData},
		{"unknown", config.StackBase},
	}

	for _, tt := range tests {
		t.Run(tt.lang, func(t *testing.T) {
			got := LanguageToStack(tt.lang)
			if got != tt.want {
				t.Errorf("LanguageToStack(%q) = %q, want %q", tt.lang, got, tt.want)
			}
		})
	}
}

func TestMatchesPattern(t *testing.T) {
	tests := []struct {
		filename string
		pattern  string
		want     bool
	}{
		{"go.mod", "go.mod", true},
		{"go.sum", "go.mod", false},
		{"foo.csproj", "*.csproj", true},
		{"foo.txt", "*.csproj", false},
		{"foo.cabal", "*.cabal", true},
	}

	for _, tt := range tests {
		t.Run(tt.filename+"_"+tt.pattern, func(t *testing.T) {
			got := matchesPattern(tt.filename, tt.pattern)
			if got != tt.want {
				t.Errorf("matchesPattern(%q, %q) = %v, want %v", tt.filename, tt.pattern, got, tt.want)
			}
		})
	}
}

func TestDetectPackageManager(t *testing.T) {
	t.Run("bun", func(t *testing.T) {
		dir := t.TempDir()
		os.WriteFile(filepath.Join(dir, "package.json"), []byte(`{"packageManager":"bun@1.2.9"}`), 0644)
		got := detectPackageManager(dir)
		if got != "bun" {
			t.Errorf("detectPackageManager() = %q, want %q", got, "bun")
		}
	})

	t.Run("pnpm", func(t *testing.T) {
		dir := t.TempDir()
		os.WriteFile(filepath.Join(dir, "package.json"), []byte(`{"packageManager":"pnpm@8.0.0"}`), 0644)
		got := detectPackageManager(dir)
		if got != "pnpm" {
			t.Errorf("detectPackageManager() = %q, want %q", got, "pnpm")
		}
	})

	t.Run("no field", func(t *testing.T) {
		dir := t.TempDir()
		os.WriteFile(filepath.Join(dir, "package.json"), []byte(`{"name":"foo"}`), 0644)
		got := detectPackageManager(dir)
		if got != "" {
			t.Errorf("detectPackageManager() = %q, want empty", got)
		}
	})

	t.Run("invalid json", func(t *testing.T) {
		dir := t.TempDir()
		os.WriteFile(filepath.Join(dir, "package.json"), []byte(`not json`), 0644)
		got := detectPackageManager(dir)
		if got != "" {
			t.Errorf("detectPackageManager() = %q, want empty", got)
		}
	})

	t.Run("no package.json", func(t *testing.T) {
		dir := t.TempDir()
		got := detectPackageManager(dir)
		if got != "" {
			t.Errorf("detectPackageManager() = %q, want empty", got)
		}
	})
}

func TestScaleSourceConfidence(t *testing.T) {
	t.Run("single cpp file", func(t *testing.T) {
		dir := t.TempDir()
		os.WriteFile(filepath.Join(dir, "main.cpp"), []byte("int main(){}"), 0644)
		got := scaleSourceConfidence(dir, "cpp", ConfSourceExtension)
		if got != ConfSourceExtSingle {
			t.Errorf("single file should return %d, got %d", ConfSourceExtSingle, got)
		}
	})

	t.Run("multiple cpp files", func(t *testing.T) {
		dir := t.TempDir()
		os.WriteFile(filepath.Join(dir, "main.cpp"), []byte("int main(){}"), 0644)
		os.WriteFile(filepath.Join(dir, "util.cpp"), []byte("void util(){}"), 0644)
		got := scaleSourceConfidence(dir, "cpp", ConfSourceExtension)
		if got != ConfSourceExtension {
			t.Errorf("multiple files should return %d, got %d", ConfSourceExtension, got)
		}
	})

	t.Run("no files", func(t *testing.T) {
		dir := t.TempDir()
		got := scaleSourceConfidence(dir, "cpp", ConfSourceExtension)
		if got != ConfContentRejected {
			t.Errorf("no files should return %d, got %d", ConfContentRejected, got)
		}
	})

	t.Run("non-source confidence", func(t *testing.T) {
		dir := t.TempDir()
		got := scaleSourceConfidence(dir, "cpp", ConfPrimaryConfig)
		if got != ConfPrimaryConfig {
			t.Errorf("non-source confidence should pass through, got %d", got)
		}
	})
}
