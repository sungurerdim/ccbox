// Package detect provides project type detection for automatic language stack selection.
//
// Uses a confidence scoring system with:
//   - Per-pattern static scores (lock files, configs, extensions)
//   - Content validation for ambiguous files (peeks inside to confirm language)
//   - Source extension count scaling (single file = low confidence)
//   - Mutual exclusion rules (typescript suppresses node, etc.)
//   - Context-dependent demotion (Makefile demoted when primary language exists)
package detect

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/sungur/ccbox/internal/config"
	cclog "github.com/sungur/ccbox/internal/log"
)

// LanguageDetection represents a single language detection with confidence score.
type LanguageDetection struct {
	Language   string               `json:"language"`
	Confidence int                  `json:"confidence"`
	Trigger    string               `json:"trigger"`
	Stack      config.LanguageStack `json:"stack"`
}

// DetectionResult is the result of project detection.
type DetectionResult struct {
	RecommendedStack  config.LanguageStack `json:"recommendedStack"`
	DetectedLanguages []LanguageDetection  `json:"detectedLanguages"`
}

// Confidence thresholds for different signal types.
// Higher values indicate stronger language ownership signals.
// Thresholds: >=90 = definitive, >=50 = probable, <30 = weak hint.
const (
	ConfLockFile            = 95
	ConfPackageManagerField = 95
	ConfPrimaryConfig       = 90
	ConfSecondaryConfig     = 80
	ConfAmbiguousConfig     = 50
	ConfGeneralTool         = 40
	ConfSourceExtension     = 30
	ConfSourceExtSingle     = 15
	ConfMakefileDemoted     = 20
	ConfContentRejected     = 0
)

// patternEntry pairs a file pattern with its confidence score.
type patternEntry struct {
	pattern    string
	confidence int
}

