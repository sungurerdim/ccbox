package generate

import (
	"strings"
	"testing"

	"github.com/sungur/ccbox/internal/config"
)

func TestExtractBinaryName(t *testing.T) {
	tests := []struct {
		cmd  string
		want string
	}{
		{"npm install", "npm"},
		{"pip install --user flask", "pip"},
		{"go mod download", "go"},
		{"cargo fetch", "cargo"},
		{"poetry install --no-root", "poetry"},
		{"single", "single"},
		{"cmd|piped", "cmd"},
		{"cmd>redirect", "cmd"},
		{"cmd&background", "cmd"},
		{"cmd;chain", "cmd"},
	}

	for _, tt := range tests {
		t.Run(tt.cmd, func(t *testing.T) {
			got := extractBinaryName(tt.cmd)
			if got != tt.want {
				t.Errorf("extractBinaryName(%q) = %q, want %q", tt.cmd, got, tt.want)
			}
		})
	}
}

func TestGenerateEntrypoint(t *testing.T) {
	content := GenerateEntrypoint()
	if content == "" {
		t.Fatal("GenerateEntrypoint returned empty string")
	}
	if !strings.HasPrefix(content, "#!/") {
		t.Error("entrypoint should start with shebang")
	}
	// Verify key sections exist
	for _, section := range []string{"ccbox-fuse", "gosu", "claude"} {
		if !strings.Contains(content, section) {
			t.Errorf("entrypoint should contain %q", section)
		}
	}
}

func TestGenerateDockerfile(t *testing.T) {
	stacks := config.GetStackValues()

	for _, stack := range stacks {
		t.Run(stack, func(t *testing.T) {
			df := GenerateDockerfile(config.LanguageStack(stack))
			if df == "" {
				t.Fatal("GenerateDockerfile returned empty string")
			}
			if !strings.Contains(df, "FROM ") {
				t.Error("Dockerfile should contain FROM directive")
			}
			if !strings.Contains(df, "LABEL org.opencontainers.image.title=") {
				t.Error("Dockerfile should contain image title label")
			}
		})
	}
}

func TestGenerateDockerfileUnknownStack(t *testing.T) {
	df := GenerateDockerfile(config.LanguageStack("nonexistent"))
	if df == "" {
		t.Fatal("unknown stack should fallback to base")
	}
	if !strings.Contains(df, "ccbox/base") {
		t.Error("unknown stack should generate base Dockerfile")
	}
}

func TestBaseDockerfileContainsFuseAndFakepath(t *testing.T) {
	df := GenerateDockerfile(config.StackBase)

	if !strings.Contains(df, "ccbox-fuse") {
		t.Error("base Dockerfile should include FUSE binary setup")
	}
	if !strings.Contains(df, "fakepath") {
		t.Error("base Dockerfile should include fakepath.so setup")
	}
	if !strings.Contains(df, "entrypoint.sh") {
		t.Error("base Dockerfile should include entrypoint setup")
	}
	if !strings.Contains(df, "fuse3") {
		t.Error("base Dockerfile should install fuse3 package")
	}
}

func TestGuardedBinaries(t *testing.T) {
	// Key binaries should be guarded
	expected := []string{"npm", "pip", "go", "cargo", "poetry", "bun", "dotnet"}
	for _, bin := range expected {
		if !guardedBinaries[bin] {
			t.Errorf("%q should be in guardedBinaries", bin)
		}
	}

	// Non-runtime commands should not be guarded
	notGuarded := []string{"apt-get", "curl", "git", "mkdir"}
	for _, bin := range notGuarded {
		if guardedBinaries[bin] {
			t.Errorf("%q should NOT be in guardedBinaries", bin)
		}
	}
}
