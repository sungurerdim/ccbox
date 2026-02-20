package detect

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// DepsMode controls dependency installation scope.
type DepsMode string

const (
	DepsModeAll  DepsMode = "all"
	DepsModeProd DepsMode = "prod"
	DepsModeSkip DepsMode = "skip"
)

// Priority constants for dependency detection ordering.
const (
	PriorityHighest = 10
	PriorityHigh    = 5
	PriorityLow     = 3
)

// DepsInfo holds detected dependency information for a project.
type DepsInfo struct {
	Name        string   `json:"name"`
	Files       []string `json:"files"`
	InstallAll  string   `json:"installAll"`
	InstallProd string   `json:"installProd"`
	HasDev      bool     `json:"hasDev"`
	Priority    int      `json:"priority"`
}

// packageManager defines a detection configuration for a package manager.
type packageManager struct {
	name        string
	detect      []string
	installAll  string
	installProd string
	hasDev      bool
	priority    int
	detectFn    string
}

// allPackageManagers defines all supported package managers with detection rules.
var allPackageManagers = []packageManager{
	// Python
	{name: "uv", detect: []string{"uv.lock"}, installAll: "uv sync --all-extras", installProd: "uv sync --no-dev", hasDev: true, priority: PriorityHighest},
	{name: "poetry", detect: []string{"poetry.lock"}, installAll: "poetry install", installProd: "poetry install --no-dev", hasDev: true, priority: PriorityHighest},
	{name: "pdm", detect: []string{"pdm.lock"}, installAll: "pdm install", installProd: "pdm sync --prod", hasDev: true, priority: PriorityHighest},
	{name: "pdm", detect: []string{"pyproject.toml"}, detectFn: "detectPdmPyproject", priority: PriorityHigh},
	{name: "pipenv", detect: []string{"Pipfile.lock", "Pipfile"}, installAll: "pipenv install --dev", installProd: "pipenv install", hasDev: true, priority: PriorityHighest},
	{name: "pip", detect: []string{"pyproject.toml"}, detectFn: "detectPipPyproject", priority: PriorityHigh},
	{name: "pip", detect: []string{"requirements.txt"}, detectFn: "detectPipRequirements", priority: PriorityHigh},
	{name: "pip", detect: []string{"setup.py", "setup.cfg"}, detectFn: "detectPipSetup", priority: PriorityHigh},
	{name: "conda", detect: []string{"environment.yml", "environment.yaml"}, installAll: "conda env update -f environment.yml", installProd: "conda env update -f environment.yml", hasDev: false, priority: PriorityHighest},

	// JavaScript / TypeScript (including Deno)
	{name: "deno", detect: []string{"deno.lock"}, installAll: "deno install", installProd: "deno install", hasDev: false, priority: PriorityHighest},
	{name: "deno", detect: []string{"deno.json", "deno.jsonc"}, installAll: "deno install", installProd: "deno install", hasDev: false, priority: PriorityHigh},
	{name: "bun", detect: []string{"bun.lockb", "bun.lock"}, installAll: "bun install", installProd: "bun install --production", hasDev: true, priority: PriorityHighest},
	{name: "bun", detect: []string{"bunfig.toml", "package.json"}, detectFn: "detectBun", priority: PriorityHighest},
	{name: "pnpm", detect: []string{"pnpm-lock.yaml"}, installAll: "pnpm install", installProd: "pnpm install --prod", hasDev: true, priority: PriorityHighest},
	{name: "yarn", detect: []string{"yarn.lock"}, detectFn: "detectYarn", priority: PriorityHighest},
	{name: "npm", detect: []string{"package-lock.json"}, installAll: "npm install", installProd: "npm install --production", hasDev: true, priority: PriorityHighest},
	{name: "node", detect: []string{"package.json"}, detectFn: "detectNodePackageManager", priority: PriorityHigh},

	// Go
	{name: "go", detect: []string{"go.mod"}, installAll: "go mod download", installProd: "go mod download", hasDev: false, priority: PriorityHigh},

	// Rust
	{name: "cargo", detect: []string{"Cargo.toml"}, installAll: "cargo fetch", installProd: "cargo fetch", hasDev: false, priority: PriorityHigh},

	// Java / Kotlin / Scala
	{name: "maven", detect: []string{"pom.xml"}, installAll: "mvn dependency:resolve dependency:resolve-plugins -q", installProd: "mvn dependency:resolve -q", hasDev: false, priority: PriorityHigh},
	{name: "gradle", detect: []string{"build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts"}, installAll: "gradle dependencies --quiet 2>/dev/null || ./gradlew dependencies --quiet", installProd: "gradle dependencies --quiet 2>/dev/null || ./gradlew dependencies --quiet", hasDev: false, priority: PriorityHigh},
	{name: "sbt", detect: []string{"build.sbt"}, installAll: "sbt update", installProd: "sbt update", hasDev: false, priority: PriorityHigh},

	// Ruby
	{name: "bundler", detect: []string{"Gemfile", "Gemfile.lock"}, installAll: "bundle install", installProd: "bundle install --without development test", hasDev: true, priority: PriorityHigh},

	// PHP
	{name: "composer", detect: []string{"composer.json", "composer.lock"}, installAll: "composer install", installProd: "composer install --no-dev", hasDev: true, priority: PriorityHigh},

	// .NET / C#
	{name: "dotnet", detect: []string{"*.csproj", "*.fsproj", "*.sln", "packages.config"}, detectFn: "detectDotnet", priority: PriorityHigh},
	{name: "nuget", detect: []string{"nuget.config", "packages.config"}, installAll: "nuget restore", installProd: "nuget restore", hasDev: false, priority: PriorityLow},

	// Elixir / Erlang / Gleam (BEAM VM languages)
	{name: "gleam", detect: []string{"gleam.toml"}, installAll: "gleam deps download", installProd: "gleam deps download", hasDev: false, priority: PriorityHigh},
	{name: "mix", detect: []string{"mix.exs"}, installAll: "mix deps.get", installProd: "MIX_ENV=prod mix deps.get", hasDev: true, priority: PriorityHigh},
	{name: "rebar3", detect: []string{"rebar.config"}, installAll: "rebar3 get-deps", installProd: "rebar3 get-deps", hasDev: false, priority: PriorityHigh},

	// Haskell
	{name: "stack", detect: []string{"stack.yaml"}, installAll: "stack build --only-dependencies", installProd: "stack build --only-dependencies", hasDev: false, priority: PriorityHighest},
	{name: "cabal", detect: []string{"cabal.project", "*.cabal"}, detectFn: "detectCabal", priority: PriorityHigh},

	// Swift
	{name: "swift", detect: []string{"Package.swift"}, installAll: "swift package resolve", installProd: "swift package resolve", hasDev: false, priority: PriorityHigh},

	// Dart / Flutter
	{name: "pub", detect: []string{"pubspec.yaml"}, installAll: "dart pub get 2>/dev/null || flutter pub get", installProd: "dart pub get 2>/dev/null || flutter pub get", hasDev: false, priority: PriorityHigh},

	// Lua
	{name: "luarocks", detect: []string{"*.rockspec"}, detectFn: "detectLuarocks", priority: PriorityHigh},

	// R
	{name: "renv", detect: []string{"renv.lock"}, installAll: `Rscript -e 'renv::restore()'`, installProd: `Rscript -e 'renv::restore()'`, hasDev: false, priority: PriorityHigh},

	// Julia
	{name: "julia", detect: []string{"Project.toml", "Manifest.toml"}, installAll: `julia -e 'using Pkg; Pkg.instantiate()'`, installProd: `julia -e 'using Pkg; Pkg.instantiate()'`, hasDev: false, priority: PriorityHigh},

	// Clojure
	{name: "lein", detect: []string{"project.clj"}, installAll: "lein deps", installProd: "lein deps", hasDev: false, priority: PriorityHigh},
	{name: "clojure", detect: []string{"deps.edn"}, installAll: "clojure -P", installProd: "clojure -P", hasDev: false, priority: PriorityHigh},

	// Zig
	{name: "zig", detect: []string{"build.zig.zon"}, installAll: "zig fetch", installProd: "zig fetch", hasDev: false, priority: PriorityHigh},

	// Nim
	{name: "nimble", detect: []string{"*.nimble"}, detectFn: "detectNimble", priority: PriorityHigh},

	// OCaml
	{name: "opam", detect: []string{"*.opam", "dune-project"}, detectFn: "detectOpam", priority: PriorityHigh},

	// Perl
	{name: "cpanm", detect: []string{"cpanfile"}, installAll: "cpanm --installdeps .", installProd: "cpanm --installdeps . --without-develop", hasDev: true, priority: PriorityHigh},

	// C / C++
	{name: "conan", detect: []string{"conanfile.txt", "conanfile.py"}, installAll: "conan install . --build=missing", installProd: "conan install . --build=missing", hasDev: false, priority: PriorityHigh},
	{name: "vcpkg", detect: []string{"vcpkg.json"}, installAll: "vcpkg install", installProd: "vcpkg install", hasDev: false, priority: PriorityHigh},

	// Make-based (generic)
	{name: "make", detect: []string{"Makefile"}, detectFn: "detectMake", priority: 1},
}