// languagePatterns maps languages to their file detection patterns.
// Organized by language family: core, extended (JVM, web, systems, scripting, functional, data).
var languagePatterns = map[string][]patternEntry{
	// --- Core languages ---
	"python": {
		{"poetry.lock", ConfLockFile},
		{"uv.lock", ConfLockFile},
		{"pdm.lock", ConfLockFile},
		{"pyproject.toml", ConfPrimaryConfig},
		{"setup.py", ConfSecondaryConfig},
		{"requirements.txt", ConfSecondaryConfig},
		{"Pipfile", ConfSecondaryConfig},
		{"setup.cfg", ConfSecondaryConfig},
	},
	"node": {
		{"package-lock.json", ConfLockFile},
		{"yarn.lock", ConfLockFile},
		{"pnpm-lock.yaml", ConfLockFile},
		{"package.json", ConfPrimaryConfig},
	},
	"bun": {
		{"bun.lockb", ConfLockFile},
		{"bun.lock", ConfLockFile},
		{"bunfig.toml", ConfPrimaryConfig},
	},
	"deno": {
		{"deno.lock", ConfLockFile},
		{"deno.json", ConfPrimaryConfig},
		{"deno.jsonc", ConfPrimaryConfig},
	},
	"typescript": {
		{"tsconfig.json", ConfPrimaryConfig},
		{"tsconfig.base.json", ConfSecondaryConfig},
		{"tsconfig.*.json", ConfSecondaryConfig},
	},
	"go": {
		{"go.sum", ConfLockFile},
		{"go.mod", ConfPrimaryConfig},
	},
	"rust": {
		{"Cargo.lock", ConfLockFile},
		{"Cargo.toml", ConfPrimaryConfig},
	},
	"java": {
		{"gradle.lock", ConfLockFile},
		{"pom.xml", ConfPrimaryConfig},
		{"build.gradle", ConfPrimaryConfig},
		{"build.gradle.kts", ConfSecondaryConfig},
		{"settings.gradle", ConfSecondaryConfig},
		{"settings.gradle.kts", ConfSecondaryConfig},
	},
	// --- Extended: JVM languages ---
	"scala": {
		{"build.sbt", ConfPrimaryConfig},
		{"project/build.properties", ConfSecondaryConfig},
	},
	"clojure": {
		{"project.clj", ConfPrimaryConfig},
		{"deps.edn", ConfPrimaryConfig},
	},
	"kotlin": {
		{"build.gradle.kts", ConfPrimaryConfig},
		{"settings.gradle.kts", ConfSecondaryConfig},
	},
	// --- Extended: Scripting languages ---
	"ruby": {
		{"Gemfile.lock", ConfLockFile},
		{"Gemfile", ConfPrimaryConfig},
		{"Rakefile", ConfSecondaryConfig},
		{".ruby-version", ConfSecondaryConfig},
		{"*.gemspec", ConfSecondaryConfig},
	},
	"php": {
		{"composer.lock", ConfLockFile},
		{"composer.json", ConfPrimaryConfig},
		{"artisan", ConfSecondaryConfig},
	},
	// --- Extended: Platform languages ---
	"dotnet": {
		{"*.sln", ConfPrimaryConfig},
		{"*.csproj", ConfPrimaryConfig},
		{"*.fsproj", ConfPrimaryConfig},
		{"*.vbproj", ConfPrimaryConfig},
		{"global.json", ConfSecondaryConfig},
		{"nuget.config", ConfSecondaryConfig},
	},
	// --- Extended: Functional languages ---
	"elixir": {
		{"mix.lock", ConfLockFile},
		{"mix.exs", ConfPrimaryConfig},
	},
	"haskell": {
		{"stack.yaml", ConfPrimaryConfig},
		{"cabal.project", ConfPrimaryConfig},
		{"*.cabal", ConfPrimaryConfig},
		{"package.yaml", ConfSecondaryConfig},
	},
	"swift": {
		{"Package.swift", ConfPrimaryConfig},
		{"*.xcodeproj", ConfSecondaryConfig},
		{"*.xcworkspace", ConfSecondaryConfig},
	},
	"dart": {
		{"pubspec.lock", ConfLockFile},
		{"pubspec.yaml", ConfPrimaryConfig},
	},
	"perl": {
		{"cpanfile", ConfPrimaryConfig},
		{"Makefile.PL", ConfSecondaryConfig},
		{"Build.PL", ConfSecondaryConfig},
		{"*.pm", ConfSourceExtension},
	},
	"lua": {
		{"*.rockspec", ConfSecondaryConfig},
		{".luacheckrc", ConfSecondaryConfig},
		{"*.lua", ConfSourceExtension},
	},
	"ocaml": {
		{"dune-project", ConfPrimaryConfig},
		{"*.opam", ConfPrimaryConfig},
		{"dune", ConfSecondaryConfig},
		{"_opam", ConfSecondaryConfig},
	},
	// --- Extended: Systems languages ---
	"cpp": {
		{"CMakeLists.txt", ConfPrimaryConfig},
		{"conanfile.txt", ConfPrimaryConfig},
		{"conanfile.py", ConfPrimaryConfig},
		{"vcpkg.json", ConfPrimaryConfig},
		{"Makefile", ConfGeneralTool},
		{"*.cpp", ConfSourceExtension},
		{"*.hpp", ConfSourceExtension},
	},
	// --- Extended: Data/Science languages ---
	"r": {
		{"renv.lock", ConfLockFile},
		{"DESCRIPTION", ConfAmbiguousConfig},
		{".Rprofile", ConfSecondaryConfig},
		{"*.Rproj", ConfPrimaryConfig},
	},
	"julia": {
		{"Manifest.toml", ConfLockFile},
		{"Project.toml", ConfAmbiguousConfig},
	},
	"zig": {
		{"build.zig", ConfPrimaryConfig},
		{"build.zig.zon", ConfPrimaryConfig},
	},
	"nim": {
		{"*.nimble", ConfPrimaryConfig},
		{"nim.cfg", ConfSecondaryConfig},
		{"*.nim", ConfSourceExtension},
	},
	"gleam": {
		{"gleam.toml", ConfPrimaryConfig},
		{"manifest.toml", ConfAmbiguousConfig},
	},
}

// contentValidator validates ambiguous config files by peeking inside.
// Returns adjusted confidence (0 = reject, original = confirm).
type contentValidator func(directory string, originalConfidence int) int

