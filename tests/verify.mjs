#!/usr/bin/env node
/**
 * Comprehensive Test Suite for ccbox npm
 *
 * Covers: errors, constants, config, detector, paths, deps, docker, utils, cleanup
 * Edge cases: empty inputs, boundary values, invalid inputs, error handling
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir, platform } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

// Colors
const G = "\x1b[32m", R = "\x1b[31m", Y = "\x1b[33m", B = "\x1b[1m", D = "\x1b[2m", X = "\x1b[0m";

let passed = 0, failed = 0, skipped = 0;
const failures = [];

function test(name, fn) {
  try {
    const result = fn();
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

function cli(args) {
  try {
    const stdout = execSync(`node ${ROOT}/dist/cli.js ${args}`, {
      encoding: "utf8", timeout: 30000, env: { ...process.env, NO_COLOR: "1" }
    });
    return { stdout, code: 0 };
  } catch (e) { return { stdout: e.stdout || "", stderr: e.stderr || "", code: e.status || 1 }; }
}

console.log(`\n${B}=== ccbox npm Comprehensive Test Suite ===${X}\n`);

// ════════════════════════════════════════════════════════════════════════════════
// ERRORS MODULE
// ════════════════════════════════════════════════════════════════════════════════
console.log(`${B}[1/9] errors.ts${X}`);

const errors = await import(join(ROOT, "dist/errors.js"));

test("CCBoxError extends Error", () => {
  const e = new errors.CCBoxError("test");
  return e instanceof Error && e.name === "CCBoxError" && e.message === "test";
});

test("ConfigError extends CCBoxError", () => {
  const e = new errors.ConfigError("cfg error");
  return e instanceof errors.CCBoxError && e.name === "ConfigError";
});

test("PathError extends CCBoxError", () => {
  const e = new errors.PathError("path error");
  return e instanceof errors.CCBoxError && e.name === "PathError";
});

test("DockerError extends CCBoxError", () => {
  const e = new errors.DockerError("docker error");
  return e instanceof errors.CCBoxError && e.name === "DockerError";
});

test("DockerNotFoundError extends DockerError", () => {
  const e = new errors.DockerNotFoundError();
  return e instanceof errors.DockerError && e.message === "Docker not found in PATH";
});

test("DockerTimeoutError extends DockerError", () => {
  const e = new errors.DockerTimeoutError();
  return e instanceof errors.DockerError && e.message === "Docker operation timed out";
});

test("DockerNotRunningError extends DockerError", () => {
  const e = new errors.DockerNotRunningError();
  return e instanceof errors.DockerError && e.message === "Docker daemon is not running";
});

test("ImageBuildError extends DockerError", () => {
  const e = new errors.ImageBuildError("build failed");
  return e instanceof errors.DockerError && e.name === "ImageBuildError";
});

test("ContainerError extends DockerError", () => {
  const e = new errors.ContainerError("container failed");
  return e instanceof errors.DockerError && e.name === "ContainerError";
});

test("DependencyError extends CCBoxError", () => {
  const e = new errors.DependencyError("dep error");
  return e instanceof errors.CCBoxError && e.name === "DependencyError";
});

test("ValidationError extends CCBoxError", () => {
  const e = new errors.ValidationError("validation error");
  return e instanceof errors.CCBoxError && e.name === "ValidationError";
});

test("Error stack trace captured", () => {
  const e = new errors.CCBoxError("stack test");
  return e.stack && e.stack.includes("CCBoxError");
});

// ════════════════════════════════════════════════════════════════════════════════
// CONSTANTS MODULE
// ════════════════════════════════════════════════════════════════════════════════
console.log(`\n${B}[2/9] constants.ts${X}`);

const constants = await import(join(ROOT, "dist/constants.js"));

test("VERSION is string", () => typeof constants.VERSION === "string" && constants.VERSION.length > 0);
test("DOCKER_COMMAND_TIMEOUT = 30000", () => constants.DOCKER_COMMAND_TIMEOUT === 30000);
test("DOCKER_BUILD_TIMEOUT = 600000", () => constants.DOCKER_BUILD_TIMEOUT === 600000);
test("DOCKER_STARTUP_TIMEOUT = 30000", () => constants.DOCKER_STARTUP_TIMEOUT === 30000);
test("DOCKER_CHECK_INTERVAL = 5000", () => constants.DOCKER_CHECK_INTERVAL === 5000);
test("PRUNE_TIMEOUT = 60000", () => constants.PRUNE_TIMEOUT === 60000);
test("MAX_PROMPT_LENGTH = 5000", () => constants.MAX_PROMPT_LENGTH === 5000);
test("MAX_SYSTEM_PROMPT_LENGTH = 10000", () => constants.MAX_SYSTEM_PROMPT_LENGTH === 10000);
test("VALID_MODELS contains opus", () => constants.VALID_MODELS.has("opus"));
test("VALID_MODELS contains sonnet", () => constants.VALID_MODELS.has("sonnet"));
test("VALID_MODELS contains haiku", () => constants.VALID_MODELS.has("haiku"));
test("VALID_MODELS has exactly 3 models", () => constants.VALID_MODELS.size === 3);
test("PRUNE_CACHE_AGE = 168h", () => constants.PRUNE_CACHE_AGE === "168h");
test("CONTAINER_USER = node", () => constants.CONTAINER_USER === "node");
test("CONTAINER_HOME = /home/node", () => constants.CONTAINER_HOME === "/home/node");
test("CONTAINER_PROJECT_DIR = /home/node/project", () => constants.CONTAINER_PROJECT_DIR === "/home/node/project");
test("TMPFS_SIZE = 64m", () => constants.TMPFS_SIZE === "64m");
test("TMPFS_MODE = 1777", () => constants.TMPFS_MODE === "1777");
test("DEFAULT_PIDS_LIMIT = 2048", () => constants.DEFAULT_PIDS_LIMIT === 2048);

// ════════════════════════════════════════════════════════════════════════════════
// CONFIG MODULE
// ════════════════════════════════════════════════════════════════════════════════
console.log(`\n${B}[3/9] config.ts${X}`);

const { LanguageStack, STACK_INFO, STACK_DEPENDENCIES, CCO_ENABLED_STACKS,
        createConfig, validateSafePath, getClaudeConfigDir, getImageName,
        getContainerName, parseStack, getStackValues } = await import(join(ROOT, "dist/config.js"));

// LanguageStack enum
test("LanguageStack has 7 values", () => Object.values(LanguageStack).length === 7);
test("LanguageStack.MINIMAL = minimal", () => LanguageStack.MINIMAL === "minimal");
test("LanguageStack.BASE = base", () => LanguageStack.BASE === "base");
test("LanguageStack.GO = go", () => LanguageStack.GO === "go");
test("LanguageStack.RUST = rust", () => LanguageStack.RUST === "rust");
test("LanguageStack.JAVA = java", () => LanguageStack.JAVA === "java");
test("LanguageStack.WEB = web", () => LanguageStack.WEB === "web");
test("LanguageStack.FULL = full", () => LanguageStack.FULL === "full");

// STACK_INFO
test("STACK_INFO has all stacks", () =>
  Object.values(LanguageStack).every(s => STACK_INFO[s]));
test("STACK_INFO has descriptions", () =>
  Object.values(STACK_INFO).every(s => s.description && s.description.length > 0));
test("STACK_INFO has valid sizes", () =>
  Object.values(STACK_INFO).every(s => s.sizeMB > 0));
test("STACK_INFO.minimal.sizeMB = 400", () => STACK_INFO.minimal.sizeMB === 400);
test("STACK_INFO.full.sizeMB = 1350", () => STACK_INFO.full.sizeMB === 1350);

// STACK_DEPENDENCIES
test("STACK_DEPENDENCIES has all stacks", () =>
  Object.values(LanguageStack).every(s => s in STACK_DEPENDENCIES));
test("STACK_DEPENDENCIES.minimal = null", () => STACK_DEPENDENCIES.minimal === null);
test("STACK_DEPENDENCIES.base = minimal", () => STACK_DEPENDENCIES.base === LanguageStack.MINIMAL);
test("STACK_DEPENDENCIES.web = base", () => STACK_DEPENDENCIES.web === LanguageStack.BASE);
test("STACK_DEPENDENCIES.go = null", () => STACK_DEPENDENCIES.go === null);

// CCO_ENABLED_STACKS
test("CCO_ENABLED_STACKS is Set", () => CCO_ENABLED_STACKS instanceof Set);
test("CCO_ENABLED_STACKS excludes minimal", () => !CCO_ENABLED_STACKS.has(LanguageStack.MINIMAL));
test("CCO_ENABLED_STACKS includes base", () => CCO_ENABLED_STACKS.has(LanguageStack.BASE));
test("CCO_ENABLED_STACKS includes all except minimal", () =>
  CCO_ENABLED_STACKS.size === 6);

// createConfig
test("createConfig returns valid config", () => {
  const cfg = createConfig();
  return cfg.version === "1.0.0" && cfg.gitName === "" && cfg.gitEmail === "" && cfg.claudeConfigDir === "~/.claude";
});

// validateSafePath
test("validateSafePath accepts home path", () => {
  const testPath = join(homedir(), "test-project");
  return validateSafePath(testPath).startsWith(homedir());
});

test("validateSafePath rejects outside home", () => {
  try {
    validateSafePath("/tmp/outside");
    return false;
  } catch (e) {
    return e instanceof errors.PathError && e.message.includes("must be within home");
  }
});

test("validateSafePath rejects symlink", () => {
  const testDir = join(tmpdir(), `ccbox-symlink-test-${Date.now()}`);
  const linkPath = join(testDir, "link");
  const targetPath = join(testDir, "target");
  mkdirSync(testDir, { recursive: true });
  mkdirSync(targetPath);
  symlinkSync(targetPath, linkPath);
  try {
    validateSafePath(linkPath);
    rmSync(testDir, { recursive: true, force: true });
    return false;
  } catch (e) {
    rmSync(testDir, { recursive: true, force: true });
    return e instanceof errors.PathError && e.message.includes("symlink");
  }
});

// getClaudeConfigDir
test("getClaudeConfigDir expands ~", () => {
  const cfg = createConfig();
  const dir = getClaudeConfigDir(cfg);
  return dir.startsWith(homedir()) && dir.includes(".claude");
});

// getImageName
test("getImageName returns ccbox/{stack}", () => {
  return getImageName(LanguageStack.BASE) === "ccbox/base" &&
         getImageName(LanguageStack.GO) === "ccbox/go";
});

// getContainerName
test("getContainerName generates unique names", () => {
  const name1 = getContainerName("my-project");
  const name2 = getContainerName("my-project");
  return name1.startsWith("ccbox.my-project-") && name1 !== name2;
});

test("getContainerName without unique suffix", () => {
  const name = getContainerName("my-project", false);
  return name === "ccbox.my-project";
});

test("getContainerName sanitizes special chars", () => {
  const name = getContainerName("My Project@2.0", false);
  return name === "ccbox.my-project-2-0";
});

// parseStack
test("parseStack parses valid stacks", () =>
  parseStack("base") === LanguageStack.BASE &&
  parseStack("GO") === LanguageStack.GO &&
  parseStack("RUST") === LanguageStack.RUST);

test("parseStack returns undefined for invalid", () =>
  parseStack("invalid") === undefined && parseStack("") === undefined);

// getStackValues
test("getStackValues returns all stacks", () => {
  const values = getStackValues();
  return values.length === 7 && values.includes("base") && values.includes("full");
});

// ════════════════════════════════════════════════════════════════════════════════
// DETECTOR MODULE
// ════════════════════════════════════════════════════════════════════════════════
console.log(`\n${B}[4/9] detector.ts${X}`);

const { detectProjectType } = await import(join(ROOT, "dist/detector.js"));
const testDir = join(tmpdir(), "ccbox-test-" + Date.now());
mkdirSync(testDir, { recursive: true });

function testStack(name, files, expected, expectedLangs = null) {
  const dir = join(testDir, "stack-" + name);
  mkdirSync(dir, { recursive: true });
  for (const [f, c] of Object.entries(files)) writeFileSync(join(dir, f), c);
  const result = detectProjectType(dir);
  const stackMatch = result.recommendedStack === expected;
  const langsMatch = expectedLangs === null || JSON.stringify(result.detectedLanguages.sort()) === JSON.stringify(expectedLangs.sort());
  return stackMatch && langsMatch;
}

test("Empty dir -> base", () => testStack("empty", { ".gitkeep": "" }, "base", []));
test("Python -> base", () => testStack("py", { "main.py": "print(1)", "requirements.txt": "requests" }, "base", ["python", "node"].filter(x => x === "python")));
test("Node -> base", () => testStack("node", { "index.js": "console.log(1)", "package.json": '{"name":"t"}' }, "base"));
test("Go -> go", () => testStack("go", { "main.go": "package main", "go.mod": "module t\ngo 1.21" }, "go", ["go"]));
test("Rust -> rust", () => testStack("rust", { "main.rs": "fn main(){}", "Cargo.toml": '[package]\nname="t"' }, "rust", ["rust"]));
test("Java Maven -> java", () => testStack("java", { "Main.java": "class M{}", "pom.xml": "<p/>" }, "java", ["java"]));
test("Java Gradle -> java", () => testStack("gradle", { "App.java": "class A{}", "build.gradle": "plugins{}" }, "java", ["java"]));
test("Node + Python -> web", () => testStack("fullstack", { "package.json": '{"name":"t"}', "requirements.txt": "flask" }, "web", ["python", "node"]));
test("Go + Rust -> full", () => testStack("multi", { "go.mod": "module t\ngo 1.21", "Cargo.toml": '[package]\nname="t"' }, "full", ["go", "rust"]));
test("Go + Java -> full", () => testStack("gojava", { "go.mod": "module t", "pom.xml": "<p/>" }, "full", ["go", "java"]));

// ════════════════════════════════════════════════════════════════════════════════
// DEPS MODULE
// ════════════════════════════════════════════════════════════════════════════════
console.log(`\n${B}[5/9] deps.ts${X}`);

const { detectDependencies, getInstallCommands } = await import(join(ROOT, "dist/deps.js"));

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

// Python package managers
test("pip (requirements.txt)", () => testDep("pip-req", { "requirements.txt": "requests\nflask" }, "pip"));
test("pip (pyproject.toml)", () => testDep("pip-pyproj", { "pyproject.toml": '[project]\ndependencies=["requests"]' }, "pip"));
test("poetry (poetry.lock)", () => testDep("poetry", { "poetry.lock": "# poetry lock", "pyproject.toml": "[tool.poetry]" }, "poetry"));
test("pipenv (Pipfile)", () => testDep("pipenv", { "Pipfile": "[packages]\nflask = \"*\"" }, "pipenv"));
test("uv (uv.lock)", () => testDep("uv", { "uv.lock": "# uv lock" }, "uv"));
test("conda (environment.yml)", () => testDep("conda", { "environment.yml": "name: test\ndependencies:\n  - python" }, "conda"));

// Node package managers
test("npm (package.json)", () => testDep("npm", { "package.json": '{"name":"t"}' }, "npm"));
test("npm (package-lock.json)", () => testDep("npm-lock", { "package.json": '{"name":"t"}', "package-lock.json": '{"name":"t"}' }, "npm"));
test("yarn (yarn.lock)", () => testDep("yarn", { "package.json": '{"name":"t"}', "yarn.lock": "# yarn" }, "yarn"));
test("pnpm (pnpm-lock.yaml)", () => testDep("pnpm", { "package.json": '{"name":"t"}', "pnpm-lock.yaml": "lockfileVersion: 5" }, "pnpm"));
test("bun (bun.lockb)", () => testDep("bun", { "package.json": '{"name":"t"}', "bun.lockb": "" }, "bun"));

// Compiled languages
test("go (go.mod)", () => testDep("go", { "go.mod": "module t\ngo 1.21" }, "go"));
test("cargo (Cargo.toml)", () => testDep("cargo", { "Cargo.toml": '[package]\nname="t"' }, "cargo"));
test("maven (pom.xml)", () => testDep("maven", { "pom.xml": "<project/>" }, "maven"));
test("gradle (build.gradle)", () => testDep("gradle", { "build.gradle": "plugins{}" }, "gradle"));
test("sbt (build.sbt)", () => testDep("sbt", { "build.sbt": "name := \"test\"" }, "sbt"));

// Other languages
test("bundler (Gemfile)", () => testDep("bundler", { "Gemfile": "source 'https://rubygems.org'" }, "bundler"));
test("composer (composer.json)", () => testDep("composer", { "composer.json": '{"require":{}}' }, "composer"));
test("mix (mix.exs)", () => testDep("mix", { "mix.exs": "defmodule T do end" }, "mix"));
test("pub (pubspec.yaml)", () => testDep("pub", { "pubspec.yaml": "name: test" }, "pub"));
test("swift (Package.swift)", () => testDep("swift", { "Package.swift": "import PackageDescription" }, "swift"));
test("julia (Project.toml)", () => testDep("julia", { "Project.toml": 'name = "Test"' }, "julia"));
test("renv (renv.lock)", () => testDep("renv", { "renv.lock": '{"R":{}}' }, "renv"));
test("lein (project.clj)", () => testDep("lein", { "project.clj": "(defproject test)" }, "lein"));
test("zig (build.zig.zon)", () => testDep("zig", { "build.zig.zon": ".{}" }, "zig"));
test("conan (conanfile.txt)", () => testDep("conan", { "conanfile.txt": "[requires]" }, "conan"));
test("vcpkg (vcpkg.json)", () => testDep("vcpkg", { "vcpkg.json": '{"name":"t"}' }, "vcpkg"));
test("cpanm (cpanfile)", () => testDep("cpanm", { "cpanfile": "requires 'Mojolicious'" }, "cpanm"));

// getInstallCommands
test("getInstallCommands mode=all", () => {
  const deps = [{ name: "npm", installAll: "npm install", installProd: "npm install --prod", hasDev: true, priority: 5, files: [] }];
  const cmds = getInstallCommands(deps, "all");
  return cmds.length === 1 && cmds[0] === "npm install";
});

test("getInstallCommands mode=prod", () => {
  const deps = [{ name: "npm", installAll: "npm install", installProd: "npm install --prod", hasDev: true, priority: 5, files: [] }];
  const cmds = getInstallCommands(deps, "prod");
  return cmds.length === 1 && cmds[0] === "npm install --prod";
});

test("getInstallCommands mode=skip", () => {
  const deps = [{ name: "npm", installAll: "npm install", installProd: "npm install --prod", hasDev: true, priority: 5, files: [] }];
  const cmds = getInstallCommands(deps, "skip");
  return cmds.length === 0;
});

test("detectDependencies sorts by priority", () => {
  const dir = join(testDir, "deps-priority");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), '{"name":"t"}');
  writeFileSync(join(dir, "yarn.lock"), "# yarn");
  const deps = detectDependencies(dir);
  // yarn.lock has higher priority than package.json
  return deps.length >= 1 && deps[0].name === "yarn";
});

// Empty directory
test("detectDependencies empty dir", () => {
  const dir = join(testDir, "deps-empty");
  mkdirSync(dir, { recursive: true });
  const deps = detectDependencies(dir);
  return deps.length === 0;
});

// ════════════════════════════════════════════════════════════════════════════════
// PATHS MODULE
// ════════════════════════════════════════════════════════════════════════════════
console.log(`\n${B}[6/9] paths.ts${X}`);

const paths = await import(join(ROOT, "dist/paths.js"));

// isWindowsPath
test("isWindowsPath C:/", () => paths.isWindowsPath("C:/Users/test"));
test("isWindowsPath D:\\", () => paths.isWindowsPath("D:\\GitHub\\project"));
test("isWindowsPath lowercase", () => paths.isWindowsPath("c:/test"));
test("isWindowsPath false for Unix", () => !paths.isWindowsPath("/home/user"));
test("isWindowsPath false for relative", () => !paths.isWindowsPath("./relative"));

// isWsl (depends on environment)
test("isWsl returns boolean", () => typeof paths.isWsl() === "boolean");

// windowsToDockerPath
test("windowsToDockerPath D:\\ backslash", () =>
  paths.windowsToDockerPath("D:\\GitHub\\project") === "D:/GitHub/project");
test("windowsToDockerPath C:/ forward", () =>
  paths.windowsToDockerPath("C:/Users/test") === "C:/Users/test");
test("windowsToDockerPath uppercase drive", () =>
  paths.windowsToDockerPath("d:/test") === "D:/test");
test("windowsToDockerPath root only", () =>
  paths.windowsToDockerPath("C:\\") === "C:/");
test("windowsToDockerPath removes duplicate slashes", () =>
  paths.windowsToDockerPath("D://GitHub//project") === "D:/GitHub/project");
test("windowsToDockerPath removes trailing slash", () =>
  paths.windowsToDockerPath("D:/GitHub/project/") === "D:/GitHub/project");
test("windowsToDockerPath non-windows passthrough", () =>
  paths.windowsToDockerPath("/home/user") === "/home/user");

// wslToDockerPath
test("wslToDockerPath /mnt/c", () =>
  paths.wslToDockerPath("/mnt/c/Users/name") === "/c/Users/name");
test("wslToDockerPath /mnt/d root", () =>
  paths.wslToDockerPath("/mnt/d/") === "/d");
test("wslToDockerPath /mnt/d only", () =>
  paths.wslToDockerPath("/mnt/d") === "/d");
test("wslToDockerPath passthrough non-mnt", () =>
  paths.wslToDockerPath("/home/user") === "/home/user");

// resolveForDocker
test("resolveForDocker Windows path", () =>
  paths.resolveForDocker("D:\\GitHub\\proj") === "D:/GitHub/proj");
test("resolveForDocker WSL path", () =>
  paths.resolveForDocker("/mnt/c/Users/test") === "/c/Users/test");
test("resolveForDocker Linux path", () =>
  paths.resolveForDocker("/home/user/proj") === "/home/user/proj");
test("resolveForDocker rejects path traversal", () => {
  try {
    paths.resolveForDocker("/home/user/../../../etc/passwd");
    return false;
  } catch (e) {
    return e instanceof errors.PathError && e.message.includes("traversal");
  }
});
test("resolveForDocker rejects null bytes", () => {
  try {
    paths.resolveForDocker("/home/user/test\x00.txt");
    return false;
  } catch (e) {
    return e instanceof errors.PathError && e.message.includes("Null bytes");
  }
});

// containerPath
test("containerPath adds // on Windows", () => {
  if (platform() === "win32") {
    return paths.containerPath("/home/node/.claude").startsWith("//");
  }
  return "skip"; // Skip on non-Windows
});
test("containerPath unchanged on Linux/Mac", () => {
  if (platform() !== "win32") {
    return paths.containerPath("/home/node/.claude") === "/home/node/.claude";
  }
  return "skip";
});

// getDockerEnv
test("getDockerEnv returns env object", () => {
  const env = paths.getDockerEnv();
  return typeof env === "object" && env !== null;
});
test("getDockerEnv sets MSYS vars on Windows", () => {
  if (platform() === "win32") {
    const env = paths.getDockerEnv();
    return env.MSYS_NO_PATHCONV === "1";
  }
  return "skip";
});

// validateProjectPath
test("validateProjectPath accepts valid dir", () => {
  const validDir = join(testDir, "valid-proj");
  mkdirSync(validDir, { recursive: true });
  return paths.validateProjectPath(validDir) === validDir;
});
test("validateProjectPath rejects non-existent", () => {
  try {
    paths.validateProjectPath("/nonexistent/path/xyz");
    return false;
  } catch (e) {
    return e instanceof errors.PathError && e.message.includes("does not exist");
  }
});
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

// validateFilePath
test("validateFilePath accepts valid file", () => {
  const filePath = join(testDir, "validfile.txt");
  writeFileSync(filePath, "content");
  return paths.validateFilePath(filePath) === filePath;
});
test("validateFilePath rejects non-existent when mustExist", () => {
  try {
    paths.validateFilePath("/nonexistent/file.txt", true);
    return false;
  } catch (e) {
    return e instanceof errors.PathError && e.message.includes("does not exist");
  }
});
test("validateFilePath accepts non-existent when !mustExist", () => {
  return paths.validateFilePath("/nonexistent/file.txt", false).includes("nonexistent");
});
test("validateFilePath rejects directory", () => {
  try {
    paths.validateFilePath(testDir);
    return false;
  } catch (e) {
    return e instanceof errors.PathError && e.message.includes("not a file");
  }
});

// ════════════════════════════════════════════════════════════════════════════════
// CLI COMMANDS
// ════════════════════════════════════════════════════════════════════════════════
console.log(`\n${B}[7/9] CLI Commands${X}`);

test("--version outputs version", () => {
  const { stdout, code } = cli("--version");
  return code === 0 && stdout.trim().length > 0;
});

test("--help shows usage", () => {
  const { stdout } = cli("--help");
  return stdout.includes("Usage:") || stdout.includes("usage:");
});

test("--help shows all commands", () => {
  const { stdout } = cli("--help");
  return ["update", "clean", "prune", "stacks"].every(c => stdout.includes(c));
});

test("--help shows all options", () => {
  const { stdout } = cli("--help");
  return ["-y", "-s", "-b", "--path", "-C", "--bare", "-d", "-p", "-m", "-q", "-U"].every(o => stdout.includes(o));
});

test("stacks command lists all stacks", () => {
  const { stdout } = cli("stacks");
  return ["minimal", "base", "go", "rust", "java", "web", "full"].every(s => stdout.toLowerCase().includes(s));
});

test("invalid stack rejected", () => {
  const { code } = cli("-s invalid_stack .");
  return code !== 0;
});

// ════════════════════════════════════════════════════════════════════════════════
// DOCKER MODULE
// ════════════════════════════════════════════════════════════════════════════════
console.log(`\n${B}[8/9] docker.ts${X}`);

const docker = await import(join(ROOT, "dist/docker.js"));

test("safeDockerRun is function", () => typeof docker.safeDockerRun === "function");
test("checkDockerStatus is function", () => typeof docker.checkDockerStatus === "function");
test("getImageIds is function", () => typeof docker.getImageIds === "function");
test("getDanglingImageIds is function", () => typeof docker.getDanglingImageIds === "function");
test("imageHasParent is function", () => typeof docker.imageHasParent === "function");
test("removeImage is function", () => typeof docker.removeImage === "function");
test("removeContainer is function", () => typeof docker.removeContainer === "function");
test("listContainers is function", () => typeof docker.listContainers === "function");
test("listImages is function", () => typeof docker.listImages === "function");
test("buildImage is function", () => typeof docker.buildImage === "function");
test("runContainer is function", () => typeof docker.runContainer === "function");
test("ERR_DOCKER_NOT_RUNNING constant", () => docker.ERR_DOCKER_NOT_RUNNING === "Error: Docker is not running.");

// ════════════════════════════════════════════════════════════════════════════════
// UTILS MODULE
// ════════════════════════════════════════════════════════════════════════════════
console.log(`\n${B}[9/9] utils.ts${X}`);

const utils = await import(join(ROOT, "dist/utils.js"));

test("checkDocker is function", () => typeof utils.checkDocker === "function");
test("getGitConfig is async function", () => typeof utils.getGitConfig === "function");
test("ERR_DOCKER_NOT_RUNNING constant", () => utils.ERR_DOCKER_NOT_RUNNING === "Error: Docker is not running.");

// ════════════════════════════════════════════════════════════════════════════════
// GENERATOR MODULE
// ════════════════════════════════════════════════════════════════════════════════
console.log(`\n${B}[10/12] generator.ts${X}`);

const generator = await import(join(ROOT, "dist/generator.js"));

test("generateDockerfile is function", () => typeof generator.generateDockerfile === "function");
test("generateEntrypoint is function", () => typeof generator.generateEntrypoint === "function");
test("writeBuildFiles is function", () => typeof generator.writeBuildFiles === "function");
test("generateProjectDockerfile is function", () => typeof generator.generateProjectDockerfile === "function");
test("transformSlashCommand is function", () => typeof generator.transformSlashCommand === "function");
test("getHostUserIds is function", () => typeof generator.getHostUserIds === "function");
test("getHostTimezone is function", () => typeof generator.getHostTimezone === "function");
test("getTerminalSize is function", () => typeof generator.getTerminalSize === "function");
test("buildClaudeArgs is function", () => typeof generator.buildClaudeArgs === "function");
test("getDockerRunCmd is function", () => typeof generator.getDockerRunCmd === "function");

// generateDockerfile produces valid content
test("generateDockerfile(minimal) returns Dockerfile", () => {
  const df = generator.generateDockerfile(LanguageStack.MINIMAL);
  return df.includes("FROM") && df.includes("node") && df.length > 100;
});

test("generateDockerfile(go) includes golang", () => {
  const df = generator.generateDockerfile(LanguageStack.GO);
  return df.includes("golang") && df.includes("FROM");
});

test("generateDockerfile(rust) includes rust", () => {
  const df = generator.generateDockerfile(LanguageStack.RUST);
  return df.includes("rust") && df.includes("FROM");
});

test("generateDockerfile(java) includes jdk/temurin", () => {
  const df = generator.generateDockerfile(LanguageStack.JAVA);
  return (df.includes("temurin") || df.includes("jdk")) && df.includes("FROM");
});

// transformSlashCommand tests
test("transformSlashCommand /init unchanged (builtin)", () => {
  const result = generator.transformSlashCommand("/init");
  return result === "/init"; // Built-in command, not transformed
});

test("transformSlashCommand /init with args unchanged", () => {
  const result = generator.transformSlashCommand("/init create a REST API");
  return result === "/init create a REST API"; // Built-in command with args
});

test("transformSlashCommand regular prompt", () => {
  const result = generator.transformSlashCommand("write a function");
  return result === "write a function";
});

test("transformSlashCommand undefined", () => {
  const result = generator.transformSlashCommand(undefined);
  return result === undefined;
});

// getHostUserIds
test("getHostUserIds returns [uid, gid]", () => {
  const [uid, gid] = generator.getHostUserIds();
  return typeof uid === "number" && typeof gid === "number" && uid >= 0 && gid >= 0;
});

// getHostTimezone
test("getHostTimezone returns string", () => {
  const tz = generator.getHostTimezone();
  return typeof tz === "string" && tz.length > 0;
});

// getTerminalSize
test("getTerminalSize returns columns and lines", () => {
  const size = generator.getTerminalSize();
  return typeof size.columns === "number" && typeof size.lines === "number" && size.columns > 0 && size.lines > 0;
});

// buildClaudeArgs returns array
test("buildClaudeArgs returns array", () => {
  const args = generator.buildClaudeArgs({});
  return Array.isArray(args) && args.includes("--dangerously-skip-permissions");
});

test("buildClaudeArgs with prompt includes --print", () => {
  const args = generator.buildClaudeArgs({ prompt: "test prompt" });
  return args.includes("--print") && args.includes("test prompt");
});

test("buildClaudeArgs with model includes --model", () => {
  const args = generator.buildClaudeArgs({ model: "opus" });
  return args.includes("--model") && args.includes("opus");
});

test("buildClaudeArgs prompt triggers verbose", () => {
  const args = generator.buildClaudeArgs({ prompt: "test", quiet: false });
  return args.includes("--verbose");
});

test("buildClaudeArgs with multi-byte unicode prompt", () => {
  const args = generator.buildClaudeArgs({ prompt: "hello 🚀 world" });
  return args.includes("hello 🚀 world");
});

// ════════════════════════════════════════════════════════════════════════════════
// BUILD MODULE
// ════════════════════════════════════════════════════════════════════════════════
console.log(`\n${B}[11/12] build.ts${X}`);

const build = await import(join(ROOT, "dist/build.js"));

test("buildImage is function", () => typeof build.buildImage === "function");
test("getProjectImageName is function", () => typeof build.getProjectImageName === "function");
test("projectImageExists is function", () => typeof build.projectImageExists === "function");
test("buildProjectImage is function", () => typeof build.buildProjectImage === "function");
test("getInstalledCcboxImages is function", () => typeof build.getInstalledCcboxImages === "function");
test("ensureImageReady is function", () => typeof build.ensureImageReady === "function");

test("getProjectImageName format", () => {
  const name = build.getProjectImageName("my-project", LanguageStack.BASE);
  return name === "ccbox.my-project/base";
});

test("getProjectImageName sanitizes name", () => {
  const name = build.getProjectImageName("My Project@2.0", LanguageStack.GO);
  return name === "ccbox.my-project-2-0/go";
});

// ════════════════════════════════════════════════════════════════════════════════
// CLEANUP MODULE
// ════════════════════════════════════════════════════════════════════════════════
console.log(`\n${B}[12/12] cleanup.ts${X}`);

const cleanup = await import(join(ROOT, "dist/cleanup.js"));

test("cleanupCcboxDanglingImages is function", () => typeof cleanup.cleanupCcboxDanglingImages === "function");
test("pruneStaleResources is function", () => typeof cleanup.pruneStaleResources === "function");
test("removeCcboxContainers is function", () => typeof cleanup.removeCcboxContainers === "function");
test("removeCcboxImages is function", () => typeof cleanup.removeCcboxImages === "function");
test("getDockerDiskUsage is function", () => typeof cleanup.getDockerDiskUsage === "function");
test("pruneSystem is function", () => typeof cleanup.pruneSystem === "function");
test("cleanTempFiles is function", () => typeof cleanup.cleanTempFiles === "function");

// cleanTempFiles (safe to run)
test("cleanTempFiles returns count", () => {
  const count = cleanup.cleanTempFiles();
  return typeof count === "number" && count >= 0;
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
  console.log(`${G}Coverage: errors, constants, config, detector, deps, paths, CLI, docker, utils${X}`);
}
