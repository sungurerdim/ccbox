/**
 * Dependency detection and installation for ccbox.
 *
 * Supports any programming language and tech stack with automatic detection.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { globbySync } from "globby";

/** Dependency installation mode. */
export type DepsMode = "all" | "prod" | "skip";

/** Detected dependency information for a project. */
export interface DepsInfo {
  readonly name: string; // Package manager name (e.g., "pip", "npm")
  readonly files: readonly string[]; // Files that triggered detection
  readonly installAll: string; // Command to install all deps (including dev)
  readonly installProd: string; // Command to install prod-only deps
  readonly hasDev: boolean; // Whether dev dependencies are distinguishable
  readonly priority: number; // Higher = run first
}

/** Create DepsInfo with validation. */
function createDepsInfo(
  name: string,
  files: string[],
  installAll: string,
  installProd: string,
  hasDev = true,
  priority = 0
): DepsInfo {
  return Object.freeze({
    name,
    files: Object.freeze([...files]),
    installAll,
    installProd,
    hasDev,
    priority,
  });
}

/** Package manager detection configuration. */
interface PackageManager {
  name: string;
  detect: string[];
  installAll?: string;
  installProd?: string;
  hasDev?: boolean;
  priority?: number;
  detectFn?: string;
}

// Priority constants for package managers (higher = run first)
const PRIORITY_HIGHEST = 10; // Lock files
const PRIORITY_HIGH = 5; // Standard package managers
const PRIORITY_LOW = 3; // Fallback package managers