// contentValidators maps language -> pattern -> validator.
var contentValidators = map[string]map[string]contentValidator{
	"python": {
		"pyproject.toml": func(dir string, conf int) int {
			content := readHead(filepath.Join(dir, "pyproject.toml"), 2048)
			markers := []string{
				"[project]",
				"[tool.poetry]",
				"[tool.pdm]",
				"[tool.setuptools]",
				"[tool.hatch]",
				"[tool.flit",
				"[build-system]",
			}
			for _, m := range markers {
				if strings.Contains(content, m) {
					return conf
				}
			}
			return ConfContentRejected
		},
	},
	"r": {
		"DESCRIPTION": func(dir string, conf int) int {
			content := readHead(filepath.Join(dir, "DESCRIPTION"), 2048)
			markers := []string{"Package:", "Type:", "Imports:", "Depends:", "License:"}
			matchCount := 0
			for _, m := range markers {
				if strings.Contains(content, m) {
					matchCount++
				}
			}
			if matchCount >= 2 {
				return conf
			}
			return ConfContentRejected
		},
	},
	"julia": {
		"Project.toml": func(dir string, conf int) int {
			content := readHead(filepath.Join(dir, "Project.toml"), 2048)
			markers := []string{"uuid", "[deps]", "[compat]", "julia ="}
			for _, m := range markers {
				if strings.Contains(content, m) {
					return conf
				}
			}
			return ConfContentRejected
		},
	},
	"gleam": {
		"manifest.toml": func(dir string, conf int) int {
			content := readHead(filepath.Join(dir, "manifest.toml"), 2048)
			if strings.Contains(content, "[packages]") {
				return conf
			}
			return ConfContentRejected
		},
	},
	"cpp": {
		"Makefile": func(dir string, conf int) int {
			content := readHead(filepath.Join(dir, "Makefile"), 4096)
			markers := []string{"gcc", "g++", "clang", "clang++", "$(CC)", "$(CXX)", ".cpp", ".c ", ".o "}
			for _, m := range markers {
				if strings.Contains(content, m) {
					return ConfSecondaryConfig
				}
			}
			return conf
		},
	},
}

// sourceExtensions lists extensions that benefit from count-based scaling.
var sourceExtensions = map[string][]string{
	"cpp":  {".cpp", ".hpp", ".cc", ".cxx", ".hxx"},
	"lua":  {".lua"},
	"nim":  {".nim"},
	"perl": {".pm", ".pl"},
}

// suppressionRule removes a target language when the suppressor is detected.
type suppressionRule struct {
	ifLang   string
	suppress string
}

var suppressionRules = []suppressionRule{
	{"typescript", "node"},
	{"bun", "node"},
	{"deno", "node"},
	{"scala", "java"},
	{"kotlin", "java"},
	{"clojure", "java"},
}

// webFamily is the set of web-related languages for promotion rules.
var webFamily = map[string]bool{
	"typescript": true,
	"node":       true,
	"bun":        true,
	"deno":       true,
}

// readHead reads the first n bytes of a file as a string.
// Returns empty string on any error.
func readHead(path string, bytes int) string {
	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer f.Close()
	buf := make([]byte, bytes)
	n, _ := f.Read(buf)
	return string(buf[:n])
}

// matchesPattern checks if a filename matches a detection pattern.
// Supports *.ext wildcard prefix patterns.
func matchesPattern(filename, pattern string) bool {
	if strings.HasPrefix(pattern, "*.") {
		ext := pattern[1:] // ".csproj", ".cabal" etc.
		return strings.HasSuffix(filename, ext)
	}
	return filename == pattern
}

// getDirFiles returns all file names in a directory (non-recursive).
func getDirFiles(directory string) []string {
	entries, err := os.ReadDir(directory)
	if err != nil {
		return nil
	}
	var files []string
	for _, e := range entries {
		if !e.IsDir() {
			files = append(files, e.Name())
		}
	}
	return files
}

// hasMatchingFile checks if a directory contains a file matching the pattern.
func hasMatchingFile(directory, pattern string) bool {
	if !strings.Contains(pattern, "*") {
		_, err := os.Stat(filepath.Join(directory, pattern))
		return err == nil
	}
	files := getDirFiles(directory)
	for _, name := range files {
		if matchesPattern(name, pattern) {
			return true
		}
	}
	return false
}

