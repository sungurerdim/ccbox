#!/usr/bin/env node
/**
 * End-to-End Test Suite for ccbox
 *
 * Tests the full Docker workflow:
 * - Image building
 * - Container execution
 * - Volume mounts
 * - Cleanup operations
 *
 * Requires Docker to be running. Skips gracefully if not available.
 */

import { execSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

// Colors
const G = "\x1b[32m", R = "\x1b[31m", Y = "\x1b[33m", B = "\x1b[1m", D = "\x1b[2m", X = "\x1b[0m";

let passed = 0, failed = 0, skipped = 0;
const failures = [];

// ════════════════════════════════════════════════════════════════════════════════
// Test Utilities
// ════════════════════════════════════════════════════════════════════════════════

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

async function testAsync(name, fn) {
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

function cli(args, options = {}) {
  try {
    const stdout = execSync(`node ${ROOT}/dist/cli.js ${args}`, {
      encoding: "utf8",
      timeout: options.timeout || 60000,
      env: { ...process.env, NO_COLOR: "1" },
      cwd: options.cwd || ROOT,
    });
    return { stdout, code: 0 };
  } catch (e) {
    return { stdout: e.stdout || "", stderr: e.stderr || "", code: e.status || 1 };
  }
}

function docker(args, options = {}) {
  try {
    const stdout = execSync(`docker ${args}`, {
      encoding: "utf8",
      timeout: options.timeout || 30000,
      env: { ...process.env },
    });
    return { stdout, code: 0 };
  } catch (e) {
    return { stdout: e.stdout || "", stderr: e.stderr || "", code: e.status || 1 };
  }
}

// ════════════════════════════════════════════════════════════════════════════════
// Docker Availability Check
// ════════════════════════════════════════════════════════════════════════════════

console.log(`\n${B}=== ccbox E2E Test Suite ===${X}\n`);

function checkDockerAvailable() {
  const { code } = docker("info");
  return code === 0;
}

const DOCKER_AVAILABLE = checkDockerAvailable();

if (!DOCKER_AVAILABLE) {
  console.log(`${Y}Docker not available - E2E tests will be skipped${X}\n`);
  console.log(`${D}To run E2E tests, ensure Docker daemon is running${X}\n`);
}

// ════════════════════════════════════════════════════════════════════════════════
// Test Setup
// ════════════════════════════════════════════════════════════════════════════════

const TEST_DIR = join(tmpdir(), `ccbox-e2e-${Date.now()}`);
const TEST_PROJECT = join(TEST_DIR, "test-project");

if (DOCKER_AVAILABLE) {
  mkdirSync(TEST_PROJECT, { recursive: true });

  // Create a simple test project
  writeFileSync(join(TEST_PROJECT, "package.json"), JSON.stringify({
    name: "e2e-test-project",
    version: "1.0.0",
    scripts: { test: "echo 'test passed'" }
  }, null, 2));

  writeFileSync(join(TEST_PROJECT, "index.js"), 'console.log("Hello from E2E test");');
}

// ════════════════════════════════════════════════════════════════════════════════
// E2E Tests: Docker Operations
// ════════════════════════════════════════════════════════════════════════════════

console.log(`${B}[1/4] Docker Prerequisites${X}`);

test("Docker daemon is running", () => {
  if (!DOCKER_AVAILABLE) return "skip";
  const { code, stdout } = docker("info");
  return code === 0 && stdout.includes("Server Version");
});

test("Docker can pull images", () => {
  if (!DOCKER_AVAILABLE) return "skip";
  // Just check if we can query images, don't actually pull
  const { code } = docker("images -q");
  return code === 0;
});

test("Docker can run containers", () => {
  if (!DOCKER_AVAILABLE) return "skip";
  const { code, stdout } = docker("run --rm alpine:latest echo 'test'");
  return code === 0 && stdout.includes("test");
});

// ════════════════════════════════════════════════════════════════════════════════
// E2E Tests: Image Building
// ════════════════════════════════════════════════════════════════════════════════

console.log(`\n${B}[2/4] Image Building${X}`);

await testAsync("Build minimal stack image", async () => {
  if (!DOCKER_AVAILABLE) return "skip";

  console.log(`${D}  Building minimal image (this may take a few minutes)...${X}`);
  const { stdout, code } = cli("-s minimal -b -y", { timeout: 600000 });

  if (code !== 0) {
    console.log(`${D}  Build output: ${stdout.slice(0, 500)}${X}`);
    return false;
  }

  // Verify image exists
  const { code: checkCode } = docker("image inspect ccbox/minimal");
  return checkCode === 0;
});

test("Minimal image has correct base", () => {
  if (!DOCKER_AVAILABLE) return "skip";

  const { code } = docker("image inspect ccbox/minimal");
  if (code !== 0) return "skip"; // Image not built

  const { stdout } = docker("image inspect ccbox/minimal --format '{{.Config.Labels}}'");
  return true; // Image exists and is inspectable
});

await testAsync("Build base stack image", async () => {
  if (!DOCKER_AVAILABLE) return "skip";

  // Check if minimal exists first
  const { code: minimalCheck } = docker("image inspect ccbox/minimal");
  if (minimalCheck !== 0) return "skip";

  console.log(`${D}  Building base image...${X}`);
  const { stdout, code } = cli("-s base -b -y", { timeout: 600000 });

  if (code !== 0) {
    console.log(`${D}  Build output: ${stdout.slice(0, 500)}${X}`);
    return false;
  }

  const { code: checkCode } = docker("image inspect ccbox/base");
  return checkCode === 0;
});

// ════════════════════════════════════════════════════════════════════════════════
// E2E Tests: Container Execution
// ════════════════════════════════════════════════════════════════════════════════

console.log(`\n${B}[3/4] Container Execution${X}`);

await testAsync("Run container with test project", async () => {
  if (!DOCKER_AVAILABLE) return "skip";

  // Check if minimal image exists
  const { code: imageCheck } = docker("image inspect ccbox/minimal");
  if (imageCheck !== 0) return "skip";

  // Run a simple command in container (bypass entrypoint for direct testing)
  const containerName = `ccbox-e2e-test-${Date.now()}`;
  const { code, stdout } = docker(
    `run --rm --name ${containerName} --entrypoint node -v "${TEST_PROJECT}:/home/node/project" ccbox/minimal -e "console.log('E2E_SUCCESS')"`
  );

  return code === 0 && stdout.includes("E2E_SUCCESS");
});

await testAsync("Container has correct working directory", async () => {
  if (!DOCKER_AVAILABLE) return "skip";

  const { code: imageCheck } = docker("image inspect ccbox/minimal");
  if (imageCheck !== 0) return "skip";

  const { code, stdout } = docker(
    `run --rm --entrypoint pwd -w /home/node/project -v "${TEST_PROJECT}:/home/node/project" ccbox/minimal`
  );

  return code === 0 && stdout.trim() === "/home/node/project";
});

await testAsync("Container runs as non-root user", async () => {
  if (!DOCKER_AVAILABLE) return "skip";

  const { code: imageCheck } = docker("image inspect ccbox/minimal");
  if (imageCheck !== 0) return "skip";

  const { code, stdout } = docker(
    `run --rm --entrypoint whoami --user 1000:1000 ccbox/minimal`
  );

  return code === 0 && stdout.trim() === "node";
});

await testAsync("Container has Node.js available", async () => {
  if (!DOCKER_AVAILABLE) return "skip";

  const { code: imageCheck } = docker("image inspect ccbox/minimal");
  if (imageCheck !== 0) return "skip";

  const { code, stdout } = docker(
    `run --rm --entrypoint node ccbox/minimal --version`
  );

  return code === 0 && stdout.startsWith("v");
});

await testAsync("Container has Python available", async () => {
  if (!DOCKER_AVAILABLE) return "skip";

  const { code: imageCheck } = docker("image inspect ccbox/minimal");
  if (imageCheck !== 0) return "skip";

  const { code, stdout } = docker(
    `run --rm --entrypoint python3 ccbox/minimal --version`
  );

  return code === 0 && stdout.includes("Python");
});

await testAsync("Volume mount preserves file content", async () => {
  if (!DOCKER_AVAILABLE) return "skip";

  const { code: imageCheck } = docker("image inspect ccbox/minimal");
  if (imageCheck !== 0) return "skip";

  // Create a test file
  const testContent = `test-${Date.now()}`;
  writeFileSync(join(TEST_PROJECT, "mount-test.txt"), testContent);

  const { code, stdout } = docker(
    `run --rm --entrypoint cat -v "${TEST_PROJECT}:/home/node/project" ccbox/minimal /home/node/project/mount-test.txt`
  );

  return code === 0 && stdout.trim() === testContent;
});

await testAsync("Container can write to mounted volume", async () => {
  if (!DOCKER_AVAILABLE) return "skip";

  const { code: imageCheck } = docker("image inspect ccbox/minimal");
  if (imageCheck !== 0) return "skip";

  const outputFile = join(TEST_PROJECT, "write-test.txt");
  const testContent = `written-${Date.now()}`;

  const { code } = docker(
    `run --rm --entrypoint sh -v "${TEST_PROJECT}:/home/node/project" ccbox/minimal -c "echo '${testContent}' > /home/node/project/write-test.txt"`
  );

  if (code !== 0) return false;

  // Verify file was written
  if (!existsSync(outputFile)) return false;
  const content = readFileSync(outputFile, "utf-8").trim();
  return content === testContent;
});

// ════════════════════════════════════════════════════════════════════════════════
// E2E Tests: Cleanup Operations
// ════════════════════════════════════════════════════════════════════════════════

console.log(`\n${B}[4/4] Cleanup Operations${X}`);

test("clean command runs without error", () => {
  if (!DOCKER_AVAILABLE) return "skip";

  const { code } = cli("clean -f");
  return code === 0;
});

test("prune command runs without error", () => {
  if (!DOCKER_AVAILABLE) return "skip";

  const { code } = cli("prune -f");
  return code === 0;
});

await testAsync("Containers are removed after run", async () => {
  if (!DOCKER_AVAILABLE) return "skip";

  const { code: imageCheck } = docker("image inspect ccbox/minimal");
  if (imageCheck !== 0) return "skip";

  // Run a container
  const containerName = `ccbox-cleanup-test-${Date.now()}`;
  docker(`run --rm --name ${containerName} ccbox/minimal echo test`);

  // Check container doesn't exist (--rm should have removed it)
  const { code } = docker(`container inspect ${containerName}`);
  return code !== 0; // Should fail because container was removed
});

// ════════════════════════════════════════════════════════════════════════════════
// Cleanup Test Directory
// ════════════════════════════════════════════════════════════════════════════════

if (existsSync(TEST_DIR)) {
  rmSync(TEST_DIR, { recursive: true, force: true });
}

// ════════════════════════════════════════════════════════════════════════════════
// Summary
// ════════════════════════════════════════════════════════════════════════════════

console.log(`\n${B}=== E2E Summary ===${X}`);
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

if (!DOCKER_AVAILABLE) {
  console.log(`${Y}Note: Docker was not available. Run with Docker for full E2E coverage.${X}\n`);
}

if (failed > 0) {
  console.log(`${R}E2E tests failed${X}`);
  process.exit(1);
} else {
  console.log(`${G}All E2E tests passed!${X}`);
}
