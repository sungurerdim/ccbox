/**
 * Dependency detection for ccbox.
 *
 * Detects package managers and dependency files in a project directory.
 * Supports any programming language and tech stack with automatic detection.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PRIORITY } from "../constants.js";

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

/**
 * Create DepsInfo with validation and immutability.
 */
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

// All supported package managers with detection rules
export const PACKAGE_MANAGERS: PackageManager[] = [
  // Python
  {
    name: "uv",
    detect: ["uv.lock"],
    installAll: "uv sync --all-extras",
    installProd: "uv sync --no-dev",
    priority: PRIORITY.HIGHEST,
  },
  {
    name: "poetry",
    detect: ["poetry.lock"],
    installAll: "poetry install",
    installProd: "poetry install --no-dev",
    priority: PRIORITY.HIGHEST,
  },
  {
    name: "pdm",
    detect: ["pdm.lock"],
    installAll: "pdm install",
    installProd: "pdm sync --prod",
    priority: PRIORITY.HIGHEST,
  },
  {
    name: "pdm",
    detect: ["pyproject.toml"],
    detectFn: "detectPdmPyproject",
    priority: PRIORITY.HIGH,
  },
  {
    name: "pipenv",
    detect: ["Pipfile.lock", "Pipfile"],
    installAll: "pipenv install --dev",
    installProd: "pipenv install",
    priority: PRIORITY.HIGHEST,
  },
  {
    name: "pip",
    detect: ["pyproject.toml"],
    detectFn: "detectPipPyproject",
    priority: PRIORITY.HIGH,
  },
  {
    name: "pip",
    detect: ["requirements.txt"],
    detectFn: "detectPipRequirements",
    priority: PRIORITY.HIGH,
  },
  {
    name: "pip",
    detect: ["setup.py", "setup.cfg"],
    detectFn: "detectPipSetup",
    priority: PRIORITY.HIGH,
  },
  {
    name: "conda",
    detect: ["environment.yml", "environment.yaml"],
    installAll: "conda env update -f environment.yml",
    installProd: "conda env update -f environment.yml",
    hasDev: false,
    priority: PRIORITY.HIGHEST,
  },
  // JavaScript / TypeScript (including Deno)
  {
    name: "deno",
    detect: ["deno.lock"],
    installAll: "deno install",
    installProd: "deno install",
    hasDev: false,
    priority: PRIORITY.HIGHEST,
  },
  {
    name: "deno",
    detect: ["deno.json", "deno.jsonc"],
    installAll: "deno install",
    installProd: "deno install",
    hasDev: false,
    priority: PRIORITY.HIGH,
  },
  {
    name: "bun",
    detect: ["bun.lockb", "bun.lock"],
    installAll: "bun install",
    installProd: "bun install --production",
    priority: PRIORITY.HIGHEST,
  },
  {
    name: "bun",
    detect: ["bunfig.toml", "package.json"],
    detectFn: "detectBun",
    priority: PRIORITY.HIGHEST,
  },
  {
    name: "pnpm",
    detect: ["pnpm-lock.yaml"],
    installAll: "pnpm install",
    installProd: "pnpm install --prod",
    priority: PRIORITY.HIGHEST,
  },
  {
    name: "yarn",
    detect: ["yarn.lock"],
    detectFn: "detectYarn",
    priority: PRIORITY.HIGHEST,
  },
  {
    name: "npm",
    detect: ["package-lock.json"],
    installAll: "npm install",
    installProd: "npm install --production",
    priority: PRIORITY.HIGHEST,
  },
  {
    name: "node",
    detect: ["package.json"],
    detectFn: "detectNodePackageManager",
    priority: PRIORITY.HIGH,
  },
  // Go
  {
    name: "go",
    detect: ["go.mod"],
    installAll: "go mod download",
    installProd: "go mod download",
    hasDev: false,
    priority: PRIORITY.HIGH,
  },
  // Rust
  {
    name: "cargo",
    detect: ["Cargo.toml"],
    installAll: "cargo fetch",
    installProd: "cargo fetch",
    hasDev: false,
    priority: PRIORITY.HIGH,
  },
  // Java / Kotlin / Scala
  {
    name: "maven",
    detect: ["pom.xml"],
    installAll: "mvn dependency:resolve dependency:resolve-plugins -q",
    installProd: "mvn dependency:resolve -q",
    hasDev: false,
    priority: PRIORITY.HIGH,
  },
  {
    name: "gradle",
    detect: ["build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts"],
    installAll: "gradle dependencies --quiet 2>/dev/null || ./gradlew dependencies --quiet",
    installProd: "gradle dependencies --quiet 2>/dev/null || ./gradlew dependencies --quiet",
    hasDev: false,
    priority: PRIORITY.HIGH,
  },
  {
    name: "sbt",
    detect: ["build.sbt"],
    installAll: "sbt update",
    installProd: "sbt update",
    hasDev: false,
    priority: PRIORITY.HIGH,
  },
  // Ruby
  {
    name: "bundler",
    detect: ["Gemfile", "Gemfile.lock"],
    installAll: "bundle install",
    installProd: "bundle install --without development test",
    priority: PRIORITY.HIGH,
  },
  // PHP
  {
    name: "composer",
    detect: ["composer.json", "composer.lock"],
    installAll: "composer install",
    installProd: "composer install --no-dev",
    priority: PRIORITY.HIGH,
  },
  // .NET / C#
  {
    name: "dotnet",
    detect: ["*.csproj", "*.fsproj", "*.sln", "packages.config"],
    detectFn: "detectDotnet",
    priority: PRIORITY.HIGH,
  },
  {
    name: "nuget",
    detect: ["nuget.config", "packages.config"],
    installAll: "nuget restore",
    installProd: "nuget restore",
    hasDev: false,
    priority: PRIORITY.LOW,
  },
  // Elixir / Erlang / Gleam (BEAM VM languages)
  {
    name: "gleam",
    detect: ["gleam.toml"],
    installAll: "gleam deps download",
    installProd: "gleam deps download",
    hasDev: false,
    priority: PRIORITY.HIGH,
  },
  {
    name: "mix",
    detect: ["mix.exs"],
    installAll: "mix deps.get",
    installProd: "MIX_ENV=prod mix deps.get",
    priority: PRIORITY.HIGH,
  },
  {
    name: "rebar3",
    detect: ["rebar.config"],
    installAll: "rebar3 get-deps",
    installProd: "rebar3 get-deps",
    hasDev: false,
    priority: PRIORITY.HIGH,
  },
  // Haskell
  {
    name: "stack",
    detect: ["stack.yaml"],
    installAll: "stack build --only-dependencies",
    installProd: "stack build --only-dependencies",
    hasDev: false,
    priority: PRIORITY.HIGHEST,
  },
  {
    name: "cabal",
    detect: ["cabal.project", "*.cabal"],
    detectFn: "detectCabal",
    priority: PRIORITY.HIGH,
  },
  // Swift
  {
    name: "swift",
    detect: ["Package.swift"],
    installAll: "swift package resolve",
    installProd: "swift package resolve",
    hasDev: false,
    priority: PRIORITY.HIGH,
  },
  // Dart / Flutter
  {
    name: "pub",
    detect: ["pubspec.yaml"],
    installAll: "dart pub get 2>/dev/null || flutter pub get",
    installProd: "dart pub get 2>/dev/null || flutter pub get",
    hasDev: false,
    priority: PRIORITY.HIGH,
  },
  // Lua
  {
    name: "luarocks",
    detect: ["*.rockspec"],
    detectFn: "detectLuarocks",
    priority: PRIORITY.HIGH,
  },
  // R
  {
    name: "renv",
    detect: ["renv.lock"],
    installAll: "Rscript -e 'renv::restore()'",
    installProd: "Rscript -e 'renv::restore()'",
    hasDev: false,
    priority: PRIORITY.HIGH,
  },
  // Julia
  {
    name: "julia",
    detect: ["Project.toml", "Manifest.toml"],
    installAll: "julia -e 'using Pkg; Pkg.instantiate()'",
    installProd: "julia -e 'using Pkg; Pkg.instantiate()'",
    hasDev: false,
    priority: PRIORITY.HIGH,
  },
  // Clojure
  {
    name: "lein",
    detect: ["project.clj"],
    installAll: "lein deps",
    installProd: "lein deps",
    hasDev: false,
    priority: PRIORITY.HIGH,
  },
  {
    name: "clojure",
    detect: ["deps.edn"],
    installAll: "clojure -P",
    installProd: "clojure -P",
    hasDev: false,
    priority: PRIORITY.HIGH,
  },
  // Zig
  {
    name: "zig",
    detect: ["build.zig.zon"],
    installAll: "zig fetch",
    installProd: "zig fetch",
    hasDev: false,
    priority: PRIORITY.HIGH,
  },
  // Nim
  {
    name: "nimble",
    detect: ["*.nimble"],
    detectFn: "detectNimble",
    priority: PRIORITY.HIGH,
  },
  // OCaml
  {
    name: "opam",
    detect: ["*.opam", "dune-project"],
    detectFn: "detectOpam",
    priority: PRIORITY.HIGH,
  },
  // Perl
  {
    name: "cpanm",
    detect: ["cpanfile"],
    installAll: "cpanm --installdeps .",
    installProd: "cpanm --installdeps . --without-develop",
    priority: PRIORITY.HIGH,
  },
  // C / C++
  {
    name: "conan",
    detect: ["conanfile.txt", "conanfile.py"],
    installAll: "conan install . --build=missing",
    installProd: "conan install . --build=missing",
    hasDev: false,
    priority: PRIORITY.HIGH,
  },
  {
    name: "vcpkg",
    detect: ["vcpkg.json"],
    installAll: "vcpkg install",
    installProd: "vcpkg install",
    hasDev: false,
    priority: PRIORITY.HIGH,
  },
  // Make-based (generic)
  {
    name: "make",
    detect: ["Makefile"],
    detectFn: "detectMake",
    priority: 1,
  },
];