// detectFn is a custom detection function type.
type detectFn func(dir string, files []string) *DepsInfo

// readdirGlob returns filenames in dir that end with the given suffix.
func readdirGlob(dir, ext string) []string {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var result []string
	for _, e := range entries {
		if !e.IsDir() && strings.HasSuffix(e.Name(), ext) {
			result = append(result, e.Name())
		}
	}
	return result
}

func detectPdmPyproject(dir string, files []string) *DepsInfo {
	pyprojectPath := filepath.Join(dir, "pyproject.toml")
	if _, err := os.Stat(pyprojectPath); err != nil {
		return nil
	}
	// Skip if lock file already detected
	if fileExists(filepath.Join(dir, "pdm.lock")) {
		return nil
	}
	if fileExists(filepath.Join(dir, "poetry.lock")) || fileExists(filepath.Join(dir, "uv.lock")) {
		return nil
	}

	content, err := os.ReadFile(pyprojectPath)
	if err != nil {
		return nil
	}
	if !strings.Contains(string(content), "[tool.pdm]") {
		return nil
	}

	return &DepsInfo{Name: "pdm", Files: files, InstallAll: "pdm install", InstallProd: "pdm sync --prod", HasDev: true, Priority: PriorityHigh}
}

func detectPipPyproject(dir string, files []string) *DepsInfo {
	pyprojectPath := filepath.Join(dir, "pyproject.toml")
	if _, err := os.Stat(pyprojectPath); err != nil {
		return nil
	}
	if fileExists(filepath.Join(dir, "poetry.lock")) || fileExists(filepath.Join(dir, "uv.lock")) || fileExists(filepath.Join(dir, "pdm.lock")) {
		return nil
	}

	data, err := os.ReadFile(pyprojectPath)
	if err != nil {
		return nil
	}
	content := string(data)
	if strings.Contains(content, "[tool.pdm]") {
		return nil
	}

	hasDev := false
	devMarkers := []string{"optional-dependencies", "[project.optional-dependencies]", "dev =", "test ="}
	for _, m := range devMarkers {
		if strings.Contains(content, m) {
			hasDev = true
			break
		}
	}

	installAll := `python3 -c "` +
		`import tomllib as T,subprocess as S,sys;` +
		`d=T.load(open('pyproject.toml','rb')).get('project',{});` +
		`o=d.get('optional-dependencies',{});` +
		`a=d.get('dependencies',[])+o.get('dev',[])+o.get('test',[]);` +
		`S.run([sys.executable,'-m','pip','install','--break-system-packages']+a,check=1)if a else 0` +
		`"`

	installProd := `python3 -c "` +
		`import tomllib as T,subprocess as S,sys;` +
		`d=T.load(open('pyproject.toml','rb')).get('project',{}).get('dependencies',[]);` +
		`S.run([sys.executable,'-m','pip','install','--break-system-packages']+d,check=1)if d else 0` +
		`"`

	return &DepsInfo{Name: "pip", Files: files, InstallAll: installAll, InstallProd: installProd, HasDev: hasDev, Priority: PriorityHigh}
}

