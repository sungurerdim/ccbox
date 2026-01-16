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
import { getDockerEnv } from "./paths.js";
import { cleanupCcboxDanglingImages } from "./cleanup.js";

/**
 * Build Docker image for stack with BuildKit optimization.
 */
export async function buildImage(stack: LanguageStack): Promise<boolean> {
  // Check if this stack depends on base image
  const dependency = STACK_DEPENDENCIES[stack];
  if (dependency !== null && !imageExists(dependency)) {
    console.log(chalk.dim(`Building dependency: ccbox/${dependency}...`));
    if (!(await buildImage(dependency))) {
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

  try {
    await execa(
      "docker",
      [
        "build",
        "--output",
        `type=image,name=${imageName},compression=zstd,compression-level=3`,
        "-f",
        join(buildDir, "Dockerfile"),
        "--no-cache",
        "--pull",
        "--progress=auto",
        buildDir,
      ],
      {
        stdio: "inherit",
        env,
        reject: true,
      } as ExecaOptions
    );

    console.log(chalk.green(`Built ${imageName}`));

    // Post-build cleanup
    await cleanupCcboxDanglingImages();

    return true;
  } catch {
    console.log(chalk.red(`Failed to build ${imageName}`));
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
 */
export async function buildProjectImage(
  projectPath: string,
  projectName: string,
  stack: LanguageStack,
  depsList: DepsInfo[],
  depsMode: DepsMode
): Promise<string | null> {
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
    await execa(
      "docker",
      ["build", "-t", imageName, "-f", dockerfilePath, "--no-cache", "--pull", "--progress=auto", projectPath],
      {
        stdio: "inherit",
        env,
        timeout: DOCKER_BUILD_TIMEOUT,
        reject: true,
      } as ExecaOptions
    );

    console.log(chalk.green(`Built ${imageName}`));
    return imageName;
  } catch {
    console.log(chalk.red(`Failed to build ${imageName}`));
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

    if (result.exitCode !== 0) return new Set();

    const allImages = String(result.stdout ?? "").trim().split("\n");
    return new Set(allImages.filter((img: string) => img.startsWith("ccbox:")));
  } catch {
    return new Set();
  }
}

/**
 * Ensure the image is ready (built if needed).
 */
export async function ensureImageReady(stack: LanguageStack, buildOnly: boolean): Promise<boolean> {
  const needsBuild = buildOnly || !imageExists(stack);
  if (needsBuild) {
    return buildImage(stack);
  }
  return true;
}
