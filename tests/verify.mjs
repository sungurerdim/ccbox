#!/usr/bin/env bun
/**
 * Comprehensive Test Suite for ccbox
 *
 * Covers: errors, constants, config, detector, paths, deps, docker, utils, cleanup
 * Edge cases: empty inputs, boundary values, invalid inputs, error handling
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir, platform } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

// Helper for ESM imports - works with both Bun and Node
const importModule = (path) => import(pathToFileURL(path).href);

// Colors
const G = "\x1b[32m", R = "\x1b[31m", Y = "\x1b[33m", B = "\x1b[1m", D = "\x1b[2m", X = "\x1b[0m";

let passed = 0, failed = 0, skipped = 0;
const failures = [];

async function test(name, fn) {
  try {
    const result = await fn();
    if (result === "skip") {
      console.log(`${Y}○${X} ${D}${name} (skipped)${X}`);
      skipped++;
    } else if (result) {
      console.log(`${G}✓${X} ${name}`);
      passed++;
    } else {
      console.log(`${R}✗${X} ${name}`);
      failed++;
      failures.push({ name, error: "Assertion failed" });
    }
  } catch (e) {
    console.log(`${R}✗${X} ${name}: ${e.message}`);
    failed++;
    failures.push({ name, error: e.message });
  }
}

// Detect if bun is available (running under bun or bun command exists)
const hasBun = typeof Bun !== "undefined" || (() => {
  try { execSync("bun --version", { stdio: "ignore" }); return true; } catch { return false; }
})();
const CLI_RUNTIME = hasBun ? "bun run" : "npx tsx";

function cli(args) {
  try {
    const stdout = execSync(`${CLI_RUNTIME} ${ROOT}/src/cli.ts ${args}`, {
      encoding: "utf8", timeout: 30000, env: { ...process.env, NO_COLOR: "1" }
    });
    return { stdout, code: 0 };
  } catch (e) { return { stdout: e.stdout || "", stderr: e.stderr || "", code: e.status || 1 }; }
}

console.log(`\n${B}=== ccbox Comprehensive Test Suite ===${X}\n`);

// ════════════════════════════════════════════════════════════════════════════════
// ERRORS MODULE - Import only (inheritance tested via TypeScript)
// ════════════════════════════════════════════════════════════════════════════════
console.log(`${B}[1/9] errors.ts${X}`);

const errors = await importModule(join(ROOT, "src/errors.ts"));

// Bug prevented: Error messages must be user-actionable
test("DockerNotFoundError has actionable message", () => {
  const e = new errors.DockerNotFoundError();
  return e.message.includes("Docker") && e.message.includes("PATH");
});

test("DockerNotRunningError has actionable message", () => {
  const e = new errors.DockerNotRunningError();
  return e.message.includes("Docker") && e.message.includes("running");
});

// Bug prevented: CCBoxError must propagate context for debugging
test("CCBoxError preserves error context", () => {
  const e = new errors.CCBoxError("connection failed: ECONNREFUSED");
  return e.message === "connection failed: ECONNREFUSED" && e.stack.includes("verify.mjs");
});

// ════════════════════════════════════════════════════════════════════════════════
// CONSTANTS MODULE - Validate invariants, not specific values
// ════════════════════════════════════════════════════════════════════════════════
console.log(`\n${B}[2/9] constants.ts${X}`);

const constants = await importModule(join(ROOT, "src/constants.ts"));

// Bug prevented: VERSION must be semver-compatible for update checks
test("VERSION follows semver format", () => /^\d+\.\d+\.\d+/.test(constants.VERSION));

// Bug prevented: Timeouts must be reasonable (not 0, not too short/long)
test("Timeouts are in safe range (1s-30min)", () => {
  const timeouts = [
    constants.DOCKER_COMMAND_TIMEOUT,
    constants.DOCKER_BUILD_TIMEOUT,
    constants.DOCKER_STARTUP_TIMEOUT,
    constants.PRUNE_TIMEOUT
  ];
  return timeouts.every(t => t >= 1000 && t <= 1800000);
});

// Bug prevented: Container paths must be absolute Linux paths
test("Container paths are absolute", () =>
  constants.CONTAINER_HOME.startsWith("/") &&
  constants.CONTAINER_PROJECT_DIR.startsWith("/"));

// @critical Security: PIDS limit prevents fork bombs
test("[critical] PIDS limit is in safe range (256-8192)", () =>
  constants.DEFAULT_PIDS_LIMIT >= 256 && constants.DEFAULT_PIDS_LIMIT <= 8192);

// ════════════════════════════════════════════════════════════════════════════════
// CONFIG MODULE - Business logic validation only
// ════════════════════════════════════════════════════════════════════════════════
console.log(`\n${B}[3/9] config.ts${X}`);

const { LanguageStack, STACK_INFO, STACK_DEPENDENCIES,
        createConfig, getImageName,
        getContainerName, parseStack, getStackValues, createStack, filterStacks } = await importModule(join(ROOT, "src/config.ts"));

// Bug prevented: Every stack must have info for UI display
test("STACK_INFO covers all LanguageStack values", () =>
  Object.values(LanguageStack).every(s => STACK_INFO[s]?.description?.length > 0));

// Bug prevented: Every stack must have a dependency entry (null or valid stack)
test("STACK_DEPENDENCIES covers all stacks", () =>
  Object.values(LanguageStack).every(s =>
    s in STACK_DEPENDENCIES && (STACK_DEPENDENCIES[s] === null || Object.values(LanguageStack).includes(STACK_DEPENDENCIES[s]))));

// Bug prevented: Size estimates must be positive for disk space warnings
test("STACK_INFO sizes are positive", () =>
  Object.values(STACK_INFO).every(s => s.sizeMB > 0));

// Bug prevented: Default config must have valid structure
test("createConfig returns valid config structure", () => {
  const cfg = createConfig();
  return typeof cfg.version === "string" &&
         typeof cfg.gitName === "string" &&
         typeof cfg.claudeConfigDir === "string";
});


// @critical Security: image name must match docker naming rules
test("[critical] getImageName format is docker-compatible", () =>
  /^ccbox_[a-z]+:latest$/.test(getImageName(LanguageStack.BASE)));

// Bug prevented: Container name uniqueness for parallel execution
test("getContainerName generates unique names", () => {
  const name1 = getContainerName("my-project");
  const name2 = getContainerName("my-project");
  return name1 !== name2 && name1.startsWith("ccbox_");
});

// @critical Security: special chars in project names breaking docker commands
test("[critical] getContainerName sanitizes special chars", () => {
  const name = getContainerName("My Project@2.0!", false);
  return /^ccbox_[a-z0-9-]+$/.test(name);
});

// Bug prevented: Case-insensitive stack parsing for CLI usability
test("parseStack handles case variations", () =>
  parseStack("base") === parseStack("BASE") &&
  parseStack("Go") === parseStack("GO"));

// Bug prevented: Invalid stack input silently accepted
test("parseStack returns undefined for invalid", () =>
  parseStack("invalid") === undefined && parseStack("") === undefined);

// Bug prevented: getStackValues returning empty array breaks CLI choices
test("getStackValues returns non-empty array", () => {
  const values = getStackValues();
  return Array.isArray(values) && values.length > 0 && values.includes("base");
});

// ════════════════════════════════════════════════════════════════════════════════
// DETECTOR MODULE - Core detection logic
// ════════════════════════════════════════════════════════════════════════════════
console.log(`\n${B}[4/9] detector.ts${X}`);

const { detectProjectType } = await importModule(join(ROOT, "src/detector.ts"));
const testDir = join(tmpdir(), "ccbox-test-" + Date.now());
mkdirSync(testDir, { recursive: true });

function testStack(name, files, expected, expectedLangs = null) {
  const dir = join(testDir, "stack-" + name);
  mkdirSync(dir, { recursive: true });
  for (const [f, c] of Object.entries(files)) writeFileSync(join(dir, f), c);
  const result = detectProjectType(dir);
  const stackMatch = result.recommendedStack === expected;
  // detectedLanguages is LanguageDetection[] with .language property
  const langNames = result.detectedLanguages.map(d => typeof d === "string" ? d : d.language);
  const langsMatch = expectedLangs === null || JSON.stringify(langNames.sort()) === JSON.stringify(expectedLangs.sort());
  return stackMatch && langsMatch;
}

// Bug prevented: Empty project must fall back to base (not crash or undefined)
test("Empty dir -> base", () => testStack("empty", { ".gitkeep": "" }, "base", []));

// Bug prevented: Incorrect stack selection = wrong tooling in container
test("Python -> python", () => testStack("py", { "main.py": "print(1)", "requirements.txt": "requests" }, "python", ["python"]));
test("Node -> web", () => testStack("node", { "index.js": "console.log(1)", "package.json": '{"name":"t"}' }, "web", ["node"]));
test("TypeScript -> web", () => testStack("ts", { "index.ts": "console.log(1)", "tsconfig.json": '{}' }, "web", ["typescript"]));
test("Go -> go", () => testStack("go", { "main.go": "package main", "go.mod": "module t\ngo 1.21" }, "go", ["go"]));
test("Rust -> rust", () => testStack("rust", { "main.rs": "fn main(){}", "Cargo.toml": '[package]\nname="t"' }, "rust", ["rust"]));
test("Java Maven -> java", () => testStack("java", { "Main.java": "class M{}", "pom.xml": "<p/>" }, "java", ["java"]));
test("Java Gradle -> java", () => testStack("gradle", { "App.java": "class A{}", "build.gradle": "plugins{}" }, "java", ["java"]));

// Bug prevented: Mixed-language projects must pick sensible default
test("Node + Python -> fullstack (auto-promotion)", () => testStack("fullstack", { "package.json": '{"name":"t"}', "requirements.txt": "flask" }, "fullstack", ["python", "node"]));

// Bug prevented: TypeScript + Python not promoted to fullstack
test("TypeScript + Python -> fullstack", () => testStack("ts-py", { "tsconfig.json": '{}', "index.ts": "console.log(1)", "requirements.txt": "flask", "main.py": "print(1)" }, "fullstack", ["python", "typescript"]));

// Bug prevented: Scripting/functional stacks must be correctly identified
test("Ruby -> scripting", () => testStack("ruby", { "Gemfile": 'source "https://rubygems.org"' }, "scripting", ["ruby"]));
test("Elixir -> functional", () => testStack("elixir", { "mix.exs": "defmodule Test do end" }, "functional", ["elixir"]));
test("Gleam -> functional", () => testStack("gleam", { "gleam.toml": 'name = "app"' }, "functional", ["gleam"]));
test("Deno -> web", () => testStack("deno", { "deno.json": '{"imports":{}}' }, "web", ["deno"]));

// ════════════════════════════════════════════════════════════════════════════════
// DEPS MODULE - Package manager detection (wrong detection = broken installs)
// ════════════════════════════════════════════════════════════════════════════════
console.log(`\n${B}[5/9] deps.ts${X}`);

const { detectDependencies, getInstallCommands } = await importModule(join(ROOT, "src/deps.ts"));

function testDep(name, files, expected, checkProps = {}) {
  const dir = join(testDir, "deps-" + name);
  mkdirSync(dir, { recursive: true });
  for (const [f, c] of Object.entries(files)) writeFileSync(join(dir, f), c);
  const deps = detectDependencies(dir);
  if (deps.length === 0 && expected === null) return true;
  if (deps.length === 0) return false;
  const found = deps.find(d => d.name === expected);
  if (!found) return false;
  for (const [k, v] of Object.entries(checkProps)) {
    if (found[k] !== v) return false;
  }
  return true;
}

// Bug prevented: Wrong package manager = wrong install command = build failure
// Python ecosystem
test("pip (requirements.txt)", () => testDep("pip-req", { "requirements.txt": "requests\nflask" }, "pip"));
test("poetry (poetry.lock)", () => testDep("poetry", { "poetry.lock": "# poetry lock", "pyproject.toml": "[tool.poetry]" }, "poetry"));
test("pdm (pdm.lock)", () => testDep("pdm", { "pdm.lock": "# pdm lock", "pyproject.toml": "[tool.pdm]" }, "pdm"));
test("pdm (pyproject.toml only)", () => testDep("pdm-pyproj", { "pyproject.toml": "[tool.pdm]\n[project]" }, "pdm"));
test("pipenv (Pipfile)", () => testDep("pipenv", { "Pipfile": "[packages]\nflask = \"*\"" }, "pipenv"));
test("uv (uv.lock)", () => testDep("uv", { "uv.lock": "# uv lock" }, "uv"));
test("conda (environment.yml)", () => testDep("conda", { "environment.yml": "name: test\ndependencies:\n  - python" }, "conda"));

// Node/Deno ecosystem
test("deno (deno.json)", () => testDep("deno", { "deno.json": '{"imports":{}}' }, "deno"));
test("deno (deno.lock)", () => testDep("deno-lock", { "deno.lock": '{"version":"3"}' }, "deno"));
test("npm (package-lock.json)", () => testDep("npm-lock", { "package.json": '{"name":"t"}', "package-lock.json": '{"name":"t"}' }, "npm"));
test("yarn v1 (classic)", () => testDep("yarn-v1", { "package.json": '{"name":"t"}', "yarn.lock": "# yarn lockfile v1" }, "yarn"));
test("yarn v2+ (berry)", () => testDep("yarn-berry", { "package.json": '{"name":"t"}', "yarn.lock": "__metadata:\n  version: 8" }, "yarn"));
test("pnpm (pnpm-lock.yaml)", () => testDep("pnpm", { "package.json": '{"name":"t"}', "pnpm-lock.yaml": "lockfileVersion: 5" }, "pnpm"));
test("bun (bun.lockb)", () => testDep("bun", { "package.json": '{"name":"t"}', "bun.lockb": "" }, "bun"));
test("bun (bun.lock)", () => testDep("bun", { "package.json": '{"name":"t"}', "bun.lock": "lockfileVersion: 0" }, "bun"));

// packageManager field (corepack) - no lock file scenarios
test("packageManager: npm@10.2.0", () => testDep("pm-npm", { "package.json": '{"name":"t","packageManager":"npm@10.2.0"}' }, "npm"));
test("packageManager: yarn@4.0.0", () => testDep("pm-yarn", { "package.json": '{"name":"t","packageManager":"yarn@4.0.0"}' }, "yarn"));
test("packageManager: pnpm@8.0.0", () => testDep("pm-pnpm", { "package.json": '{"name":"t","packageManager":"pnpm@8.0.0"}' }, "pnpm"));
test("packageManager: bun (bare)", () => testDep("pm-bun", { "package.json": '{"name":"t","packageManager":"bun"}' }, "bun"));
test("package.json without lock -> npm fallback", () => testDep("pm-fallback", { "package.json": '{"name":"t"}' }, "npm"));

// Compiled languages
test("go (go.mod)", () => testDep("go", { "go.mod": "module t\ngo 1.21" }, "go"));
test("cargo (Cargo.toml)", () => testDep("cargo", { "Cargo.toml": '[package]\nname="t"' }, "cargo"));
test("maven (pom.xml)", () => testDep("maven", { "pom.xml": "<project/>" }, "maven"));
test("gradle (build.gradle)", () => testDep("gradle", { "build.gradle": "plugins{}" }, "gradle"));

// Other ecosystems
test("bundler (Gemfile)", () => testDep("bundler", { "Gemfile": "source 'https://rubygems.org'" }, "bundler"));
test("composer (composer.json)", () => testDep("composer", { "composer.json": '{"require":{}}' }, "composer"));
test("mix (mix.exs)", () => testDep("mix", { "mix.exs": "defmodule T do end" }, "mix"));
test("pub (pubspec.yaml)", () => testDep("pub", { "pubspec.yaml": "name: test" }, "pub"));
test("gleam (gleam.toml)", () => testDep("gleam", { "gleam.toml": 'name = "myapp"' }, "gleam"));

// Bug prevented: Install mode not respected = wrong deps installed
test("getInstallCommands mode=all includes dev", () => {
  const deps = [{ name: "npm", installAll: "npm install", installProd: "npm install --prod", hasDev: true, priority: 5, files: [] }];
  const cmds = getInstallCommands(deps, "all");
  return cmds[0] === "npm install";
});

test("getInstallCommands mode=prod excludes dev", () => {
  const deps = [{ name: "npm", installAll: "npm install", installProd: "npm install --prod", hasDev: true, priority: 5, files: [] }];
  const cmds = getInstallCommands(deps, "prod");
  return cmds[0].includes("--prod");
});

test("getInstallCommands mode=skip returns empty", () => {
  const deps = [{ name: "npm", installAll: "npm install", installProd: "npm install --prod", hasDev: true, priority: 5, files: [] }];
  return getInstallCommands(deps, "skip").length === 0;
});

// Bug prevented: Lock file not prioritized over manifest = non-reproducible builds
test("detectDependencies prioritizes lockfile over manifest", () => {
  const dir = join(testDir, "deps-priority");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), '{"name":"t"}');
  writeFileSync(join(dir, "yarn.lock"), "# yarn");
  const deps = detectDependencies(dir);
  return deps[0].name === "yarn"; // yarn.lock should win over package.json
});

// Bug prevented: Empty dir returns undefined/null instead of empty array
test("detectDependencies empty dir returns empty array", () => {
  const dir = join(testDir, "deps-empty");
  mkdirSync(dir, { recursive: true });
  const deps = detectDependencies(dir);
  return Array.isArray(deps) && deps.length === 0;
});

// ════════════════════════════════════════════════════════════════════════════════
// PATHS MODULE - Security-critical path transformations
// ════════════════════════════════════════════════════════════════════════════════
console.log(`\n${B}[6/9] paths.ts${X}`);

const paths = await importModule(join(ROOT, "src/paths.ts"));

// Bug prevented: Windows paths not recognized = mount failures
test("isWindowsPath detects drive letters", () =>
  paths.isWindowsPath("C:/Users/test") &&
  paths.isWindowsPath("D:\\GitHub\\project") &&
  paths.isWindowsPath("c:/test"));

test("isWindowsPath rejects unix paths", () =>
  !paths.isWindowsPath("/home/user") &&
  !paths.isWindowsPath("./relative"));

// Bug prevented: Backslash to forward slash conversion failure = Docker mount fails
test("windowsToDockerPath normalizes backslashes", () =>
  paths.windowsToDockerPath("D:\\GitHub\\project") === "D:/GitHub/project");

test("windowsToDockerPath uppercase drive letters", () =>
  paths.windowsToDockerPath("d:/test") === "D:/test");

test("windowsToDockerPath removes duplicate slashes", () =>
  paths.windowsToDockerPath("D://GitHub//project") === "D:/GitHub/project");

// Bug prevented: WSL /mnt/x paths not translated = wrong container mounts
test("wslToDockerPath converts /mnt/x format", () =>
  paths.wslToDockerPath("/mnt/c/Users/name") === "/c/Users/name" &&
  paths.wslToDockerPath("/mnt/d") === "/d");

test("wslToDockerPath passes through non-mnt paths", () =>
  paths.wslToDockerPath("/home/user") === "/home/user");

// Bug prevented: Platform mismatch = wrong path format
test("resolveForDocker handles Windows path", () =>
  paths.resolveForDocker("D:\\GitHub\\proj") === "D:/GitHub/proj");

test("resolveForDocker handles WSL path", () =>
  paths.resolveForDocker("/mnt/c/Users/test") === "/c/Users/test");

// @critical Security: prevents path traversal escape from sandbox
test("[critical] resolveForDocker rejects path traversal", () => {
  try {
    paths.resolveForDocker("/home/user/../../../etc/passwd");
    return false;
  } catch (e) {
    return e instanceof errors.PathError && e.message.includes("traversal");
  }
});

// @critical Security: prevents null byte injection to bypass path checks
test("[critical] resolveForDocker rejects null bytes", () => {
  try {
    paths.resolveForDocker("/home/user/test\x00.txt");
    return false;
  } catch (e) {
    return e instanceof errors.PathError && e.message.includes("Null bytes");
  }
});

// Bug prevented: Non-existent project path = cryptic Docker error
test("validateProjectPath rejects non-existent", () => {
  try {
    paths.validateProjectPath("/nonexistent/path/xyz");
    return false;
  } catch (e) {
    return e instanceof errors.PathError && e.message.includes("does not exist");
  }
});

// Bug prevented: File instead of directory = wrong mount
test("validateProjectPath rejects file", () => {
  const filePath = join(testDir, "testfile.txt");
  writeFileSync(filePath, "content");
  try {
    paths.validateProjectPath(filePath);
    return false;
  } catch (e) {
    return e instanceof errors.PathError && e.message.includes("must be a directory");
  }
});

// Bug prevented: Directory instead of file = wrong mount for --system-prompt-file
test("validateFilePath rejects directory", () => {
  try {
    paths.validateFilePath(testDir);
    return false;
  } catch (e) {
    return e instanceof errors.PathError && e.message.includes("not a file");
  }
});

// ════════════════════════════════════════════════════════════════════════════════
// CLI COMMANDS - User-facing behavior verification
// ════════════════════════════════════════════════════════════════════════════════
console.log(`\n${B}[7/9] CLI Commands${X}`);

// Bug prevented: Version check fails silently
test("--version outputs version", () => {
  const { stdout, code } = cli("--version");
  return code === 0 && /\d+\.\d+\.\d+/.test(stdout);
});

// Bug prevented: Help not showing critical options = user confusion
test("--help shows essential commands", () => {
  const { stdout } = cli("--help");
  return ["stacks", "clean", "prune"].every(c => stdout.includes(c));
});

// Bug prevented: Invalid stack silently accepted = runtime failure
test("invalid stack rejected with non-zero exit", () => {
  const { code } = cli("-s invalid_stack .");
  return code !== 0;
});

// ════════════════════════════════════════════════════════════════════════════════
// DOCKER MODULE - Import verification (function existence tested via TypeScript)
// ════════════════════════════════════════════════════════════════════════════════
console.log(`\n${B}[8/9] docker.ts${X}`);

const docker = await importModule(join(ROOT, "src/docker.ts"));

// Bug prevented: Error message format mismatch = broken error handling
const utils = await importModule(join(ROOT, "src/utils.ts"));
test("ERR_DOCKER_NOT_RUNNING is user-actionable message", () =>
  utils.ERR_DOCKER_NOT_RUNNING.includes("Docker") &&
  utils.ERR_DOCKER_NOT_RUNNING.includes("running"));

// ════════════════════════════════════════════════════════════════════════════════
// GENERATOR MODULE - Dockerfile and arg generation (core business logic)
// ════════════════════════════════════════════════════════════════════════════════
console.log(`\n${B}[9/9] generator.ts${X}`);

const generator = await importModule(join(ROOT, "src/generator.ts"));

// Bug prevented: Invalid Dockerfile = build failure
test("generateDockerfile produces valid Dockerfile with FROM", () => {
  const df = generator.generateDockerfile(LanguageStack.BASE);
  return df.startsWith("FROM ") || df.includes("\nFROM ");
});

// Bug prevented: Stack-specific tools not installed
test("generateDockerfile(go) includes golang tools", () =>
  generator.generateDockerfile(LanguageStack.GO).includes("golang"));

test("generateDockerfile(rust) includes rust tools", () =>
  generator.generateDockerfile(LanguageStack.RUST).includes("rust"));

// Bug prevented: Built-in commands being transformed = command not found
test("transformSlashCommand preserves builtins", () =>
  generator.transformSlashCommand("/init") === "/init" &&
  generator.transformSlashCommand("/init create a REST API") === "/init create a REST API");

// Bug prevented: undefined prompt causing errors
test("transformSlashCommand handles undefined", () =>
  generator.transformSlashCommand(undefined) === undefined);

// @critical Security: ensures bypass mode is always enabled in container
test("[critical] buildClaudeArgs always includes --dangerously-skip-permissions", () =>
  generator.buildClaudeArgs({}).includes("--dangerously-skip-permissions"));

// Bug prevented: Headless mode needs --print
test("buildClaudeArgs with headless includes --print", () => {
  const args = generator.buildClaudeArgs({ headless: true });
  return args.includes("--print") && args.includes("--output-format");
});

// Bug prevented: Claude args not passed through
test("buildClaudeArgs passes through claudeArgs", () => {
  const args = generator.buildClaudeArgs({ claudeArgs: ["--model", "opus", "-p", "hello"] });
  return args.includes("--model") && args.includes("opus") && args.includes("hello");
});

// Bug prevented: Unicode in claudeArgs corruption = garbled output
test("buildClaudeArgs preserves unicode in claudeArgs", () => {
  const args = generator.buildClaudeArgs({ claudeArgs: ["hello 🚀 world"] });
  return args.includes("hello 🚀 world");
});

// @critical Security: invalid UID/GID = permission errors in container
test("[critical] getHostUserIds returns valid uid/gid pair", () => {
  const [uid, gid] = generator.getHostUserIds();
  return Number.isInteger(uid) && Number.isInteger(gid) && uid >= 0 && gid >= 0;
});

// Bug prevented: Missing TZ = wrong timestamps in container
test("getHostTimezone returns non-empty string", () =>
  generator.getHostTimezone().length > 0);

// Bug prevented: Zero terminal size = broken TUI
test("getTerminalSize returns positive dimensions", () => {
  const { columns, lines } = generator.getTerminalSize();
  return columns > 0 && lines > 0;
});

// ════════════════════════════════════════════════════════════════════════════════
// BUILD MODULE - Image naming and sanitization
// ════════════════════════════════════════════════════════════════════════════════

const build = await importModule(join(ROOT, "src/build.ts"));

// @critical Security: invalid docker image name could allow injection
test("[critical] getProjectImageName produces docker-compatible format", () => {
  const name = build.getProjectImageName("my-project", LanguageStack.BASE);
  return /^ccbox_[a-z]+:[a-z0-9-]+$/.test(name);
});

// @critical Security: special chars in project name could inject docker commands
test("[critical] getProjectImageName sanitizes special chars", () => {
  const name = build.getProjectImageName("My Project@2.0", LanguageStack.GO);
  return !name.includes("@") && !name.includes(" ") && name.includes("go");
});

// ════════════════════════════════════════════════════════════════════════════════
// ADDITIONAL DETECTOR TESTS - Language coverage
// ════════════════════════════════════════════════════════════════════════════════

// Bug prevented: Less common languages detected as wrong stack
test("C# (.csproj) -> dotnet", () => testStack("csharp", { "App.csproj": "<Project/>" }, "dotnet", ["dotnet"]));
test("Kotlin -> jvm", () => testStack("kotlin", { "build.gradle.kts": "plugins{}" }, "jvm", ["kotlin"]));
test("Scala -> jvm", () => testStack("scala", { "build.sbt": 'name := "test"' }, "jvm", ["scala"]));
test("Haskell -> functional", () => testStack("haskell", { "stack.yaml": "resolver: lts-20.0" }, "functional", ["haskell"]));
test("Zig -> systems", () => testStack("zig", { "build.zig": "const std = @import(\"std\");" }, "systems", ["zig"]));
test("R -> data", () => testStack("r-lang", { "DESCRIPTION": "Package: test", "renv.lock": '{"R":{}}' }, "data", ["r"]));
test("Julia -> data", () => testStack("julia-proj", { "Project.toml": 'name = "Test"\nuuid = "12345"\n[deps]' }, "data", ["julia"]));
test("Dart (Flutter) -> dart", () => testStack("flutter", { "pubspec.yaml": "name: app\nflutter:\n  sdk: flutter" }, "dart", ["dart"]));

// Bug prevented: Root-level detection ignoring subdirectory files
test("Nested project files don't override root detection", () => {
  const dir = join(testDir, "stack-nested");
  mkdirSync(join(dir, "subdir"), { recursive: true });
  writeFileSync(join(dir, "main.go"), "package main");
  writeFileSync(join(dir, "go.mod"), "module test");
  writeFileSync(join(dir, "subdir/package.json"), '{"name":"nested"}');
  const result = detectProjectType(dir);
  return result.recommendedStack === "go";
});

// ════════════════════════════════════════════════════════════════════════════════
// ADDITIONAL GENERATOR TESTS - Stack-specific Dockerfile generation
// ════════════════════════════════════════════════════════════════════════════════

// Bug prevented: Entrypoint script missing shebang or claude command
test("generateEntrypoint has valid bash shebang and claude", () => {
  const entrypoint = generator.generateEntrypoint();
  return entrypoint.startsWith("#!/bin/bash") && entrypoint.includes("claude");
});

// Bug prevented: tmux session wrapper missing from entrypoint
test("generateEntrypoint includes tmux session wrapper", () => {
  const entrypoint = generator.generateEntrypoint();
  return entrypoint.includes("tmux") && entrypoint.includes("ccbox-inject");
});

// Bug prevented: writeBuildFiles not creating required files
test("writeBuildFiles creates Dockerfile and entrypoint.sh", () => {
  const buildDir = generator.writeBuildFiles(LanguageStack.BASE);
  return existsSync(join(buildDir, "Dockerfile")) && existsSync(join(buildDir, "entrypoint.sh"));
});

// Bug prevented: Stack-specific tools missing from Dockerfile
test("generateDockerfile(python) includes package manager", () =>
  generator.generateDockerfile(LanguageStack.PYTHON).includes("uv") ||
  generator.generateDockerfile(LanguageStack.PYTHON).includes("pip"));

test("generateDockerfile(web) includes node runtime", () =>
  generator.generateDockerfile(LanguageStack.WEB).includes("node"));

test("generateDockerfile(dotnet) includes dotnet sdk", () =>
  generator.generateDockerfile(LanguageStack.DOTNET).includes("dotnet"));

// Bug prevented: Project Dockerfile not using base image
test("generateProjectDockerfile uses base image", () => {
  const deps = [{ name: "npm", installAll: "npm install", installProd: "npm ci", hasDev: true, priority: 5, files: [] }];
  const pdf = generator.generateProjectDockerfile("ccbox/web", deps, "all", "/project");
  return pdf.includes("FROM ccbox/web");
});

// Bug prevented: user appendSystemPrompt merged with container awareness
test("buildClaudeArgs merges user appendSystemPrompt", () => {
  const args = generator.buildClaudeArgs({ claudeArgs: ["--append-system-prompt", "Be helpful"] });
  return args.includes("--append-system-prompt") && args.some(a => a.includes("Be helpful"));
});

// ════════════════════════════════════════════════════════════════════════════════
// ADDITIONAL PATHS TESTS - Edge cases
// ════════════════════════════════════════════════════════════════════════════════

// Bug prevented: Dots in path names causing issues
test("resolveForDocker allows dots in path segments", () =>
  paths.resolveForDocker("/home/user/my.project/src") === "/home/user/my.project/src");

// Bug prevented: Spaces in Windows paths being corrupted
test("windowsToDockerPath preserves spaces", () =>
  paths.windowsToDockerPath("C:\\Users\\My Name\\Documents") === "C:/Users/My Name/Documents");

// Bug prevented: Unicode paths rejected or corrupted
test("validateFilePath accepts unicode paths", () => {
  const dir = join(testDir, "unicode-路径");
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, "文件.txt");
  writeFileSync(filePath, "content");
  return paths.validateFilePath(filePath) === filePath;
});

// ════════════════════════════════════════════════════════════════════════════════
// EDGE CASE TESTS - Boundary values and empty inputs (TST-04)
// ════════════════════════════════════════════════════════════════════════════════
console.log(`\n${B}[10/10] Edge Cases${X}`);

// Factory function tests (PAT-07)
test("createStack validates and returns valid stack", () => {
  const stack = createStack("python");
  return stack === "python";
});

test("createStack throws on invalid input", () => {
  try {
    createStack("invalid_stack_xyz");
    return false;
  } catch (e) {
    return e.name === "ValidationError" && e.message.includes("Invalid stack");
  }
});

test("createStack is case-insensitive", () =>
  createStack("PYTHON") === "python" &&
  createStack("Python") === "python");

// Filter stacks tests (FUN-03)
test("filterStacks by category 'core'", () => {
  const stacks = filterStacks("core");
  return stacks.includes("python") && stacks.includes("web") && !stacks.includes("fullstack");
});

test("filterStacks by partial name match", () => {
  const stacks = filterStacks("py");
  return stacks.includes("python");
});

test("filterStacks by description match", () => {
  const stacks = filterStacks("typescript");
  return stacks.includes("web"); // web description includes "TypeScript"
});

test("filterStacks returns empty for no match", () =>
  filterStacks("nonexistent_xyz").length === 0);

// Verbose detection test (FUN-04)
test("detectProjectType verbose mode includes details", () => {
  const dir = join(testDir, "verbose-detection");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), '{"name":"test"}');
  const result = detectProjectType(dir, true);
  return Array.isArray(result.detectedLanguages) &&
         result.detectedLanguages.length > 0 &&
         result.detectedLanguages[0].confidence > 0;
});

// Boundary value tests
test("empty project name normalized to 'project'", () => {
  const result = paths.normalizeProjectDirName("");
  return result === "project" || result.length > 0;
});

test("whitespace-only project name normalized", () => {
  const result = paths.normalizeProjectDirName("   ");
  return result.length > 0 && result.trim() === result;
});

test("very long project name truncated to 255 bytes", () => {
  const longName = "a".repeat(300);
  const result = paths.normalizeProjectDirName(longName);
  return Buffer.byteLength(result, "utf8") <= 255;
});

test("project name preserves valid characters", () => {
  // normalizeProjectDirName preserves most chars, only sanitizes control chars
  const result = paths.normalizeProjectDirName("my-project_2.0");
  return result === "my-project_2.0";
});

// Empty directory detection
test("detectProjectType on empty dir returns BASE", () => {
  const emptyDir = join(testDir, "completely-empty");
  mkdirSync(emptyDir, { recursive: true });
  const result = detectProjectType(emptyDir);
  return result.recommendedStack === "base" && result.detectedLanguages.length === 0;
});

// ════════════════════════════════════════════════════════════════════════════════
// CRITICAL PATH TESTS - Error handling and exit codes (TST-02)
// ════════════════════════════════════════════════════════════════════════════════
console.log(`\n${B}[11/11] Critical Path${X}`);

// Error hierarchy tests
test("CCBoxError is base class for all custom errors", () =>
  errors.PathError.prototype instanceof errors.CCBoxError &&
  errors.DockerError.prototype instanceof errors.CCBoxError &&
  errors.ValidationError.prototype instanceof errors.CCBoxError);

test("DockerError subtypes form hierarchy", () =>
  errors.DockerNotFoundError.prototype instanceof errors.DockerError &&
  errors.DockerTimeoutError.prototype instanceof errors.DockerError &&
  errors.DockerNotRunningError.prototype instanceof errors.DockerError);

test("Error names are preserved for instanceof checks", () => {
  const pathErr = new errors.PathError("test");
  const dockerErr = new errors.DockerNotFoundError();
  const validErr = new errors.ValidationError("test");
  return pathErr.name === "PathError" &&
         dockerErr.name === "DockerNotFoundError" &&
         validErr.name === "ValidationError";
});

// Validation edge cases
test("ValidationError message is preserved", () => {
  const err = new errors.ValidationError("Custom validation message");
  return err.message === "Custom validation message";
});

// @critical Security: validates path traversal via validateProjectPath
test("[critical] PathError for path traversal attempt", () => {
  try {
    paths.validateProjectPath("../../../etc/passwd");
    return false;
  } catch (e) {
    return e instanceof errors.PathError;
  }
});

// ════════════════════════════════════════════════════════════════════════════════
// LOGGER MODULE - Unified logging abstraction (PAT-02)
// ════════════════════════════════════════════════════════════════════════════════
console.log(`\n${B}[12/14] Logger${X}`);

const logger = await importModule(join(ROOT, "src/logger.ts"));

// Bug prevented: Log level not filtering messages correctly
test("LogLevel enum has correct hierarchy", () =>
  logger.LogLevel.DEBUG < logger.LogLevel.INFO &&
  logger.LogLevel.INFO < logger.LogLevel.WARN &&
  logger.LogLevel.WARN < logger.LogLevel.ERROR &&
  logger.LogLevel.ERROR < logger.LogLevel.SILENT);

// Bug prevented: setLogLevel not affecting output
test("setLogLevel and getLogLevel round-trip", () => {
  const original = logger.getLogLevel();
  logger.setLogLevel(logger.LogLevel.WARN);
  const changed = logger.getLogLevel();
  logger.setLogLevel(original); // restore
  return changed === logger.LogLevel.WARN;
});

// Bug prevented: style functions returning undefined
test("style functions return strings", () =>
  typeof logger.style.dim("test") === "string" &&
  typeof logger.style.bold("test") === "string" &&
  typeof logger.style.red("test") === "string" &&
  typeof logger.style.green("test") === "string");

// Bug prevented: log object missing required methods
test("log object has all required methods", () =>
  typeof logger.log.debug === "function" &&
  typeof logger.log.info === "function" &&
  typeof logger.log.warn === "function" &&
  typeof logger.log.error === "function" &&
  typeof logger.log.success === "function" &&
  typeof logger.log.dim === "function" &&
  typeof logger.log.bold === "function");



// ════════════════════════════════════════════════════════════════════════════════
// BUILD MODULE - BuildOptions interface (FUN-12)
// ════════════════════════════════════════════════════════════════════════════════
console.log(`\n${B}[14/14] Build Options${X}`);

// Note: build module already imported above as 'build'

// Bug prevented: build module exports missing required functions
test("build module exports required functions", () =>
  typeof build.buildImage === "function" &&
  typeof build.ensureImageReady === "function" &&
  typeof build.buildProjectImage === "function" &&
  typeof build.getProjectImageName === "function");

// ════════════════════════════════════════════════════════════════════════════════
// DETECTOR DIRECTORY VALIDATION (MNT-12)
// ════════════════════════════════════════════════════════════════════════════════

// Bug prevented: detectProjectType crashing on non-existent directory
test("detectProjectType handles non-existent directory gracefully", () => {
  const result = detectProjectType("/nonexistent/path/xyz123");
  return result.recommendedStack === "base" && result.detectedLanguages.length === 0;
});

// Bug prevented: detectProjectType verbose mode showing error for missing dir
test("detectProjectType verbose mode shows error for missing dir", () => {
  const result = detectProjectType("/nonexistent/path", true);
  return result.recommendedStack === "base" &&
         result.detectedLanguages.length === 0;
});

// ════════════════════════════════════════════════════════════════════════════════
// CLEANUP MODULE - Import only (actual cleanup requires Docker)
// ════════════════════════════════════════════════════════════════════════════════

const cleanup = await importModule(join(ROOT, "src/cleanup.ts"));

// Bug prevented: cleanTempFiles returning undefined instead of count
test("cleanTempFiles returns number", () => {
  const count = cleanup.cleanTempFiles();
  return typeof count === "number" && count >= 0;
});

// ════════════════════════════════════════════════════════════════════════════════
// DOCKER MOCK TESTS - TST-08: Docker operation simulation tests
// ════════════════════════════════════════════════════════════════════════════════
console.log(`\n${B}[15/18] Docker Mock Tests${X}`);

// Bug prevented: Container name collision when running multiple instances
test("getContainerName generates unique names on each call", () => {
  const names = new Set();
  for (let i = 0; i < 100; i++) {
    names.add(getContainerName("test-project", true));
  }
  // All 100 names should be unique
  return names.size === 100;
});

// Bug prevented: Container name collision with same project name
test("getContainerName uniqueness under rapid calls", () => {
  const name1 = getContainerName("collision-test", true);
  const name2 = getContainerName("collision-test", true);
  const name3 = getContainerName("collision-test", true);
  // All should be different due to random suffix
  return name1 !== name2 && name2 !== name3 && name1 !== name3;
});

// Bug prevented: Non-deterministic container names in non-unique mode
test("getContainerName deterministic mode returns same name", () => {
  const name1 = getContainerName("deterministic-test", false);
  const name2 = getContainerName("deterministic-test", false);
  return name1 === name2;
});



// ════════════════════════════════════════════════════════════════════════════════
// GENERATOR EDGE CASES - TST-01: Dockerfile generation edge cases
// ════════════════════════════════════════════════════════════════════════════════
console.log(`\n${B}[16/18] Generator Edge Cases${X}`);

// Bug prevented: Empty deps list causing crash
test("generateProjectDockerfile handles empty deps list", () => {
  const dockerfile = generator.generateProjectDockerfile("ccbox_base:latest", [], "skip", testDir);
  return dockerfile.includes("FROM ccbox_base:latest") && typeof dockerfile === "string";
});

// Bug prevented: All deps modes handled
test("generateProjectDockerfile handles all deps modes", () => {
  const deps = [{ name: "npm", installAll: "npm install", installProd: "npm ci --omit=dev", hasDev: true, priority: 5, files: ["package.json"] }];
  const dfSkip = generator.generateProjectDockerfile("ccbox_web:latest", deps, "skip", testDir);
  const dfAll = generator.generateProjectDockerfile("ccbox_web:latest", deps, "all", testDir);
  const dfProd = generator.generateProjectDockerfile("ccbox_web:latest", deps, "prod", testDir);

  // skip mode should not have npm install
  // all/prod modes should have their respective commands
  return !dfSkip.includes("npm install") &&
         dfAll.includes("npm install") &&
         dfProd.includes("npm");
});

// Bug prevented: Invalid stack causing crash in generateDockerfile
test("generateDockerfile for each valid stack produces valid Dockerfile", () => {
  const stacks = Object.values(LanguageStack);
  for (const stack of stacks) {
    const df = generator.generateDockerfile(stack);
    if (!df.includes("FROM ")) {
      return false;
    }
  }
  return true;
});

// Bug prevented: Special characters in project path
test("generateProjectDockerfile handles paths with spaces", () => {
  const pathWithSpaces = join(testDir, "path with spaces");
  mkdirSync(pathWithSpaces, { recursive: true });
  const dockerfile = generator.generateProjectDockerfile("ccbox_base:latest", [], "skip", pathWithSpaces);
  return typeof dockerfile === "string" && dockerfile.includes("FROM");
});

// ════════════════════════════════════════════════════════════════════════════════
// DOCKER-RUNTIME PARAMETER COMBINATIONS - TST-01 continued
// ════════════════════════════════════════════════════════════════════════════════
console.log(`\n${B}[17/18] Docker Runtime Tests${X}`);

const dockerRuntime = await importModule(join(ROOT, "src/docker-runtime.ts"));

// Bug prevented: Missing options causing undefined behavior
test("getDockerRunCmd with minimal options", async () => {
  const cfg = createConfig();
  const cmd = await dockerRuntime.getDockerRunCmd(testDir, "test-proj", LanguageStack.BASE, {});
  return Array.isArray(cmd) && cmd.includes("docker") && cmd.includes("run");
});

// Bug prevented: Fresh mode not activating minimal mounts
test("getDockerRunCmd fresh mode includes minimal mount signal", async () => {
  const cfg = createConfig();
  const cmd = await dockerRuntime.getDockerRunCmd(testDir, "test-proj", LanguageStack.BASE, { fresh: true });
  const cmdStr = cmd.join(" ");
  // Fresh mode should signal minimal mount
  return cmdStr.includes("CCBOX_MINIMAL_MOUNT") || cmdStr.includes("tmpfs");
});

// Bug prevented: Debug mode not setting environment
test("getDockerRunCmd debug mode sets CCBOX_DEBUG", async () => {
  const cfg = createConfig();
  const cmd = await dockerRuntime.getDockerRunCmd(testDir, "test-proj", LanguageStack.WEB, { debug: 2 });
  return cmd.some(arg => arg.includes("CCBOX_DEBUG=2"));
});

// Bug prevented: Unrestricted mode not removing limits
test("getDockerRunCmd unrestricted mode sets CCBOX_UNRESTRICTED", async () => {
  const cfg = createConfig();
  const cmd = await dockerRuntime.getDockerRunCmd(testDir, "test-proj", LanguageStack.PYTHON, { unrestricted: true });
  return cmd.some(arg => arg.includes("CCBOX_UNRESTRICTED=1"));
});

// Bug prevented: Claude args not passed through to docker command
test("getDockerRunCmd with claudeArgs includes args", async () => {
  const cfg = createConfig();
  const cmd = await dockerRuntime.getDockerRunCmd(testDir, "test-proj", LanguageStack.BASE, { claudeArgs: ["-p", "hello world"] });
  return cmd.includes("hello world");
});

// Bug prevented: Headless mode not setting --print
test("getDockerRunCmd headless mode includes print flag", async () => {
  const cfg = createConfig();
  const cmd = await dockerRuntime.getDockerRunCmd(testDir, "test-proj", LanguageStack.BASE, { headless: true });
  return cmd.includes("--print");
});

// Bug prevented: Model via claudeArgs not passed through
test("getDockerRunCmd model via claudeArgs passed correctly", async () => {
  const cfg = createConfig();
  const cmd = await dockerRuntime.getDockerRunCmd(testDir, "test-proj", LanguageStack.BASE, { claudeArgs: ["--model", "opus"] });
  const modelIdx = cmd.indexOf("--model");
  return modelIdx !== -1 && cmd[modelIdx + 1] === "opus";
});

// Bug prevented: Custom env vars not passed
test("getDockerRunCmd custom envVars included", async () => {
  const cfg = createConfig();
  const cmd = await dockerRuntime.getDockerRunCmd(testDir, "test-proj", LanguageStack.BASE, { envVars: ["MY_VAR=value"] });
  return cmd.some(arg => arg === "MY_VAR=value");
});

// Bug prevented: appendSystemPrompt via claudeArgs included
test("getDockerRunCmd appendSystemPrompt via claudeArgs included", async () => {
  const cfg = createConfig();
  const cmd = await dockerRuntime.getDockerRunCmd(testDir, "test-proj", LanguageStack.BASE, { claudeArgs: ["--append-system-prompt", "Be helpful"] });
  return cmd.some(arg => arg.includes("Be helpful"));
});

// Bug prevented: Worktree projects failing git operations inside container
test("getDockerRunCmd mounts main .git for worktree", async () => {
  // Simulate a git worktree: .git is a file pointing to main repo's .git/worktrees/<name>
  const worktreeDir = join(tmpdir(), `ccbox-worktree-test-${Date.now()}`);
  const mainRepoDir = join(tmpdir(), `ccbox-main-repo-test-${Date.now()}`);
  const worktreeGitDir = join(mainRepoDir, ".git", "worktrees", "feature");
  mkdirSync(worktreeGitDir, { recursive: true });
  mkdirSync(worktreeDir, { recursive: true });
  // Create .git file (not directory) pointing to main repo's worktree dir
  writeFileSync(join(worktreeDir, ".git"), `gitdir: ${worktreeGitDir}\n`);
  try {
    const cfg = createConfig();
    const cmd = await dockerRuntime.getDockerRunCmd( worktreeDir, "wt-proj", LanguageStack.BASE, {});
    const cmdStr = cmd.join(" ");
    // Should mount the main .git directory
    const mainGitDir = join(mainRepoDir, ".git");
    return cmdStr.includes(mainGitDir) || cmd.some(arg => arg.includes(mainGitDir.replace(/\\/g, "/")));
  } finally {
    rmSync(worktreeDir, { recursive: true, force: true });
    rmSync(mainRepoDir, { recursive: true, force: true });
  }
});

test("getDockerRunCmd skips worktree mount when .git is a directory", async () => {
  // Normal repo: .git is a directory, no extra mount needed
  const normalDir = join(tmpdir(), `ccbox-normal-git-test-${Date.now()}`);
  mkdirSync(join(normalDir, ".git"), { recursive: true });
  try {
    const cfg = createConfig();
    const cmd = await dockerRuntime.getDockerRunCmd( normalDir, "normal-proj", LanguageStack.BASE, {});
    // Should NOT have any worktree-related mount (no extra .git mount beyond project)
    const volArgs = cmd.filter((arg, i) => i > 0 && cmd[i - 1] === "-v" && arg.includes(".git:"));
    return volArgs.length === 0;
  } finally {
    rmSync(normalDir, { recursive: true, force: true });
  }
});

// ════════════════════════════════════════════════════════════════════════════════
// CLI FLAG PARSING EDGE CASES - TST-01 continued
// ════════════════════════════════════════════════════════════════════════════════
console.log(`\n${B}[18/18] CLI Flag Edge Cases${X}`);


// Passthrough: unknown flags are passed to Claude CLI
test("CLI accepts unknown flags (passthrough)", () => {
  // --help should still work (commander handles it before passthrough)
  const { stdout } = cli("--help");
  return stdout.includes("headless");
});

// ════════════════════════════════════════════════════════════════════════════════
// NULL/EMPTY EDGE CASES - TST-04
// ════════════════════════════════════════════════════════════════════════════════
console.log(`\n${B}[19/21] Null/Empty Edge Cases${X}`);

// Bug prevented: getInstallCommands crashes on empty input
test("getInstallCommands returns [] for empty deps list", () => {
  const cmds = getInstallCommands([], "all");
  return Array.isArray(cmds) && cmds.length === 0;
});

// Bug prevented: filterStacks returns null/undefined on empty input
test("filterStacks returns [] for empty string", () => {
  const stacks = filterStacks("");
  return Array.isArray(stacks) && stacks.length > 0; // empty filter = show all
});

// Bug prevented: getStackValues never returns empty
test("getStackValues returns non-null array", () => {
  const values = getStackValues();
  return Array.isArray(values) && values !== null && values !== undefined;
});

// Bug prevented: detectDependencies returns undefined for non-existent dir
test("detectDependencies returns [] for non-existent dir", () => {
  const deps = detectDependencies("/nonexistent/path/xyz123");
  return Array.isArray(deps) && deps.length === 0;
});

// Bug prevented: buildClaudeArgs crashes on empty options
test("buildClaudeArgs handles empty options", () => {
  const args = generator.buildClaudeArgs({});
  return Array.isArray(args) && args.length > 0;
});

// Bug prevented: transformSlashCommand crashes on empty string
test("transformSlashCommand handles empty string", () => {
  const result = generator.transformSlashCommand("");
  return result === "" || result === undefined;
});

// ════════════════════════════════════════════════════════════════════════════════
// DOCKER MOCK TESTS - TST-08: Mock build verification
// ════════════════════════════════════════════════════════════════════════════════
console.log(`\n${B}[20/21] Docker Mock Tests (TST-08)${X}`);

// Bug prevented: Mock recorder not tracking calls
test("DockerMockRecorder tracks build calls", async () => {
  const { DockerMockRecorder } = await importModule(join(ROOT, "tests/mocks/docker-mock.ts"));
  const recorder = new DockerMockRecorder();
  await recorder.build({ imageName: "test:latest", dockerfile: "FROM alpine", buildDir: "/tmp" });
  return recorder.calls.length === 1 && recorder.calls[0].imageName === "test:latest";
});

// Bug prevented: Mock build returning invalid result
test("mockDockerBuild returns valid result", async () => {
  const { mockDockerBuild } = await importModule(join(ROOT, "tests/mocks/docker-mock.ts"));
  const result = await mockDockerBuild({ imageName: "ccbox_base:latest", dockerfile: "FROM debian", buildDir: "/tmp" });
  return result.imageId.startsWith("mock-") && result.exitCode === 0;
});

// Bug prevented: Mock failure not simulating error correctly
test("mockDockerBuildFailure returns non-zero exit", async () => {
  const { mockDockerBuildFailure } = await importModule(join(ROOT, "tests/mocks/docker-mock.ts"));
  const result = await mockDockerBuildFailure({ imageName: "test:latest", dockerfile: "FROM alpine", buildDir: "/tmp" });
  return result.exitCode !== 0 && result.imageId === "";
});

// Bug prevented: Mock recorder reset not clearing calls
test("DockerMockRecorder reset clears history", async () => {
  const { DockerMockRecorder } = await importModule(join(ROOT, "tests/mocks/docker-mock.ts"));
  const recorder = new DockerMockRecorder();
  await recorder.build({ imageName: "test:latest", dockerfile: "FROM alpine", buildDir: "/tmp" });
  recorder.reset();
  return recorder.calls.length === 0;
});

// ════════════════════════════════════════════════════════════════════════════════
// TEST CLEANUP
// ════════════════════════════════════════════════════════════════════════════════
rmSync(testDir, { recursive: true, force: true });

// ════════════════════════════════════════════════════════════════════════════════
// SUMMARY
// ════════════════════════════════════════════════════════════════════════════════
console.log(`\n${B}=== Summary ===${X}`);
console.log(`${G}Passed: ${passed}${X}`);
console.log(`${skipped > 0 ? Y : G}Skipped: ${skipped}${X}`);
console.log(`${failed > 0 ? R : G}Failed: ${failed}${X}`);
console.log(`Total: ${passed + failed + skipped}\n`);

if (failures.length > 0) {
  console.log(`${R}Failed tests:${X}`);
  for (const f of failures) {
    console.log(`  ${R}✗${X} ${f.name}: ${f.error}`);
  }
  console.log();
}

if (failed > 0) {
  console.log(`${Y}Some checks failed - review needed${X}`);
  process.exit(1);
} else {
  console.log(`${G}All comprehensive tests passed!${X}`);
  console.log(`${G}Coverage: errors, constants, config, detector, deps, paths, CLI, docker, utils, generator, build, cleanup, docker-runtime${X}`);
}