func detectPipRequirements(dir string, files []string) *DepsInfo {
	reqPath := filepath.Join(dir, "requirements.txt")
	if _, err := os.Stat(reqPath); err != nil {
		return nil
	}

	devFileNames := []string{
		"requirements-dev.txt",
		"requirements-test.txt",
		"requirements_dev.txt",
		"requirements_test.txt",
		"dev-requirements.txt",
		"test-requirements.txt",
	}
	var foundDev []string
	for _, f := range devFileNames {
		if fileExists(filepath.Join(dir, f)) {
			foundDev = append(foundDev, f)
		}
	}

	pipBase := "pip install --break-system-packages"

	if len(foundDev) > 0 {
		allFiles := append([]string{"requirements.txt"}, foundDev...)
		var rArgs []string
		for _, f := range allFiles {
			rArgs = append(rArgs, "-r "+f)
		}
		devInstall := strings.Join(rArgs, " ")

		combinedFiles := append(append([]string{}, files...), foundDev...)
		return &DepsInfo{
			Name:        "pip",
			Files:       combinedFiles,
			InstallAll:  fmt.Sprintf("%s %s", pipBase, devInstall),
			InstallProd: fmt.Sprintf("%s -r requirements.txt", pipBase),
			HasDev:      true,
			Priority:    PriorityHigh,
		}
	}

	return &DepsInfo{
		Name:        "pip",
		Files:       files,
		InstallAll:  fmt.Sprintf("%s -r requirements.txt", pipBase),
		InstallProd: fmt.Sprintf("%s -r requirements.txt", pipBase),
		HasDev:      false,
		Priority:    PriorityHigh,
	}
}