// Custom detection functions for complex cases

type DetectFn = (path: string, files: string[]) => DepsInfo | null;

function readdirGlob(dir: string, ext: string): string[] {
  try {
    return readdirSync(dir).filter(f => f.endsWith(ext));
  } catch {
    return [];
  }
}

function detectPdmPyproject(path: string, files: string[]): DepsInfo | null {
  const pyprojectPath = join(path, "pyproject.toml");
  if (!existsSync(pyprojectPath)) { return null; }
  if (existsSync(join(path, "pdm.lock"))) { return null; }
  if (existsSync(join(path, "poetry.lock")) || existsSync(join(path, "uv.lock"))) { return null; }

  const content = readFileSync(pyprojectPath, "utf-8");
  if (!content.includes("[tool.pdm]")) { return null; }

  return createDepsInfo("pdm", files, "pdm install", "pdm sync --prod", true, PRIORITY.HIGH);
}

function detectPipPyproject(path: string, files: string[]): DepsInfo | null {
  const pyprojectPath = join(path, "pyproject.toml");
  if (!existsSync(pyprojectPath)) { return null; }
  if (existsSync(join(path, "poetry.lock")) || existsSync(join(path, "uv.lock")) || existsSync(join(path, "pdm.lock"))) { return null; }

  const content = readFileSync(pyprojectPath, "utf-8");
  if (content.includes("[tool.pdm]")) { return null; }

  const hasDev = ["optional-dependencies", "[project.optional-dependencies]", "dev =", "test ="].some(
    (x) => content.includes(x)
  );

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

  return createDepsInfo("pip", files, installScriptAll, installScriptProd, hasDev, PRIORITY.HIGH);
}

