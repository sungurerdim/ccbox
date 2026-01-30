/**
 * Build operations for ccbox.
 *
 * Handles Docker image building for stacks and projects.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { execa, type Options as ExecaOptions } from "execa";

import {
  getImageName,
  imageExists,
  LanguageStack,
  STACK_DEPENDENCIES,
} from "./config.js";
import { DOCKER_BUILD_TIMEOUT, DOCKER_COMMAND_TIMEOUT } from "./constants.js";
import type { DepsInfo, DepsMode } from "./deps.js";
import { computeDepsHash } from "./deps.js";
import { ImageBuildError } from "./errors.js";
import { generateProjectDockerfile, writeBuildFiles } from "./generator.js";
import { log } from "./logger.js";
import { getDockerEnv, getClaudeConfigDir, resolveForDocker } from "./paths.js";
import { cleanupCcboxDanglingImages } from "./cleanup.js";
import { removeImage } from "./docker.js";

/**
 * Run claude install in container to set up installMethod in host config.
 * This is run once after base image build to configure the host's .claude.json.
 */
async function runClaudeInstall(): Promise<void> {
  const claudeConfig = getClaudeConfigDir();
  const dockerClaudeConfig = resolveForDocker(claudeConfig);

  log.dim("Configuring Claude Code installation...");

  try {
    await execa(
      "docker",
      [
        "run",
        "--rm",
        "--cap-add=SYS_ADMIN",
        "--device", "/dev/fuse",
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
    log.dim("Claude Code configured");
  } catch {
    // Non-fatal - configuration will be done on first run
    log.dim("Claude install skipped (will configure on first run)");
  }
}

/** Build options for Docker image building. */
export interface BuildOptions {
  /** Docker build progress mode: auto (default), plain, or tty. */
  progress?: string;
  /** Use Docker build cache (default: true). */
  cache?: boolean;
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
  const { progress = "auto", cache = true } = options;

  // Check if this stack depends on base image
  const dependency = STACK_DEPENDENCIES[stack];
  if (dependency !== null && !imageExists(dependency)) {
    log.dim(`Building dependency: ccbox_${dependency}:latest...`);
    if (!(await buildImage(dependency, options))) {
      throw new ImageBuildError(`Failed to build dependency ccbox/${dependency}`);
    }
  }

  const imageName = getImageName(stack);
  log.bold(`Building ${imageName}...`);

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
    `--progress=${progress}`,
  ];
  if (!cache) {
    buildArgs.push("--no-cache");
  }

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

    log.success(`Built ${imageName}`);

    // Post-build cleanup: remove temp build files
    try {
      rmSync(buildDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }

    // Clean dangling images
    await cleanupCcboxDanglingImages();

    // For base image: run claude install to set up installMethod in host config
    if (stack === LanguageStack.BASE) {
      await runClaudeInstall();
    }

    return true;
  } catch (error: unknown) {
    // Extract error details for the exception message
    let errorDetails = "Unknown error";
    if (error instanceof Error) {
      const execaError = error as { stderr?: string; shortMessage?: string };
      if (execaError.stderr) {
        errorDetails = execaError.stderr.slice(0, 500);
      } else if (execaError.shortMessage) {
        errorDetails = execaError.shortMessage;
      } else {
        errorDetails = error.message;
      }
    }
    throw new ImageBuildError(`Failed to build ${imageName}: ${errorDetails}`);
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
  return `ccbox_${stack}:${safeName}`;
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
  const { progress = "auto", cache = true } = options;
  const imageName = getProjectImageName(projectName, stack);
  const baseImage = getImageName(stack);

  // Compute dependency hash for cache invalidation
  const depsHash = computeDepsHash(depsList, projectPath);

  log.newline();
  log.bold("Building project image with dependencies...");

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
      ["build", "-t", imageName, "-f", dockerfilePath, "--label", `ccbox.deps-hash=${depsHash}`, ...(cache ? [] : ["--no-cache"]), `--progress=${progress}`, projectPath],
      {
        stdio: "inherit",
        env,
        timeout: DOCKER_BUILD_TIMEOUT,
        reject: true,
      } as ExecaOptions
    );

    log.success(`Built ${imageName}`);

    // Cleanup temp build files
    try {
      rmSync(buildDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }

    return imageName;
  } catch (error: unknown) {
    // Extract error details
    let errorDetails = "Unknown error";
    let isTimeout = false;
    if (error instanceof Error) {
      const execaError = error as { stderr?: string; shortMessage?: string; timedOut?: boolean };
      isTimeout = !!execaError.timedOut;
      if (execaError.stderr) {
        errorDetails = execaError.stderr.slice(0, 500);
      } else if (execaError.shortMessage) {
        errorDetails = execaError.shortMessage;
      } else {
        errorDetails = error.message;
      }
    }

    // Log warning but don't throw - project image build failure is non-fatal
    log.warn(`Failed to build ${imageName}: ${errorDetails}`);
    if (isTimeout) {
      log.warn("Build timed out. Try increasing --build-timeout or simplifying dependencies.");
    }

    // Cleanup partial image on failure (prevent dangling)
    try {
      await removeImage(imageName, true);
    } catch {
      // Ignore - image may not have been created
    }

    // Cleanup temp build files
    try {
      rmSync(buildDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }

    return null;
  }
}

/**
 * Get the deps hash label from an existing project image.
 * Returns null if image doesn't exist or has no hash label.
 */
export async function getProjectImageDepsHash(projectName: string, stack: LanguageStack): Promise<string | null> {
  const imageName = getProjectImageName(projectName, stack);
  try {
    const result = await execa(
      "docker",
      ["inspect", "--format", "{{index .Config.Labels \"ccbox.deps-hash\"}}", imageName],
      {
        timeout: DOCKER_COMMAND_TIMEOUT,
        env: getDockerEnv(),
        reject: false,
        encoding: "utf8",
      } as ExecaOptions
    );
    if (result.exitCode !== 0) { return null; }
    const hash = String(result.stdout ?? "").trim();
    return hash || null;
  } catch {
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
    return new Set(allImages.filter((img: string) => img.startsWith("ccbox_")));
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