func detectPipSetup(dir string, files []string) *DepsInfo {
	setupPy := filepath.Join(dir, "setup.py")
	setupCfg := filepath.Join(dir, "setup.cfg")

	if !fileExists(setupPy) && !fileExists(setupCfg) {
		return nil
	}
	if fileExists(filepath.Join(dir, "pyproject.toml")) {
		return nil
	}

	installScript := `python3 -c "` +
		`import subprocess as S,sys,glob as G;` +
		`S.run([sys.executable,'setup.py','egg_info'],capture_output=1);` +
		`r=G.glob('*.egg-info/requires.txt');` +
		`d=[l.strip()for l in open(r[0])if l.strip()and not l.startswith('[')]if r else[];` +
		`S.run([sys.executable,'-m','pip','install','--break-system-packages']+d,check=1)if d else 0` +
		`"`

	return &DepsInfo{Name: "pip", Files: files, InstallAll: installScript, InstallProd: installScript, HasDev: false, Priority: PriorityHigh}
}

func detectDotnet(dir string, _ []string) *DepsInfo {
	csproj := readdirGlob(dir, ".csproj")
	fsproj := readdirGlob(dir, ".fsproj")
	sln := readdirGlob(dir, ".sln")

	if len(csproj) > 0 || len(fsproj) > 0 || len(sln) > 0 {
		var allFiles []string
		allFiles = append(allFiles, csproj...)
		allFiles = append(allFiles, fsproj...)
		allFiles = append(allFiles, sln...)
		return &DepsInfo{Name: "dotnet", Files: allFiles, InstallAll: "dotnet restore", InstallProd: "dotnet restore", HasDev: false, Priority: PriorityHigh}
	}
	return nil
}

func detectCabal(dir string, _ []string) *DepsInfo {
	cabalFiles := readdirGlob(dir, ".cabal")
	cabalProject := fileExists(filepath.Join(dir, "cabal.project"))

	if len(cabalFiles) > 0 || cabalProject {
		files := append([]string{}, cabalFiles...)
		if cabalProject {
			files = append(files, "cabal.project")
		}
		return &DepsInfo{
			Name:        "cabal",
			Files:       files,
			InstallAll:  "cabal update && cabal build --only-dependencies",
			InstallProd: "cabal update && cabal build --only-dependencies",
			HasDev:      false,
			Priority:    PriorityHigh,
		}
	}
	return nil
}

func detectLuarocks(dir string, _ []string) *DepsInfo {
	rockspecs := readdirGlob(dir, ".rockspec")
	if len(rockspecs) > 0 {
		return &DepsInfo{
			Name:        "luarocks",
			Files:       rockspecs,
			InstallAll:  "luarocks install --only-deps *.rockspec",
			InstallProd: "luarocks install --only-deps *.rockspec",
			HasDev:      false,
			Priority:    PriorityHigh,
		}
	}
	return nil
}

func detectNimble(dir string, _ []string) *DepsInfo {
	nimbleFiles := readdirGlob(dir, ".nimble")
	if len(nimbleFiles) > 0 {
		return &DepsInfo{Name: "nimble", Files: nimbleFiles, InstallAll: "nimble install -d", InstallProd: "nimble install -d", HasDev: false, Priority: PriorityHigh}
	}
	return nil
}