function detectPipRequirements(path: string, files: string[]): DepsInfo | null {
  const reqPath = join(path, "requirements.txt");
  if (!existsSync(reqPath)) { return null; }

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
      PRIORITY.HIGH
    );
  }

  return createDepsInfo(
    "pip",
    files,
    `${pipBase} -r requirements.txt`,
    `${pipBase} -r requirements.txt`,
    false,
    PRIORITY.HIGH
  );
}

function detectPipSetup(path: string, files: string[]): DepsInfo | null {
  const setupPy = join(path, "setup.py");
  const setupCfg = join(path, "setup.cfg");

  if (!existsSync(setupPy) && !existsSync(setupCfg)) { return null; }
  if (existsSync(join(path, "pyproject.toml"))) { return null; }

  const installScript =
    'python3 -c "' +
    "import subprocess as S,sys,glob as G;" +
    "S.run([sys.executable,'setup.py','egg_info'],capture_output=1);" +
    "r=G.glob('*.egg-info/requires.txt');" +
    "d=[l.strip()for l in open(r[0])if l.strip()and not l.startswith('[')]if r else[];" +
    "S.run([sys.executable,'-m','pip','install','--break-system-packages']+d,check=1)if d else 0" +
    '"';

  return createDepsInfo("pip", files, installScript, installScript, false, PRIORITY.HIGH);
}

function detectDotnet(path: string, _files: string[]): DepsInfo | null {
  const csproj = readdirGlob(path, ".csproj");
  const fsproj = readdirGlob(path, ".fsproj");
  const sln = readdirGlob(path, ".sln");

  if (csproj.length > 0 || fsproj.length > 0 || sln.length > 0) {
    return createDepsInfo(
      "dotnet",
      [...csproj, ...fsproj, ...sln],
      "dotnet restore",
      "dotnet restore",
      false,
      PRIORITY.HIGH
    );
  }
  return null;
}

function detectCabal(path: string, _files: string[]): DepsInfo | null {
  const cabalFiles = readdirGlob(path, ".cabal");
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
      PRIORITY.HIGH
    );
  }
  return null;
}

function detectLuarocks(path: string, _files: string[]): DepsInfo | null {
  const rockspecs = readdirGlob(path, ".rockspec");
  if (rockspecs.length > 0) {
    return createDepsInfo(
      "luarocks",
      rockspecs,
      "luarocks install --only-deps *.rockspec",
      "luarocks install --only-deps *.rockspec",
      false,
      PRIORITY.HIGH
    );
  }
  return null;
}

