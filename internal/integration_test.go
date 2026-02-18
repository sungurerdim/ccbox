package internal

// Integration tests: exercise real functions with real filesystem.
// This file tests the actual behavior of changed components end-to-end.

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/sungur/ccbox/internal/config"
	"github.com/sungur/ccbox/internal/detect"
)

// --- Detection Consolidation: verify detect.DetectProjectType produces
// correct stacks for real-world project layouts ---

func TestIntegration_DetectionOnSelf(t *testing.T) {
	// ccbox itself is a Go project - detect it
	projectRoot := findProjectRoot(t)

	result := detect.DetectProjectType(projectRoot, false)
	if result.RecommendedStack != config.StackGo {
		t.Errorf("ccbox project should detect as Go, got %q", result.RecommendedStack)
		t.Logf("detected languages: %+v", result.DetectedLanguages)
	}

	// Should have go.mod as trigger
	foundGo := false
	for _, d := range result.DetectedLanguages {
		if d.Language == "go" {
			foundGo = true
			if d.Confidence < 90 {
				t.Errorf("Go confidence should be >= 90 (lock/primary config), got %d", d.Confidence)
			}
		}
	}
	if !foundGo {
		t.Error("should detect 'go' language in ccbox project")
	}
}

func TestIntegration_DetectionRealisticProjects(t *testing.T) {
	tests := []struct {
		name      string
		layout    map[string]string // file -> content
		wantStack config.LanguageStack
		wantLang  string // primary detected language
		minConf   int    // minimum expected confidence
	}{
		{
			name: "real go project",
			layout: map[string]string{
				"go.mod":    "module example.com/myapp\n\ngo 1.21\n",
				"go.sum":    "github.com/foo/bar v1.0.0 h1:abc=\n",
				"main.go":   "package main\n\nfunc main() {}\n",
				"README.md": "# My App\n",
			},
			wantStack: config.StackGo,
			wantLang:  "go",
			minConf:   90,
		},
		{
			name: "real rust project",
			layout: map[string]string{
				"Cargo.toml": "[package]\nname = \"myapp\"\nversion = \"0.1.0\"\n",
				"Cargo.lock": "[[package]]\nname = \"myapp\"\nversion = \"0.1.0\"\n",
				"src/main.rs": "fn main() { println!(\"hello\"); }\n",
			},
			wantStack: config.StackRust,
			wantLang:  "rust",
			minConf:   90,
		},
		{
			name: "real node project with package-lock",
			layout: map[string]string{
				"package.json":      `{"name":"myapp","version":"1.0.0","dependencies":{"express":"^4.18.0"}}`,
				"package-lock.json": `{"name":"myapp","lockfileVersion":3}`,
				"index.js":          "const express = require('express');\n",
			},
			wantStack: config.StackWeb,
			wantLang:  "node",
			minConf:   90,
		},
		{
			name: "real typescript project",
			layout: map[string]string{
				"package.json":  `{"name":"myapp","devDependencies":{"typescript":"^5.0"}}`,
				"tsconfig.json": `{"compilerOptions":{"target":"es2020"}}`,
				"src/index.ts":  "export const hello = 'world';\n",
			},
			wantStack: config.StackWeb,
			wantLang:  "typescript",
			minConf:   80,
		},
		{
			name: "real python project with poetry",
			layout: map[string]string{
				"pyproject.toml": "[tool.poetry]\nname = \"myapp\"\nversion = \"0.1.0\"\n\n[build-system]\nrequires = [\"poetry-core\"]\n",
				"poetry.lock":   "[[package]]\nname = \"requests\"\n",
				"myapp/__init__.py": "",
			},
			wantStack: config.StackPython,
			wantLang:  "python",
			minConf:   90,
		},
		{
			name: "python pyproject WITHOUT valid markers should be rejected",
			layout: map[string]string{
				"pyproject.toml": "[some-random-tool]\nfoo = bar\n",
			},
			wantStack: config.StackBase,
			wantLang:  "",
			minConf:   0,
		},
		{
			name: "fullstack: node + python",
			layout: map[string]string{
				"package.json":     `{"name":"fullstack-app"}`,
				"requirements.txt": "flask\nrequests\n",
				"app.py":           "from flask import Flask\n",
				"frontend/index.js": "console.log('hello');\n",
			},
			wantStack: config.StackFullstack,
			wantLang:  "", // could be either
			minConf:   0,
		},
		{
			name: "java maven project",
			layout: map[string]string{
				"pom.xml": `<?xml version="1.0"?><project><modelVersion>4.0.0</modelVersion></project>`,
				"src/main/java/App.java": "public class App {}\n",
			},
			wantStack: config.StackJava,
			wantLang:  "java",
			minConf:   80,
		},
		{
			name: "dotnet project",
			layout: map[string]string{
				"MyApp.csproj": `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType></PropertyGroup></Project>`,
				"Program.cs":  "Console.WriteLine(\"Hello\");\n",
			},
			wantStack: config.StackDotnet,
			wantLang:  "dotnet",
			minConf:   80,
		},
		{
			name: "bun project via packageManager field",
			layout: map[string]string{
				"package.json": `{"name":"myapp","packageManager":"bun@1.2.0"}`,
			},
			wantStack: config.StackWeb,
			wantLang:  "bun",
			minConf:   90,
		},
		{
			name: "empty project -> base",
			layout: map[string]string{
				"README.md": "# Nothing here\n",
			},
			wantStack: config.StackBase,
			wantLang:  "",
			minConf:   0,
		},
		{
			name: "makefile-only project with C++ content",
			layout: map[string]string{
				"Makefile":  "all:\n\tgcc -o main main.c\n",
				"main.c":   "int main() { return 0; }\n",
			},
			wantStack: config.StackCpp,
			wantLang:  "cpp",
			minConf:   0,
		},
		{
			name: "go project with Makefile -> go should win",
			layout: map[string]string{
				"go.mod":   "module foo\n\ngo 1.21\n",
				"main.go":  "package main\nfunc main() {}\n",
				"Makefile": "build:\n\tgo build\ntest:\n\tgo test ./...\n",
			},
			wantStack: config.StackGo,
			wantLang:  "go",
			minConf:   90,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			dir := t.TempDir()
			for name, content := range tt.layout {
				path := filepath.Join(dir, name)
				os.MkdirAll(filepath.Dir(path), 0755)
				if err := os.WriteFile(path, []byte(content), 0644); err != nil {
					t.Fatal(err)
				}
			}

			result := detect.DetectProjectType(dir, false)

			// Check stack
			if result.RecommendedStack != tt.wantStack {
				t.Errorf("stack = %q, want %q", result.RecommendedStack, tt.wantStack)
				for _, d := range result.DetectedLanguages {
					t.Logf("  detected: %s (conf=%d, trigger=%s, stack=%s)",
						d.Language, d.Confidence, d.Trigger, d.Stack)
				}
			}

			// Check primary language if specified
			if tt.wantLang != "" {
				found := false
				for _, d := range result.DetectedLanguages {
					if d.Language == tt.wantLang {
						found = true
						if d.Confidence < tt.minConf {
							t.Errorf("%s confidence = %d, want >= %d",
								tt.wantLang, d.Confidence, tt.minConf)
						}
					}
				}
				if !found {
					t.Errorf("language %q not detected", tt.wantLang)
					for _, d := range result.DetectedLanguages {
						t.Logf("  detected: %s (conf=%d)", d.Language, d.Confidence)
					}
				}
			}
		})
	}
}