// scaleSourceConfidence scales confidence based on source file count.
// 1 file = SOURCE_EXTENSION_SINGLE (15), 2+ = SOURCE_EXTENSION (30).
func scaleSourceConfidence(directory, lang string, baseConfidence int) int {
	extensions, ok := sourceExtensions[lang]
	if !ok || baseConfidence != ConfSourceExtension {
		return baseConfidence
	}

	files := getDirFiles(directory)
	count := 0
	for _, f := range files {
		for _, ext := range extensions {
			if strings.HasSuffix(f, ext) {
				count++
				break
			}
		}
	}

	if count == 0 {
		return ConfContentRejected
	}
	if count == 1 {
		return ConfSourceExtSingle
	}
	return ConfSourceExtension
}

// detectPackageManager checks package.json for the packageManager field.
func detectPackageManager(directory string) string {
	pkgPath := filepath.Join(directory, "package.json")
	data, err := os.ReadFile(pkgPath)
	if err != nil {
		return ""
	}

	var pkg struct {
		PackageManager string `json:"packageManager"`
	}
	if err := json.Unmarshal(data, &pkg); err != nil {
		return ""
	}
	if pkg.PackageManager == "" {
		return ""
	}
	// "bun@1.2.9" -> "bun"
	parts := strings.SplitN(pkg.PackageManager, "@", 2)
	return parts[0]
}

// LanguageToStack maps a detected language to its corresponding LanguageStack.
func LanguageToStack(lang string) config.LanguageStack {
	switch lang {
	case "scala", "clojure", "kotlin":
		return config.StackJVM
	case "java":
		return config.StackJava
	case "go":
		return config.StackGo
	case "rust":
		return config.StackRust
	case "zig", "nim":
		return config.StackSystems
	case "cpp":
		return config.StackCpp
	case "bun", "node", "deno", "typescript":
		return config.StackWeb
	case "python":
		return config.StackPython
	case "lua":
		return config.StackLua
	case "ruby", "php", "perl":
		return config.StackScripting
	case "dotnet":
		return config.StackDotnet
	case "swift":
		return config.StackSwift
	case "dart":
		return config.StackDart
	case "elixir", "haskell", "ocaml", "gleam":
		return config.StackFunctional
	case "r", "julia":
		return config.StackData
	default:
		return config.StackBase
	}
}