function detectNimble(path: string, _files: string[]): DepsInfo | null {
  const nimbleFiles = readdirGlob(path, ".nimble");
  if (nimbleFiles.length > 0) {
    return createDepsInfo("nimble", nimbleFiles, "nimble install -d", "nimble install -d", false, PRIORITY.HIGH);
  }
  return null;
}

function detectOpam(path: string, _files: string[]): DepsInfo | null {
  const opamFiles = readdirGlob(path, ".opam");
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
      PRIORITY.HIGH
    );
  }
  return null;
}

function detectBun(path: string, files: string[]): DepsInfo | null {
  if (existsSync(join(path, "bunfig.toml"))) {
    return createDepsInfo("bun", files, "bun install", "bun install --production", true, PRIORITY.HIGHEST);
  }

  const packageJsonPath = join(path, "package.json");
  if (existsSync(packageJsonPath)) {
    try {
      const content = readFileSync(packageJsonPath, "utf-8");
      const pkg = JSON.parse(content);
      if (pkg.packageManager && typeof pkg.packageManager === "string" &&
          (pkg.packageManager === "bun" || pkg.packageManager.startsWith("bun@"))) {
        return createDepsInfo("bun", files, "bun install", "bun install --production", true, PRIORITY.HIGHEST);
      }
    } catch {
      // JSON parse error - continue
    }
  }

  return null;
}

function detectYarn(path: string, files: string[]): DepsInfo | null {
  const lockPath = join(path, "yarn.lock");
  if (!existsSync(lockPath)) {return null;}

  try {
    const content = readFileSync(lockPath, "utf-8").slice(0, 500);
    const isYarnBerry = content.includes("__metadata:") || content.includes("cacheKey:");

    if (isYarnBerry) {
      return createDepsInfo(
        "yarn",
        files,
        "yarn install",
        "yarn install",
        true,
        PRIORITY.HIGHEST
      );
    }

    return createDepsInfo(
      "yarn",
      files,
      "yarn install",
      "yarn install --production",
      true,
      PRIORITY.HIGHEST
    );
  } catch {
    return createDepsInfo("yarn", files, "yarn install", "yarn install --production", true, PRIORITY.HIGHEST);
  }
}

function detectNodePackageManager(path: string, files: string[]): DepsInfo | null {
  const packageJsonPath = join(path, "package.json");
  if (!existsSync(packageJsonPath)) {return null;}

  const lockFiles = ["bun.lockb", "bun.lock", "pnpm-lock.yaml", "yarn.lock", "package-lock.json"];
  if (lockFiles.some(f => existsSync(join(path, f)))) {return null;}
  if (existsSync(join(path, "bunfig.toml"))) {return null;}

  try {
    const content = readFileSync(packageJsonPath, "utf-8");
    const pkg = JSON.parse(content);

    if (pkg.packageManager && typeof pkg.packageManager === "string") {
      const pm = pkg.packageManager.toLowerCase();

      const managers: Record<string, [string, string, string]> = {
        "bun": ["bun", "bun install", "bun install --production"],
        "pnpm": ["pnpm", "pnpm install", "pnpm install --prod"],
        "yarn": ["yarn", "yarn install", "yarn install --production"],
        "npm": ["npm", "npm install", "npm install --production"],
      };

      for (const [prefix, [name, installAll, installProd]] of Object.entries(managers)) {
        if (pm === prefix || pm.startsWith(`${prefix}@`)) {
          return createDepsInfo(name, files, installAll, installProd, true, PRIORITY.HIGH);
        }
      }
    }

    return createDepsInfo("npm", files, "npm install", "npm install --production", true, PRIORITY.LOW);
  } catch {
    return createDepsInfo("npm", files, "npm install", "npm install --production", true, PRIORITY.LOW);
  }
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
  detectPdmPyproject,
  detectPipPyproject,
  detectPipRequirements,
  detectPipSetup,
  detectDotnet,
  detectCabal,
  detectLuarocks,
  detectNimble,
  detectOpam,
  detectBun,
  detectYarn,
  detectNodePackageManager,
  detectMake,
};

// Main detection logic

function matchesPattern(path: string, pattern: string): string[] {
  if (pattern.includes("*")) {
    const ext = pattern.replace("*", "");
    return readdirGlob(path, ext);
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
    const matchedFiles: string[] = [];
    for (const pattern of pm.detect) {
      matchedFiles.push(...matchesPattern(path, pattern));
    }

    if (matchedFiles.length === 0) {continue;}

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

    if (detectedManagers.has(pm.name)) {continue;}

    results.push(
      createDepsInfo(
        pm.name,
        matchedFiles,
        pm.installAll ?? "",
        pm.installProd ?? "",
        pm.hasDev ?? true,
        pm.priority ?? PRIORITY.HIGH
      )
    );
    detectedManagers.add(pm.name);
  }

  results.sort((a, b) => b.priority - a.priority);
  return results;
}