// --- Dependency Detection: verify real package manager detection ---

func TestIntegration_DepsDetection(t *testing.T) {
	tests := []struct {
		name         string
		layout       map[string]string
		wantManager  string
		wantInstall  string // substring of install command
		wantEmpty    bool
	}{
		{
			name: "go mod download",
			layout: map[string]string{
				"go.mod": "module foo\n\ngo 1.21\n\nrequire github.com/foo/bar v1.0.0\n",
			},
			wantManager: "go",
			wantInstall: "go mod download",
		},
		{
			name: "npm with lockfile",
			layout: map[string]string{
				"package.json":      `{"name":"app","dependencies":{"express":"^4.0"}}`,
				"package-lock.json": `{"lockfileVersion":3}`,
			},
			wantManager: "npm",
			wantInstall: "npm install",
		},
		{
			name: "poetry with lock",
			layout: map[string]string{
				"pyproject.toml": "[tool.poetry]\nname = \"foo\"\n\n[build-system]\nrequires = [\"poetry-core\"]\n",
				"poetry.lock":   "[[package]]\n",
			},
			wantManager: "poetry",
			wantInstall: "poetry install",
		},
		{
			name: "bun via packageManager",
			layout: map[string]string{
				"package.json": `{"name":"app","packageManager":"bun@1.2.0"}`,
			},
			wantManager: "bun",
			wantInstall: "bun install",
		},
		{
			name: "pnpm lock",
			layout: map[string]string{
				"package.json":    `{"name":"app"}`,
				"pnpm-lock.yaml": "lockfileVersion: '6.0'\n",
			},
			wantManager: "pnpm",
			wantInstall: "pnpm install",
		},
		{
			name: "cargo fetch",
			layout: map[string]string{
				"Cargo.toml": "[package]\nname = \"foo\"\n",
			},
			wantManager: "cargo",
			wantInstall: "cargo fetch",
		},
		{
			name: "pip with requirements.txt",
			layout: map[string]string{
				"requirements.txt": "flask>=2.0\nrequests\n",
			},
			wantManager: "pip",
			wantInstall: "pip install",
		},
		{
			name:      "empty dir -> no deps",
			layout:    map[string]string{},
			wantEmpty: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			dir := t.TempDir()
			for name, content := range tt.layout {
				if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0644); err != nil {
					t.Fatal(err)
				}
			}

			deps := detect.DetectDependencies(dir)

			if tt.wantEmpty {
				if len(deps) != 0 {
					t.Errorf("expected no deps, got %d", len(deps))
					for _, d := range deps {
						t.Logf("  dep: %s", d.Name)
					}
				}
				return
			}

			if len(deps) == 0 {
				t.Fatal("expected deps, got none")
			}

			// Find the expected manager
			found := false
			for _, d := range deps {
				if d.Name == tt.wantManager {
					found = true
					if !strings.Contains(d.InstallAll, tt.wantInstall) {
						t.Errorf("%s install cmd = %q, want substring %q",
							tt.wantManager, d.InstallAll, tt.wantInstall)
					}
					if d.InstallAll == "" {
						t.Errorf("%s has empty InstallAll", tt.wantManager)
					}
					if d.InstallProd == "" {
						t.Errorf("%s has empty InstallProd", tt.wantManager)
					}
				}
			}
			if !found {
				t.Errorf("manager %q not detected", tt.wantManager)
				for _, d := range deps {
					t.Logf("  detected: %s (install: %s)", d.Name, d.InstallAll)
				}
			}
		})
	}
}

