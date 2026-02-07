/**
 * Build operations for ccbox.
 *
 * Handles Docker image building for stacks and projects.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { exec, execInherit } from "./exec.js";
import { getCcboxTempBuild } from "./constants.js";

import {
  getImageName,
  imageExistsAsync,
  LanguageStack,
  STACK_DEPENDENCIES,
} from "./config.js";
import { DOCKER_BUILD_TIMEOUT, DOCKER_COMMAND_TIMEOUT } from "./constants.js";
import type { DepsInfo, DepsMode } from "./deps.js";
import { computeDepsHash } from "./deps.js";
import { ImageBuildError, extractErrorDetails, isTimeoutError } from "./errors.js";
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
    await exec(
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
      }
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
  const { progress = "auto", cache = false } = options;

  // Check if this stack depends on base image (async to avoid blocking)
  const dependency = STACK_DEPENDENCIES[stack];
  if (dependency !== null && !(await imageExistsAsync(dependency))) {
    log.dim(`Building dependency: ccbox_${dependency}:latest...`);
    if (!(await buildImage(dependency, options))) {
      throw new ImageBuildError(`Failed to build dependency ccbox/${dependency}`);
    }
  }

  const imageName = getImageName(stack);
  log.bold(`Building ${imageName}...`);

  let buildDir: string;
  try {
    buildDir = writeBuildFiles(stack);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new ImageBuildError(`Failed to prepare build files for ${imageName}: ${msg}`);
  }

  // Enable BuildKit for faster, more efficient builds
  const env = {
    ...getDockerEnv(),
    DOCKER_BUILDKIT: "1",
  };

  // Build args: only use --pull for stacks with external base images (no ccbox dependency)
  // Stacks with ccbox dependencies (python, web, full) use local images
  const buildArgs = [
    "build",
    "-t",
    imageName,
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
    await execInherit("docker", buildArgs, {
      env,
      reject: true,
    });

    log.success(`Built ${imageName}`);

    // Post-build cleanup: remove temp build files
    try {
      rmSync(buildDir, { recursive: true, force: true });
    } catch (e) {
      log.debug(`Cleanup error: ${String(e)}`);
    }

    // Clean dangling images (fire-and-forget with error handler)
    cleanupCcboxDanglingImages().catch((e: unknown) => {
      log.debug(`Dangling image cleanup failed: ${e instanceof Error ? e.message : String(e)}`);
    });

    // For base image: run claude install to set up installMethod in host config
    if (stack === LanguageStack.BASE) {
      await runClaudeInstall();
    }

    return true;
  } catch (error: unknown) {
    throw new ImageBuildError(`Failed to build ${imageName}: ${extractErrorDetails(error)}`);
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
    const result = await exec("docker", ["image", "inspect", imageName], {
      timeout: DOCKER_COMMAND_TIMEOUT,
      env: getDockerEnv(),
    });
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
): Promise<string> {
  const { progress = "auto", cache = false } = options;
  const imageName = getProjectImageName(projectName, stack);
  const baseImage = getImageName(stack);

  // Compute dependency hash for cache invalidation
  const depsHash = computeDepsHash(depsList, projectPath);

  log.newline();
  log.bold("Building project image with dependencies...");

  // Generate Dockerfile
  const dockerfileContent = generateProjectDockerfile(baseImage, depsList, depsMode, projectPath);

  // Write to temp build directory
  const buildDir = getCcboxTempBuild(join("project", projectName));
  mkdirSync(buildDir, { recursive: true });

  const dockerfilePath = join(buildDir, "Dockerfile");
  writeFileSync(dockerfilePath, dockerfileContent, { encoding: "utf-8" });

  const env = {
    ...getDockerEnv(),
    DOCKER_BUILDKIT: "1",
  };

  try {
    // Note: no --pull flag since we're building on top of local ccbox images
    await execInherit(
      "docker",
      ["build", "-t", imageName, "-f", dockerfilePath, "--label", `ccbox.deps-hash=${depsHash}`, ...(cache ? [] : ["--no-cache"]), `--progress=${progress}`, projectPath],
      {
        env,
        timeout: DOCKER_BUILD_TIMEOUT,
        reject: true,
      }
    );

    log.success(`Built ${imageName}`);

    // Cleanup temp build files
    try {
      rmSync(buildDir, { recursive: true, force: true });
    } catch (e) {
      log.debug(`Cleanup error: ${String(e)}`);
    }

    return imageName;
  } catch (error: unknown) {
    const errorDetails = extractErrorDetails(error);
    // Log full stderr for debugging if available
    if (error instanceof Error) {
      const execaError = error as { stderr?: string };
      if (execaError.stderr) {
        log.debug(`Full stderr: ${execaError.stderr}`);
      }
    }

    log.error(`Failed to build ${imageName}: ${errorDetails}`);
    if (isTimeoutError(error)) {
      log.error("Build timed out. Try increasing --build-timeout or simplifying dependencies.");
    }

    // Cleanup partial image on failure (prevent dangling)
    try {
      await removeImage(imageName, true);
    } catch (e) {
      log.debug(`Image cleanup error: ${String(e)}`);
    }

    // Cleanup temp build files
    try {
      rmSync(buildDir, { recursive: true, force: true });
    } catch (e) {
      log.debug(`Cleanup error: ${String(e)}`);
    }

    throw error;
  }
}

/**
 * Get the deps hash label from an existing project image.
 * Returns null if image doesn't exist or has no hash label.
 */
export async function getProjectImageDepsHash(projectName: string, stack: LanguageStack): Promise<string | null> {
  const imageName = getProjectImageName(projectName, stack);
  try {
    const result = await exec(
      "docker",
      ["inspect", "--format", "{{index .Config.Labels \"ccbox.deps-hash\"}}", imageName],
      {
        timeout: DOCKER_COMMAND_TIMEOUT,
        env: getDockerEnv(),
        encoding: "utf8",
      }
    );
    if (result.exitCode !== 0) { return null; }
    const hash = result.stdout.trim();
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
    const result = await exec("docker", ["images", "--format", "{{.Repository}}:{{.Tag}}"], {
      timeout: DOCKER_COMMAND_TIMEOUT,
      env: getDockerEnv(),
      encoding: "utf8",
    });

    if (result.exitCode !== 0) {return new Set();}

    const allImages = result.stdout.trim().split("\n");
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
  const needsBuild = buildOnly || !(await imageExistsAsync(stack));
  if (needsBuild) {
    return buildImage(stack, options);
  }
  return true;
}