// DetectProjectType detects the project type based on files in the directory.
//
// Scoring Algorithm:
//  1. Pattern matching: Each language has file patterns with static confidence
//     scores (LOCK_FILE=95, PRIMARY_CONFIG=90, SOURCE_EXTENSION=30, etc.).
//  2. Content validation: Ambiguous files (pyproject.toml, DESCRIPTION) are
//     peeked into to confirm language ownership. Rejects set confidence to 0.
//  3. Source count scaling: Single source file (.cpp, .lua) gets demoted to 15;
//     2+ files keep the base score of 30.
//  4. Context demotion: Makefile-triggered C++ is demoted to 20 when a higher-
//     confidence primary language is also detected.
//  5. Mutual exclusion: TypeScript suppresses Node, Bun suppresses Node, etc.
//  6. Promotion: Multi-language combos (web+python) promote to combined stacks.
//  7. Winner: Highest confidence score after all adjustments wins.
//
// Returns BASE stack if directory doesn't exist or is unreadable.
//
//nolint:gocyclo // inherent complexity from 20+ language detection rules
func DetectProjectType(directory string, verbose bool) DetectionResult {
	// Defensive: verify directory exists before scanning
	if _, err := os.Stat(directory); err != nil {
		return DetectionResult{
			RecommendedStack:  config.StackBase,
			DetectedLanguages: nil,
		}
	}

	var detections []LanguageDetection

	// Check packageManager field first (most reliable for JS ecosystem)
	pkgManager := detectPackageManager(directory)
	switch pkgManager {
	case "bun":
		detections = append(detections, LanguageDetection{
			Language:   "bun",
			Confidence: ConfPackageManagerField,
			Trigger:    "package.json#packageManager=bun",
			Stack:      config.StackWeb,
		})
	case "pnpm", "yarn", "npm":
		detections = append(detections, LanguageDetection{
			Language:   "node",
			Confidence: ConfPackageManagerField,
			Trigger:    "package.json#packageManager=" + pkgManager,
			Stack:      config.StackWeb,
		})
	}

	if verbose {
		files := getDirFiles(directory)
		cclog.Debugf("Scanning %s (%d files)", directory, len(files))
	}

	// Build set of already-detected languages (from packageManager)
	detectedLangs := make(map[string]bool)
	for _, d := range detections {
		detectedLangs[d.Language] = true
	}

	// Scan for language patterns - pick highest confidence match per language
	for lang, patterns := range languagePatterns {
		if detectedLangs[lang] {
			continue
		}

		bestConfidence := 0
		bestTrigger := ""

		for _, pe := range patterns {
			if !hasMatchingFile(directory, pe.pattern) {
				continue
			}

			adjustedConfidence := pe.confidence

			// Content validation: peek inside ambiguous files
			if validators, ok := contentValidators[lang]; ok {
				if validator, ok := validators[pe.pattern]; ok {
					adjustedConfidence = validator(directory, pe.confidence)
					if verbose && adjustedConfidence != pe.confidence {
						cclog.Debugf("  content-check: %s <- %s (%d -> %d)", lang, pe.pattern, pe.confidence, adjustedConfidence)
					}
				}
			}

			// Source extension count scaling
			adjustedConfidence = scaleSourceConfidence(directory, lang, adjustedConfidence)

			if verbose && adjustedConfidence > 0 {
				cclog.Debugf("  match: %s <- %s (%d)", lang, pe.pattern, adjustedConfidence)
			}

			if adjustedConfidence > bestConfidence {
				bestConfidence = adjustedConfidence
				bestTrigger = pe.pattern
			}
		}

		if bestConfidence > 0 {
			detections = append(detections, LanguageDetection{
				Language:   lang,
				Confidence: bestConfidence,
				Trigger:    bestTrigger,
				Stack:      LanguageToStack(lang),
			})
		}
	}

	// Makefile context-dependent scoring:
	// If a primary language (not cpp) is detected with high confidence,
	// demote Makefile-triggered cpp detection since Makefile is multi-purpose.
	cppIdx := -1
	for i, d := range detections {
		if d.Language == "cpp" {
			cppIdx = i
			break
		}
	}
	if cppIdx != -1 && detections[cppIdx].Trigger == "Makefile" {
		hasPrimary := false
		for _, d := range detections {
			if d.Language != "cpp" && d.Confidence >= ConfSecondaryConfig {
				hasPrimary = true
				break
			}
		}
		if hasPrimary {
			detections[cppIdx] = LanguageDetection{
				Language:   detections[cppIdx].Language,
				Confidence: ConfMakefileDemoted,
				Trigger:    detections[cppIdx].Trigger,
				Stack:      detections[cppIdx].Stack,
			}
		}
	}

	// Apply mutual exclusion rules: remove suppressed languages
	suppressedLangs := make(map[string]bool)
	detectedLangSet := make(map[string]bool)
	for _, d := range detections {
		detectedLangSet[d.Language] = true
	}
	for _, rule := range suppressionRules {
		if detectedLangSet[rule.ifLang] && detectedLangSet[rule.suppress] {
			suppressedLangs[rule.suppress] = true
			if verbose {
				cclog.Debugf("  suppress: %s (%s detected)", rule.suppress, rule.ifLang)
			}
		}
	}

	var filtered []LanguageDetection
	if len(suppressedLangs) > 0 {
		for _, d := range detections {
			if !suppressedLangs[d.Language] {
				filtered = append(filtered, d)
			}
		}
	} else {
		filtered = detections
	}

	// Sort by confidence (highest first)
	sort.Slice(filtered, func(i, j int) bool {
		return filtered[i].Confidence > filtered[j].Confidence
	})

	// Determine stack from highest confidence detection
	stack := config.StackBase
	if len(filtered) > 0 {
		stack = filtered[0].Stack
	}

	// Apply promotion rules: multi-language -> combined stack
	detectedLangSet2 := make(map[string]bool)
	for _, d := range filtered {
		detectedLangSet2[d.Language] = true
	}

	// Promotion: web + python -> fullstack
	hasWeb := false
	for lang := range detectedLangSet2 {
		if webFamily[lang] {
			hasWeb = true
			break
		}
	}
	if hasWeb && detectedLangSet2["python"] {
		if verbose {
			cclog.Debug("  promote: web+python -> fullstack")
		}
		return DetectionResult{
			RecommendedStack:  config.StackFullstack,
			DetectedLanguages: filtered,
		}
	}

	return DetectionResult{
		RecommendedStack:  stack,
		DetectedLanguages: filtered,
	}
}