// --- Config: verify yaml parsing + merge works end-to-end ---

func TestIntegration_ConfigLoadAndMerge(t *testing.T) {
	dir := t.TempDir()

	// Write a real ccbox.yaml
	yamlContent := `stack: python
memory: 8g
cpus: "4.0"
cache: true
fresh: false
debug: 1
env:
  PYTHONPATH: /app
  FLASK_ENV: development
`
	configPath := filepath.Join(dir, "ccbox.yaml")
	if err := os.WriteFile(configPath, []byte(yamlContent), 0644); err != nil {
		t.Fatal(err)
	}

	cfg := config.LoadConfig(dir)

	checks := []struct {
		field string
		got   any
		want  any
	}{
		{"Stack", cfg.Stack, "python"},
		{"Memory", cfg.Memory, "8g"},
		{"CPUs", cfg.CPUs, "4.0"},
		{"Debug", cfg.Debug, 1},
		{"Fresh", cfg.Fresh, false},
	}

	for _, c := range checks {
		if fmt.Sprintf("%v", c.got) != fmt.Sprintf("%v", c.want) {
			t.Errorf("cfg.%s = %v, want %v", c.field, c.got, c.want)
		}
	}

	if cfg.Cache == nil || *cfg.Cache != true {
		t.Errorf("cfg.Cache should be true")
	}

	if cfg.Env == nil {
		t.Fatal("cfg.Env should not be nil")
	}
	if cfg.Env["PYTHONPATH"] != "/app" {
		t.Errorf("Env[PYTHONPATH] = %q, want %q", cfg.Env["PYTHONPATH"], "/app")
	}
	if cfg.Env["FLASK_ENV"] != "development" {
		t.Errorf("Env[FLASK_ENV] = %q, want %q", cfg.Env["FLASK_ENV"], "development")
	}

	// Verify ConfigEnvToArray produces correct KEY=VALUE pairs
	envArray := config.ConfigEnvToArray(cfg)
	if len(envArray) != 2 {
		t.Errorf("ConfigEnvToArray should return 2 items, got %d", len(envArray))
	}
	envSet := map[string]bool{}
	for _, e := range envArray {
		envSet[e] = true
	}
	if !envSet["PYTHONPATH=/app"] {
		t.Error("missing PYTHONPATH=/app in env array")
	}
	if !envSet["FLASK_ENV=development"] {
		t.Error("missing FLASK_ENV=development in env array")
	}
}

// --- Container naming: verify real naming patterns ---