// All supported package managers with detection rules
const PACKAGE_MANAGERS: PackageManager[] = [
  // ══════════════════════════════════════════════════════════════════════════
  // Python
  // ══════════════════════════════════════════════════════════════════════════
  {
    name: "uv",
    detect: ["uv.lock"],
    installAll: "uv sync --all-extras",
    installProd: "uv sync --no-dev",
    priority: PRIORITY_HIGHEST,
  },
  {
    name: "poetry",
    detect: ["poetry.lock"],
    installAll: "poetry install",
    installProd: "poetry install --no-dev",
    priority: PRIORITY_HIGHEST,
  },
  {
    name: "pipenv",
    detect: ["Pipfile.lock", "Pipfile"],
    installAll: "pipenv install --dev",
    installProd: "pipenv install",
    priority: PRIORITY_HIGHEST,
  },
  {
    name: "pip",
    detect: ["pyproject.toml"],
    detectFn: "detectPipPyproject",
    priority: PRIORITY_HIGH,
  },
  {
    name: "pip",
    detect: ["requirements.txt"],
    detectFn: "detectPipRequirements",
    priority: PRIORITY_HIGH,
  },
  {
    name: "pip",
    detect: ["setup.py", "setup.cfg"],
    detectFn: "detectPipSetup",
    priority: PRIORITY_HIGH,
  },
  {
    name: "conda",
    detect: ["environment.yml", "environment.yaml"],
    installAll: "conda env update -f environment.yml",
    installProd: "conda env update -f environment.yml",
    hasDev: false,
    priority: PRIORITY_HIGHEST,
  },
  // ══════════════════════════════════════════════════════════════════════════
  // JavaScript / TypeScript
  // ══════════════════════════════════════════════════════════════════════════
  {
    name: "bun",
    detect: ["bun.lockb"],
    installAll: "bun install",
    installProd: "bun install --production",
    priority: PRIORITY_HIGHEST,
  },
  {
    name: "bun",
    detect: ["bunfig.toml", "package.json"],
    detectFn: "detectBun",
    priority: PRIORITY_HIGHEST,
  },
  {
    name: "pnpm",
    detect: ["pnpm-lock.yaml"],
    installAll: "pnpm install",
    installProd: "pnpm install --prod",
    priority: PRIORITY_HIGHEST,
  },
  {
    name: "yarn",
    detect: ["yarn.lock"],
    installAll: "yarn install",
    installProd: "yarn install --production",
    priority: PRIORITY_HIGHEST,
  },
  {
    name: "npm",
    detect: ["package-lock.json", "package.json"],
    installAll: "npm install",
    installProd: "npm install --production",
    priority: PRIORITY_HIGH,
  },
  // ══════════════════════════════════════════════════════════════════════════
  // Go
  // ══════════════════════════════════════════════════════════════════════════
  {
    name: "go",
    detect: ["go.mod"],
    installAll: "go mod download",
    installProd: "go mod download",
    hasDev: false,
    priority: PRIORITY_HIGH,
  },
  // ══════════════════════════════════════════════════════════════════════════
  // Rust
  // ══════════════════════════════════════════════════════════════════════════
  {
    name: "cargo",
    detect: ["Cargo.toml"],
    installAll: "cargo fetch",
    installProd: "cargo fetch",
    hasDev: false,
    priority: PRIORITY_HIGH,
  },
  // ══════════════════════════════════════════════════════════════════════════
  // Java / Kotlin / Scala
  // ══════════════════════════════════════════════════════════════════════════
  {
    name: "maven",
    detect: ["pom.xml"],
    installAll: "mvn dependency:resolve dependency:resolve-plugins -q",
    installProd: "mvn dependency:resolve -q",
    hasDev: false,
    priority: PRIORITY_HIGH,
  },
  {
    name: "gradle",
    detect: ["build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts"],
    installAll: "gradle dependencies --quiet 2>/dev/null || ./gradlew dependencies --quiet",
    installProd: "gradle dependencies --quiet 2>/dev/null || ./gradlew dependencies --quiet",
    hasDev: false,
    priority: PRIORITY_HIGH,
  },
  {
    name: "sbt",
    detect: ["build.sbt"],
    installAll: "sbt update",
    installProd: "sbt update",
    hasDev: false,
    priority: PRIORITY_HIGH,
  },
  // ══════════════════════════════════════════════════════════════════════════
  // Ruby
  // ══════════════════════════════════════════════════════════════════════════
  {
    name: "bundler",
    detect: ["Gemfile", "Gemfile.lock"],
    installAll: "bundle install",
    installProd: "bundle install --without development test",
    priority: PRIORITY_HIGH,
  },
  // ══════════════════════════════════════════════════════════════════════════
  // PHP
  // ══════════════════════════════════════════════════════════════════════════
  {
    name: "composer",
    detect: ["composer.json", "composer.lock"],
    installAll: "composer install",
    installProd: "composer install --no-dev",
    priority: PRIORITY_HIGH,
  },
  // ══════════════════════════════════════════════════════════════════════════
  // .NET / C#
  // ══════════════════════════════════════════════════════════════════════════
  {
    name: "dotnet",
    detect: ["*.csproj", "*.fsproj", "*.sln", "packages.config"],
    detectFn: "detectDotnet",
    priority: PRIORITY_HIGH,
  },
  {
    name: "nuget",
    detect: ["nuget.config", "packages.config"],
    installAll: "nuget restore",
    installProd: "nuget restore",
    hasDev: false,
    priority: PRIORITY_LOW,
  },
  // ══════════════════════════════════════════════════════════════════════════
  // Elixir / Erlang
  // ══════════════════════════════════════════════════════════════════════════
  {
    name: "mix",
    detect: ["mix.exs"],
    installAll: "mix deps.get",
    installProd: "MIX_ENV=prod mix deps.get",
    priority: PRIORITY_HIGH,
  },
  {
    name: "rebar3",
    detect: ["rebar.config"],
    installAll: "rebar3 get-deps",
    installProd: "rebar3 get-deps",
    hasDev: false,
    priority: PRIORITY_HIGH,
  },
  // ══════════════════════════════════════════════════════════════════════════
  // Haskell
  // ══════════════════════════════════════════════════════════════════════════
  {
    name: "stack",
    detect: ["stack.yaml"],
    installAll: "stack build --only-dependencies",
    installProd: "stack build --only-dependencies",
    hasDev: false,
    priority: PRIORITY_HIGHEST,
  },
  {
    name: "cabal",
    detect: ["cabal.project", "*.cabal"],
    detectFn: "detectCabal",
    priority: PRIORITY_HIGH,
  },
  // ══════════════════════════════════════════════════════════════════════════
  // Swift
  // ══════════════════════════════════════════════════════════════════════════
  {
    name: "swift",
    detect: ["Package.swift"],
    installAll: "swift package resolve",
    installProd: "swift package resolve",
    hasDev: false,
    priority: PRIORITY_HIGH,
  },
  // ══════════════════════════════════════════════════════════════════════════
  // Dart / Flutter
  // ══════════════════════════════════════════════════════════════════════════
  {
    name: "pub",
    detect: ["pubspec.yaml"],
    installAll: "dart pub get 2>/dev/null || flutter pub get",
    installProd: "dart pub get 2>/dev/null || flutter pub get",
    hasDev: false,
    priority: PRIORITY_HIGH,
  },
  // ══════════════════════════════════════════════════════════════════════════
  // Lua
  // ══════════════════════════════════════════════════════════════════════════
  {
    name: "luarocks",
    detect: ["*.rockspec"],
    detectFn: "detectLuarocks",
    priority: PRIORITY_HIGH,
  },
  // ══════════════════════════════════════════════════════════════════════════
  // R
  // ══════════════════════════════════════════════════════════════════════════
  {
    name: "renv",
    detect: ["renv.lock"],
    installAll: "Rscript -e 'renv::restore()'",
    installProd: "Rscript -e 'renv::restore()'",
    hasDev: false,
    priority: PRIORITY_HIGH,
  },
  // ══════════════════════════════════════════════════════════════════════════
  // Julia
  // ══════════════════════════════════════════════════════════════════════════
  {
    name: "julia",
    detect: ["Project.toml", "Manifest.toml"],
    installAll: "julia -e 'using Pkg; Pkg.instantiate()'",
    installProd: "julia -e 'using Pkg; Pkg.instantiate()'",
    hasDev: false,
    priority: PRIORITY_HIGH,
  },
  // ══════════════════════════════════════════════════════════════════════════
  // Clojure
  // ══════════════════════════════════════════════════════════════════════════
  {
    name: "lein",
    detect: ["project.clj"],
    installAll: "lein deps",
    installProd: "lein deps",
    hasDev: false,
    priority: PRIORITY_HIGH,
  },
  {
    name: "clojure",
    detect: ["deps.edn"],
    installAll: "clojure -P",
    installProd: "clojure -P",
    hasDev: false,
    priority: PRIORITY_HIGH,
  },
  // ══════════════════════════════════════════════════════════════════════════
  // Zig
  // ══════════════════════════════════════════════════════════════════════════
  {
    name: "zig",
    detect: ["build.zig.zon"],
    installAll: "zig fetch",
    installProd: "zig fetch",
    hasDev: false,
    priority: PRIORITY_HIGH,
  },
  // ══════════════════════════════════════════════════════════════════════════
  // Nim
  // ══════════════════════════════════════════════════════════════════════════
  {
    name: "nimble",
    detect: ["*.nimble"],
    detectFn: "detectNimble",
    priority: PRIORITY_HIGH,
  },
  // ══════════════════════════════════════════════════════════════════════════
  // OCaml
  // ══════════════════════════════════════════════════════════════════════════
  {
    name: "opam",
    detect: ["*.opam", "dune-project"],
    detectFn: "detectOpam",
    priority: PRIORITY_HIGH,
  },
  // ══════════════════════════════════════════════════════════════════════════
  // Perl
  // ══════════════════════════════════════════════════════════════════════════
  {
    name: "cpanm",
    detect: ["cpanfile"],
    installAll: "cpanm --installdeps .",
    installProd: "cpanm --installdeps . --without-develop",
    priority: PRIORITY_HIGH,
  },
  // ══════════════════════════════════════════════════════════════════════════
  // C / C++
  // ══════════════════════════════════════════════════════════════════════════
  {
    name: "conan",
    detect: ["conanfile.txt", "conanfile.py"],
    installAll: "conan install . --build=missing",
    installProd: "conan install . --build=missing",
    hasDev: false,
    priority: PRIORITY_HIGH,
  },
  {
    name: "vcpkg",
    detect: ["vcpkg.json"],
    installAll: "vcpkg install",
    installProd: "vcpkg install",
    hasDev: false,
    priority: PRIORITY_HIGH,
  },
  // ══════════════════════════════════════════════════════════════════════════
  // Make-based (generic)
  // ══════════════════════════════════════════════════════════════════════════
  {
    name: "make",
    detect: ["Makefile"],
    detectFn: "detectMake",
    priority: 1, // Low priority, fallback
  },
];