func detectOpam(dir string, _ []string) *DepsInfo {
	opamFiles := readdirGlob(dir, ".opam")
	duneProject := fileExists(filepath.Join(dir, "dune-project"))

	if len(opamFiles) > 0 || duneProject {
		files := append([]string{}, opamFiles...)
		if duneProject {
			files = append(files, "dune-project")
		}
		return &DepsInfo{
			Name:        "opam",
			Files:       files,
			InstallAll:  "opam install . --deps-only -y",
			InstallProd: "opam install . --deps-only -y",
			HasDev:      false,
			Priority:    PriorityHigh,
		}
	}
	return nil
}

func detectBun(dir string, files []string) *DepsInfo {
	if fileExists(filepath.Join(dir, "bunfig.toml")) {
		return &DepsInfo{Name: "bun", Files: files, InstallAll: "bun install", InstallProd: "bun install --production", HasDev: true, Priority: PriorityHighest}
	}

	packageJSONPath := filepath.Join(dir, "package.json")
	data, err := os.ReadFile(packageJSONPath)
	if err != nil {
		return nil
	}

	var pkg struct {
		PackageManager string `json:"packageManager"`
	}
	if err := json.Unmarshal(data, &pkg); err != nil {
		return nil
	}
	if pkg.PackageManager == "bun" || strings.HasPrefix(pkg.PackageManager, "bun@") {
		return &DepsInfo{Name: "bun", Files: files, InstallAll: "bun install", InstallProd: "bun install --production", HasDev: true, Priority: PriorityHighest}
	}

	return nil
}

func detectYarn(dir string, files []string) *DepsInfo {
	lockPath := filepath.Join(dir, "yarn.lock")
	if !fileExists(lockPath) {
		return nil
	}

	content := readHead(lockPath, 500)
	isYarnBerry := strings.Contains(content, "__metadata:") || strings.Contains(content, "cacheKey:")

	if isYarnBerry {
		return &DepsInfo{Name: "yarn", Files: files, InstallAll: "yarn install", InstallProd: "yarn install", HasDev: true, Priority: PriorityHighest}
	}

	return &DepsInfo{Name: "yarn", Files: files, InstallAll: "yarn install", InstallProd: "yarn install --production", HasDev: true, Priority: PriorityHighest}
}

func detectNodePackageManager(dir string, files []string) *DepsInfo {
	packageJSONPath := filepath.Join(dir, "package.json")
	if !fileExists(packageJSONPath) {
		return nil
	}

	lockFiles := []string{"bun.lockb", "bun.lock", "pnpm-lock.yaml", "yarn.lock", "package-lock.json"}
	for _, f := range lockFiles {
		if fileExists(filepath.Join(dir, f)) {
			return nil
		}
	}
	if fileExists(filepath.Join(dir, "bunfig.toml")) {
		return nil
	}

	data, err := os.ReadFile(packageJSONPath)
	if err != nil {
		return &DepsInfo{Name: "npm", Files: files, InstallAll: "npm install", InstallProd: "npm install --production", HasDev: true, Priority: PriorityLow}
	}

	var pkg struct {
		PackageManager string `json:"packageManager"`
	}
	if err := json.Unmarshal(data, &pkg); err != nil {
		return &DepsInfo{Name: "npm", Files: files, InstallAll: "npm install", InstallProd: "npm install --production", HasDev: true, Priority: PriorityLow}
	}

	if pkg.PackageManager != "" {
		pm := strings.ToLower(pkg.PackageManager)
		type managerInfo struct {
			name        string
			installAll  string
			installProd string
		}
		managers := map[string]managerInfo{
			"bun":  {"bun", "bun install", "bun install --production"},
			"pnpm": {"pnpm", "pnpm install", "pnpm install --prod"},
			"yarn": {"yarn", "yarn install", "yarn install --production"},
			"npm":  {"npm", "npm install", "npm install --production"},
		}
		for prefix, info := range managers {
			if pm == prefix || strings.HasPrefix(pm, prefix+"@") {
				return &DepsInfo{Name: info.name, Files: files, InstallAll: info.installAll, InstallProd: info.installProd, HasDev: true, Priority: PriorityHigh}
			}
		}
	}

	return &DepsInfo{Name: "npm", Files: files, InstallAll: "npm install", InstallProd: "npm install --production", HasDev: true, Priority: PriorityLow}
}