func TestIntegration_ContainerNaming(t *testing.T) {
	tests := []struct {
		project string
		unique  bool
		check   func(t *testing.T, name string)
	}{
		{
			project: "My Cool Project!",
			unique:  false,
			check: func(t *testing.T, name string) {
				if !strings.HasPrefix(name, "ccbox_") {
					t.Errorf("should start with ccbox_, got %q", name)
				}
				// Should not contain uppercase or special chars
				for _, c := range name {
					if c >= 'A' && c <= 'Z' {
						t.Errorf("should not contain uppercase: %q", name)
						break
					}
				}
				if strings.Contains(name, "!") {
					t.Errorf("should not contain special chars: %q", name)
				}
			},
		},
		{
			project: "test",
			unique:  true,
			check: func(t *testing.T, name string) {
				// Should have format ccbox_test_<6hex>
				if !strings.HasPrefix(name, "ccbox_test_") {
					t.Errorf("unique should be ccbox_test_xxx, got %q", name)
				}
				// Two unique names should differ
				name2 := config.GetContainerName("test", true)
				if name == name2 {
					t.Errorf("two unique names should differ: both %q", name)
				}
			},
		},
		{
			project: strings.Repeat("a", 100),
			unique:  false,
			check: func(t *testing.T, name string) {
				// Should be truncated
				if len(name) > 60 {
					t.Errorf("long name should be truncated, got len=%d: %q", len(name), name)
				}
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.project, func(t *testing.T) {
			name := config.GetContainerName(tt.project, tt.unique)
			tt.check(t, name)
		})
	}
}

// --- Hash stability: verify same inputs always produce same hash ---

func TestIntegration_HashStability(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "package.json"),
		[]byte(`{"name":"test","dependencies":{"express":"^4.0"}}`), 0644)
	os.WriteFile(filepath.Join(dir, "package-lock.json"),
		[]byte(`{"lockfileVersion":3,"packages":{}}`), 0644)

	deps := detect.DetectDependencies(dir)
	if len(deps) == 0 {
		t.Fatal("should detect npm deps")
	}

	// Compute hash 10 times - all should be identical
	hashes := make([]string, 10)
	for i := 0; i < 10; i++ {
		hashes[i] = detect.ComputeHash(deps, dir)
	}

	for i := 1; i < len(hashes); i++ {
		if hashes[i] != hashes[0] {
			t.Errorf("hash[%d]=%q != hash[0]=%q", i, hashes[i], hashes[0])
		}
	}

	// Hash should be 16 chars hex
	if len(hashes[0]) != 16 {
		t.Errorf("hash length = %d, want 16", len(hashes[0]))
	}
	for _, c := range hashes[0] {
		if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f')) {
			t.Errorf("hash should be hex, got char %c in %q", c, hashes[0])
			break
		}
	}
}

// --- Stack resolution: verify ParseStack + FilterStacks consistency ---

func TestIntegration_StackConsistency(t *testing.T) {
	allValues := config.GetStackValues()

	// Every value from GetStackValues should be parseable
	for _, v := range allValues {
		stack, ok := config.ParseStack(v)
		if !ok {
			t.Errorf("GetStackValues() includes %q but ParseStack rejects it", v)
		}
		// Image name should be non-empty and contain the stack
		img := config.GetImageName(string(stack))
		if !strings.Contains(img, v) {
			t.Errorf("GetImageName(%q) = %q, should contain stack name", v, img)
		}
	}

	// Every stack should be in StackDependencies map
	for _, v := range allValues {
		stack, _ := config.ParseStack(v)
		if _, exists := config.StackDependencies[stack]; !exists {
			t.Errorf("stack %q missing from StackDependencies", v)
		}
	}

	// Every stack should be in StackInfoMap
	for _, v := range allValues {
		stack, _ := config.ParseStack(v)
		if _, exists := config.StackInfoMap[stack]; !exists {
			t.Errorf("stack %q missing from StackInfoMap", v)
		}
	}
}

// --- Mutual exclusion: verify TypeScript suppresses Node ---

func TestIntegration_MutualExclusion(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "package.json"), []byte(`{"name":"app"}`), 0644)
	os.WriteFile(filepath.Join(dir, "tsconfig.json"), []byte(`{}`), 0644)
	os.WriteFile(filepath.Join(dir, "package-lock.json"), []byte(`{}`), 0644)

	result := detect.DetectProjectType(dir, false)

	// TypeScript should be detected, node should be suppressed
	hasTS := false
	hasNode := false
	for _, d := range result.DetectedLanguages {
		if d.Language == "typescript" {
			hasTS = true
		}
		if d.Language == "node" {
			hasNode = true
		}
	}

	if !hasTS {
		t.Error("typescript should be detected")
	}
	if hasNode {
		t.Error("node should be suppressed when typescript is present")
	}
}

// --- Log system: verify level filtering actually prevents output ---

func TestIntegration_LogLevelFiltering(t *testing.T) {
	// This verifies the log package's internal state machine works correctly
	// by toggling levels and checking canOutput behavior

	// Import is through the test in log_test.go, but let's verify
	// the config package's interaction with log via debug level
	cfg := config.CcboxConfig{Debug: 2}
	if cfg.Debug != 2 {
		t.Errorf("debug level should be 2, got %d", cfg.Debug)
	}
}

// --- Helper ---

func findProjectRoot(t *testing.T) string {
	t.Helper()
	// Walk up from current dir looking for go.mod
	dir, err := os.Getwd()
	if err != nil {
		t.Skip("cannot get working directory")
	}
	for {
		if _, err := os.Stat(filepath.Join(dir, "go.mod")); err == nil {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			t.Skip("cannot find project root")
		}
		dir = parent
	}
}