// ══════════════════════════════════════════════════════════════════════════════
// Custom detection functions for complex cases
// ══════════════════════════════════════════════════════════════════════════════

type DetectFn = (path: string, files: string[]) => DepsInfo | null;

function detectPipPyproject(path: string, files: string[]): DepsInfo | null {
  const pyprojectPath = join(path, "pyproject.toml");
  if (!existsSync(pyprojectPath)) {return null;}

  const content = readFileSync(pyprojectPath, "utf-8");

  // Skip if managed by poetry/uv
  if (existsSync(join(path, "poetry.lock")) || existsSync(join(path, "uv.lock"))) {
    return null;
  }

  const hasDev = ["optional-dependencies", "[project.optional-dependencies]", "dev =", "test ="].some(
    (x) => content.includes(x)
  );

  // Python script to parse pyproject.toml and install dependencies
  const installScriptAll =
    'python3 -c "' +
    "import tomllib as T,subprocess as S,sys;" +
    "d=T.load(open('pyproject.toml','rb')).get('project',{});" +
    "o=d.get('optional-dependencies',{});" +
    "a=d.get('dependencies',[])+o.get('dev',[])+o.get('test',[]);" +
    "S.run([sys.executable,'-m','pip','install','--break-system-packages']+a,check=1)if a else 0" +
    '"';

  const installScriptProd =
    'python3 -c "' +
    "import tomllib as T,subprocess as S,sys;" +
    "d=T.load(open('pyproject.toml','rb')).get('project',{}).get('dependencies',[]);" +
    "S.run([sys.executable,'-m','pip','install','--break-system-packages']+d,check=1)if d else 0" +
    '"';

  return createDepsInfo("pip", files, installScriptAll, installScriptProd, hasDev, PRIORITY_HIGH);
}