func detectMake(dir string, files []string) *DepsInfo {
	makefilePath := filepath.Join(dir, "Makefile")
	data, err := os.ReadFile(makefilePath)
	if err != nil {
		return nil
	}

	content := string(data)
	targets := []string{"deps", "dependencies", "install", "setup"}
	for _, target := range targets {
		if strings.Contains(content, target+":") {
			return &DepsInfo{Name: "make", Files: files, InstallAll: "make " + target, InstallProd: "make " + target, HasDev: false, Priority: 1}
		}
	}
	return nil
}

// detectFunctions maps function name strings to actual Go functions.
var detectFunctions = map[string]detectFn{
	"detectPdmPyproject":       detectPdmPyproject,
	"detectPipPyproject":       detectPipPyproject,
	"detectPipRequirements":    detectPipRequirements,
	"detectPipSetup":           detectPipSetup,
	"detectDotnet":             detectDotnet,
	"detectCabal":              detectCabal,
	"detectLuarocks":           detectLuarocks,
	"detectNimble":             detectNimble,
	"detectOpam":               detectOpam,
	"detectBun":                detectBun,
	"detectYarn":               detectYarn,
	"detectNodePackageManager": detectNodePackageManager,
	"detectMake":               detectMake,
}

// fileExists returns true if the path exists and is accessible.
func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

// matchesDetectPattern checks if directory contains a file matching the pattern.
// Returns the list of matched filenames.
func matchesDetectPattern(dir, pattern string) []string {
	if strings.Contains(pattern, "*") {
		ext := strings.Replace(pattern, "*", "", 1)
		return readdirGlob(dir, ext)
	}
	if fileExists(filepath.Join(dir, pattern)) {
		return []string{pattern}
	}
	return nil
}

// DetectDependencies detects all dependency managers in a project.
// A project may have multiple dependency files (e.g., Python + Node for fullstack).
// Managers are returned sorted by priority (highest first).
func DetectDependencies(dir string) []DepsInfo {
	var results []DepsInfo
	detectedManagers := make(map[string]bool)

	for _, pm := range allPackageManagers {
		var matchedFiles []string
		for _, pattern := range pm.detect {
			matchedFiles = append(matchedFiles, matchesDetectPattern(dir, pattern)...)
		}

		if len(matchedFiles) == 0 {
			continue
		}

		if pm.detectFn != "" {
			fn, ok := detectFunctions[pm.detectFn]
			if !ok {
				continue
			}
			result := fn(dir, matchedFiles)
			if result != nil && !detectedManagers[result.Name] {
				results = append(results, *result)
				detectedManagers[result.Name] = true
			}
			continue
		}

		if detectedManagers[pm.name] {
			continue
		}

		results = append(results, DepsInfo{
			Name:        pm.name,
			Files:       matchedFiles,
			InstallAll:  pm.installAll,
			InstallProd: pm.installProd,
			HasDev:      pm.hasDev,
			Priority:    pm.priority,
		})
		detectedManagers[pm.name] = true
	}

	sort.Slice(results, func(i, j int) bool {
		return results[i].Priority > results[j].Priority
	})
	return results
}

// GetInstallCommands returns shell commands for installing detected dependencies.
func GetInstallCommands(deps []DepsInfo, mode DepsMode) []string {
	if mode == DepsModeSkip {
		return nil
	}

	var cmds []string
	for _, d := range deps {
		if mode == DepsModeAll {
			cmds = append(cmds, d.InstallAll)
		} else {
			cmds = append(cmds, d.InstallProd)
		}
	}
	return cmds
}

// ComputeHash produces a stable hash of dependency files for cache invalidation.
// Returns the first 16 hex characters of a SHA-256 hash.
func ComputeHash(deps []DepsInfo, dir string) string {
	h := sha256.New()

	// Collect unique files, sorted for determinism
	seen := make(map[string]bool)
	var allFiles []string
	for _, d := range deps {
		for _, f := range d.Files {
			if !seen[f] {
				seen[f] = true
				allFiles = append(allFiles, f)
			}
		}
	}
	sort.Strings(allFiles)

	for _, file := range allFiles {
		filePath := filepath.Join(dir, file)
		data, err := os.ReadFile(filePath)
		if err != nil {
			h.Write([]byte(file + "\n<missing>\n"))
		} else {
			h.Write([]byte(file + "\n"))
			h.Write(data)
			h.Write([]byte("\n"))
		}
	}

	return hex.EncodeToString(h.Sum(nil))[:16]
}
