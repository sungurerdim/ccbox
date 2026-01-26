/**
 * Build operations for ccbox.
 *
 * Handles Docker image building for stacks and projects.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import chalk from "chalk";
import { execa, type Options as ExecaOptions } from "execa";

import {
  getImageName,
  imageExists,
  LanguageStack,
  STACK_DEPENDENCIES,
} from "./config.js";
import { DOCKER_BUILD_TIMEOUT, DOCKER_COMMAND_TIMEOUT } from "./constants.js";
import type { DepsInfo, DepsMode } from "./deps.js";
import { generateProjectDockerfile, writeBuildFiles } from "./generator.js";
import { getDockerEnv, getClaudeConfigDir, resolveForDocker } from "./paths.js";
import { cleanupCcboxDanglingImages } from "./cleanup.js";

/**
 * Run claude install in container to set up installMethod in host config.
 * This is run once after base image build to configure the host's .claude.json.
 */
async function runClaudeInstall(): Promise<void> {
  const claudeConfig = getClaudeConfigDir();
  const dockerClaudeConfig = resolveForDocker(claudeConfig);

  console.log(chalk.dim("Configuring Claude Code installation..."));

  try {
    await execa(
      "docker",
      [
        "run",
        "--rm",
        "--privileged",
        "-v",
        `${dockerClaudeConfig}:/ccbox/.claude:rw`,
        "-e",
        "HOME=/ccbox",
        "-e",
        "CLAUDE_CONFIG_DIR=/ccbox/.claude",
        getImageName(LanguageStack.BASE),
        "claude",
        "install",
        "--force",
      ],
      {
        timeout: 60000,
        env: getDockerEnv(),
        reject: false,
        stdio: "pipe",
      } as ExecaOptions
    );
    console.log(chalk.dim("Claude Code configured"));
  } catch {
    // Non-fatal - configuration will be done on first run
    console.log(chalk.dim("Claude install skipped (will configure on first run)"));
  }
}

/** Build options for Docker image building. */
export interface BuildOptions {
  /** Docker build progress mode: auto (default), plain, or tty. */
  progress?: string;
}

/**
 * Build Docker image for stack with BuildKit optimization.
 *
 * @param stack - Language stack to build
 * @param options - Build options including progress mode
 */
export async function buildImage(
  stack: LanguageStack,
  options: BuildOptions = {}
): Promise<boolean> {
  const { progress = "auto" } = options;

  // Check if this stack depends on base image
  const dependency = STACK_DEPENDENCIES[stack];
  if (dependency !== null && !imageExists(dependency)) {
    console.log(chalk.dim(`Building dependency: ccbox/${dependency}...`));
    if (!(await buildImage(dependency, options))) {
      console.log(chalk.red(`Failed to build dependency ccbox/${dependency}`));
      return false;
    }
  }

  const imageName = getImageName(stack);
  console.log(chalk.bold(`Building ${imageName}...`));

  const buildDir = writeBuildFiles(stack);

  // Enable BuildKit for faster, more efficient builds
  const env = {
    ...getDockerEnv(),
    DOCKER_BUILDKIT: "1",
  };

  // Build args: only use --pull for stacks with external base images (no ccbox dependency)
  // Stacks with ccbox dependencies (python, web, full) use local images
  const buildArgs = [
    "build",
    "--output",
    `type=image,name=${imageName},compression=zstd,compression-level=3`,
    "-f",
    join(buildDir, "Dockerfile"),
    "--no-cache",
    `--progress=${progress}`,
  ];

  // Only pull for stacks with external base images (base, go, rust, java)
  if (dependency === null) {
    buildArgs.push("--pull");
  }

  buildArgs.push(buildDir);

  try {
    await execa("docker", buildArgs, {
      stdio: "inherit",
      env,
      reject: true,
    } as ExecaOptions);

    console.log(chalk.green(`Built ${imageName}`));

    // Post-build cleanup
    await cleanupCcboxDanglingImages();

    // For base image: run claude install to set up installMethod in host config
    if (stack === LanguageStack.BASE) {
      await runClaudeInstall();
    }

    return true;
  } catch (error: unknown) {
    console.log(chalk.red(`Failed to build ${imageName}`));
    // Show detailed error for debugging
    if (error instanceof Error) {
      const execaError = error as { stderr?: string; shortMessage?: string };
      if (execaError.stderr) {
        console.log(chalk.dim(`Error details: ${execaError.stderr.slice(0, 500)}`));
      } else if (execaError.shortMessage) {
        console.log(chalk.dim(`Error: ${execaError.shortMessage}`));
      } else {
        console.log(chalk.dim(`Error: ${error.message}`));
      }
    }
    return false;
  }
}