function detectPipRequirements(path: string, files: string[]): DepsInfo | null {
  const reqPath = join(path, "requirements.txt");
  if (!existsSync(reqPath)) {return null;}

  const devFiles = [
    "requirements-dev.txt",
    "requirements-test.txt",
    "requirements_dev.txt",
    "requirements_test.txt",
    "dev-requirements.txt",
    "test-requirements.txt",
  ];
  const foundDev = devFiles.filter((f) => existsSync(join(path, f)));

  const pipBase = "pip install --break-system-packages";

  if (foundDev.length > 0) {
    const devInstall = ["requirements.txt", ...foundDev].map((f) => `-r ${f}`).join(" ");
    return createDepsInfo(
      "pip",
      [...files, ...foundDev],
      `${pipBase} ${devInstall}`,
      `${pipBase} -r requirements.txt`,
      true,
      PRIORITY_HIGH
    );
  }

  return createDepsInfo(
    "pip",
    files,
    `${pipBase} -r requirements.txt`,
    `${pipBase} -r requirements.txt`,
    false,
    PRIORITY_HIGH
  );
}

function detectPipSetup(path: string, files: string[]): DepsInfo | null {
  const setupPy = join(path, "setup.py");
  const setupCfg = join(path, "setup.cfg");

  if (!existsSync(setupPy) && !existsSync(setupCfg)) {return null;}

  // Skip if pyproject.toml exists
  if (existsSync(join(path, "pyproject.toml"))) {return null;}

  const installScript =
    'python3 -c "' +
    "import subprocess as S,sys,glob as G;" +
    "S.run([sys.executable,'setup.py','egg_info'],capture_output=1);" +
    "r=G.glob('*.egg-info/requires.txt');" +
    "d=[l.strip()for l in open(r[0])if l.strip()and not l.startswith('[')]if r else[];" +
    "S.run([sys.executable,'-m','pip','install','--break-system-packages']+d,check=1)if d else 0" +
    '"';

  return createDepsInfo("pip", files, installScript, installScript, false, PRIORITY_HIGH);
}

function detectDotnet(path: string, _files: string[]): DepsInfo | null {
  const csproj = globbySync("*.csproj", { cwd: path });
  const fsproj = globbySync("*.fsproj", { cwd: path });
  const sln = globbySync("*.sln", { cwd: path });

  if (csproj.length > 0 || fsproj.length > 0 || sln.length > 0) {
    return createDepsInfo(
      "dotnet",
      [...csproj, ...fsproj, ...sln],
      "dotnet restore",
      "dotnet restore",
      false,
      PRIORITY_HIGH
    );
  }
  return null;
}

function detectCabal(path: string, _files: string[]): DepsInfo | null {
  const cabalFiles = globbySync("*.cabal", { cwd: path });
  const cabalProject = existsSync(join(path, "cabal.project"));

  if (cabalFiles.length > 0 || cabalProject) {
    const files = [...cabalFiles];
    if (cabalProject) {files.push("cabal.project");}

    return createDepsInfo(
      "cabal",
      files,
      "cabal update && cabal build --only-dependencies",
      "cabal update && cabal build --only-dependencies",
      false,
      PRIORITY_HIGH
    );
  }
  return null;
}

function detectLuarocks(path: string, _files: string[]): DepsInfo | null {
  const rockspecs = globbySync("*.rockspec", { cwd: path });
  if (rockspecs.length > 0) {
    return createDepsInfo(
      "luarocks",
      rockspecs,
      "luarocks install --only-deps *.rockspec",
      "luarocks install --only-deps *.rockspec",
      false,
      PRIORITY_HIGH
    );
  }
  return null;
}

function detectNimble(path: string, _files: string[]): DepsInfo | null {
  const nimbleFiles = globbySync("*.nimble", { cwd: path });
  if (nimbleFiles.length > 0) {
    return createDepsInfo("nimble", nimbleFiles, "nimble install -d", "nimble install -d", false, PRIORITY_HIGH);
  }
  return null;
}

function detectOpam(path: string, _files: string[]): DepsInfo | null {
  const opamFiles = globbySync("*.opam", { cwd: path });
  const duneProject = existsSync(join(path, "dune-project"));

  if (opamFiles.length > 0 || duneProject) {
    const files = [...opamFiles];
    if (duneProject) {files.push("dune-project");}

    return createDepsInfo(
      "opam",
      files,
      "opam install . --deps-only -y",
      "opam install . --deps-only -y",
      false,
      PRIORITY_HIGH
    );
  }
  return null;
}