/**
 * Get project-specific image name.
 */
export function getProjectImageName(projectName: string, stack: LanguageStack): string {
  const safeName = projectName
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .slice(0, 110);
  return `ccbox.${safeName}/${stack}`;
}

/**
 * Check if project-specific image exists.
 */
export async function projectImageExists(projectName: string, stack: LanguageStack): Promise<boolean> {
  const imageName = getProjectImageName(projectName, stack);
  try {
    const result = await execa("docker", ["image", "inspect", imageName], {
      timeout: DOCKER_COMMAND_TIMEOUT,
      env: getDockerEnv(),
      reject: false,
    } as ExecaOptions);
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Build project-specific image with dependencies.
 *
 * @param projectPath - Path to the project directory
 * @param projectName - Name of the project (for image naming)
 * @param stack - Language stack to base the image on
 * @param depsList - List of detected dependencies
 * @param depsMode - Dependency installation mode (all, prod, skip)
 * @param options - Build options including progress mode
 */
export async function buildProjectImage(
  projectPath: string,
  projectName: string,
  stack: LanguageStack,
  depsList: DepsInfo[],
  depsMode: DepsMode,
  options: BuildOptions = {}
): Promise<string | null> {
  const { progress = "auto" } = options;
  const imageName = getProjectImageName(projectName, stack);
  const baseImage = getImageName(stack);

  console.log(chalk.bold("\nBuilding project image with dependencies..."));

  // Generate Dockerfile
  const dockerfileContent = generateProjectDockerfile(baseImage, depsList, depsMode, projectPath);

  // Write to temp build directory
  const buildDir = join(tmpdir(), "ccbox", "build", "project", projectName);
  mkdirSync(buildDir, { recursive: true });

  const dockerfilePath = join(buildDir, "Dockerfile");
  writeFileSync(dockerfilePath, dockerfileContent, { encoding: "utf-8" });

  const env = {
    ...getDockerEnv(),
    DOCKER_BUILDKIT: "1",
  };

  try {
    // Note: no --pull flag since we're building on top of local ccbox images
    await execa(
      "docker",
      ["build", "-t", imageName, "-f", dockerfilePath, "--no-cache", `--progress=${progress}`, projectPath],
      {
        stdio: "inherit",
        env,
        timeout: DOCKER_BUILD_TIMEOUT,
        reject: true,
      } as ExecaOptions
    );

    console.log(chalk.green(`Built ${imageName}`));
    return imageName;
  } catch (error: unknown) {
    console.log(chalk.red(`Failed to build ${imageName}`));
    // Show detailed error for debugging
    if (error instanceof Error) {
      const execaError = error as { stderr?: string; shortMessage?: string };
      if (execaError.stderr) {
        console.log(chalk.dim(`Error details: ${execaError.stderr.slice(0, 500)}`));
      } else if (execaError.shortMessage) {
        console.log(chalk.dim(`Error: ${execaError.shortMessage}`));
      } else {
        console.log(chalk.dim(`Error: ${error.message}`));
      }
    }
    return null;
  }
}

/**
 * Get all installed ccbox images in a single Docker call.
 */
export async function getInstalledCcboxImages(): Promise<Set<string>> {
  try {
    const result = await execa("docker", ["images", "--format", "{{.Repository}}:{{.Tag}}"], {
      timeout: DOCKER_COMMAND_TIMEOUT,
      env: getDockerEnv(),
      reject: false,
      encoding: "utf8",
    } as ExecaOptions);

    if (result.exitCode !== 0) {return new Set();}

    const allImages = String(result.stdout ?? "").trim().split("\n");
    return new Set(allImages.filter((img: string) => img.startsWith("ccbox:")));
  } catch {
    return new Set();
  }
}

/**
 * Ensure the image is ready (built if needed).
 *
 * @param stack - Language stack to ensure
 * @param buildOnly - Force rebuild even if image exists
 * @param options - Build options including progress mode
 */
export async function ensureImageReady(
  stack: LanguageStack,
  buildOnly: boolean,
  options: BuildOptions = {}
): Promise<boolean> {
  const needsBuild = buildOnly || !imageExists(stack);
  if (needsBuild) {
    return buildImage(stack, options);
  }
  return true;
}