function detectBun(path: string, files: string[]): DepsInfo | null {
  // bunfig.toml varsa kesinlikle bun
  if (existsSync(join(path, "bunfig.toml"))) {
    return createDepsInfo("bun", files, "bun install", "bun install --production", true, PRIORITY_HIGHEST);
  }

  // package.json içinde packageManager field'ı kontrol et
  const packageJsonPath = join(path, "package.json");
  if (existsSync(packageJsonPath)) {
    try {
      const content = readFileSync(packageJsonPath, "utf-8");
      const pkg = JSON.parse(content);
      // Support both "bun" and "bun@x.x.x" formats
      if (pkg.packageManager && typeof pkg.packageManager === "string" &&
          (pkg.packageManager === "bun" || pkg.packageManager.startsWith("bun@"))) {
        return createDepsInfo("bun", files, "bun install", "bun install --production", true, PRIORITY_HIGHEST);
      }
    } catch {
      // JSON parse hatası - devam et
    }
  }

  return null;
}

function detectMake(path: string, files: string[]): DepsInfo | null {
  const makefilePath = join(path, "Makefile");
  if (!existsSync(makefilePath)) {return null;}

  const content = readFileSync(makefilePath, "utf-8");
  const targets = ["deps", "install", "dependencies", "setup"];
  const hasDepsTarget = targets.some((t) => content.includes(`${t}:`));

  if (hasDepsTarget) {
    for (const target of ["deps", "dependencies", "install", "setup"]) {
      if (content.includes(`${target}:`)) {
        return createDepsInfo("make", files, `make ${target}`, `make ${target}`, false, 1);
      }
    }
  }
  return null;
}

// Detection function registry
const DETECT_FUNCTIONS: Record<string, DetectFn> = {
  detectPipPyproject,
  detectPipRequirements,
  detectPipSetup,
  detectDotnet,
  detectCabal,
  detectLuarocks,
  detectNimble,
  detectOpam,
  detectBun,
  detectMake,
};

// ══════════════════════════════════════════════════════════════════════════════
// Main detection logic
// ══════════════════════════════════════════════════════════════════════════════

function matchesPattern(path: string, pattern: string): string[] {
  if (pattern.includes("*")) {
    return globbySync(pattern, { cwd: path });
  } else if (existsSync(join(path, pattern))) {
    return [pattern];
  }
  return [];
}

/**
 * Detect all dependency managers in a project.
 *
 * A project may have multiple dependency files (e.g., Python + Node for fullstack).
 * Managers are returned sorted by priority (highest first).
 *
 * @param path - Project root directory.
 * @returns List of detected DepsInfo, sorted by priority.
 */
export function detectDependencies(path: string): DepsInfo[] {
  const results: DepsInfo[] = [];
  const detectedManagers = new Set<string>();

  for (const pm of PACKAGE_MANAGERS) {
    // Check if any detection files exist
    const matchedFiles: string[] = [];
    for (const pattern of pm.detect) {
      matchedFiles.push(...matchesPattern(path, pattern));
    }

    if (matchedFiles.length === 0) {continue;}

    // Use custom detection function if provided
    if (pm.detectFn) {
      const fn = DETECT_FUNCTIONS[pm.detectFn];
      if (fn) {
        const result = fn(path, matchedFiles);
        if (result && !detectedManagers.has(result.name)) {
          results.push(result);
          detectedManagers.add(result.name);
        }
      }
      continue;
    }

    // Skip if we already detected this manager
    if (detectedManagers.has(pm.name)) {continue;}

    // Create DepsInfo from static config
    results.push(
      createDepsInfo(
        pm.name,
        matchedFiles,
        pm.installAll ?? "",
        pm.installProd ?? "",
        pm.hasDev ?? true,
        pm.priority ?? PRIORITY_HIGH
      )
    );
    detectedManagers.add(pm.name);
  }

  // Sort by priority (highest first)
  results.sort((a, b) => b.priority - a.priority);
  return results;
}

/**
 * Get installation commands for detected dependencies.
 *
 * @param depsList - List of detected dependencies.
 * @param mode - Installation mode (all, prod, skip).
 * @returns List of shell commands to run.
 */
export function getInstallCommands(depsList: DepsInfo[], mode: DepsMode): string[] {
  if (mode === "skip") {return [];}

  return depsList.map((deps) => (mode === "all" ? deps.installAll : deps.installProd));
}
