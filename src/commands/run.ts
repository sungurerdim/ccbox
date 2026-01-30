/**
 * Run operations for ccbox.
 *
 * Handles container execution, diagnostics, and the main run workflow.
 */

import { basename } from "node:path";

import { exec, execInherit } from "../exec.js";
import {
  type Config,
  imageExists,
  LanguageStack,
} from "../config.js";
import { DOCKER_COMMAND_TIMEOUT } from "../constants.js";
import type { DepsInfo, DepsMode } from "../deps.js";
import { computeDepsHash, detectDependencies } from "../deps.js";
import { detectProjectType } from "../detector.js";
import { checkDockerStatus } from "../docker.js";
import { ImageBuildError } from "../errors.js";
import { getDockerRunCmd } from "../generator.js";
import { log } from "../logger.js";
import { getDockerEnv, validateProjectPath } from "../paths.js";
import {
  buildImage,
  buildProjectImage,
  ensureImageReady,
  getProjectImageName,
  getProjectImageDepsHash,
  projectImageExists,
} from "../build.js";
import { pruneStaleResources } from "../cleanup.js";
import { resolveStack, setupGitConfig } from "../prompts.js";
import { checkDocker, ERR_DOCKER_NOT_RUNNING } from "../utils.js";

/**
 * Diagnose container failure and provide actionable feedback.
 */
async function diagnoseContainerFailure(returncode: number, projectName: string): Promise<void> {
  // Known exit codes
  if (returncode === 137) {
    log.warn("Container was killed (OOM or manual stop)");
    log.dim("Try: ccbox --unrestricted (removes memory limits)");
    return;
  }
  if (returncode === 139) {
    log.warn("Container crashed (segmentation fault)");
    return;
  }
  if (returncode === 143) {
    log.dim("Container terminated by signal");
    return;
  }

  // Check Docker daemon health
  if (!(await checkDockerStatus())) {
    log.error("Docker daemon is not responding");
    log.dim("Docker may have restarted or crashed during session");
    return;
  }

  // Check for container still running (shouldn't happen with --rm)
  try {
    const result = await exec("docker", ["ps", "-q", "--filter", `name=ccbox-${projectName}`], {
      timeout: DOCKER_COMMAND_TIMEOUT,
      env: getDockerEnv(),
      encoding: "utf8",
    });

    if (result.stdout.trim()) {
      log.warn("Container still running (cleanup failed)");
      log.dim(`Run: docker rm -f ccbox-${projectName}`);
      return;
    }
  } catch {
    // Ignore errors
  }

  // Generic error with exit code
  if (returncode !== 0) {
    log.warn(`Container exited with code ${returncode}`);
    log.dim("Logs are preserved by default for investigation");
  }
}

/**
 * Execute the container with Claude Code.
 */
async function executeContainer(
  config: Config,
  projectPath: string,
  projectName: string,
  stack: LanguageStack,
  options: {
    fresh?: boolean;
    ephemeralLogs?: boolean;
    debug?: number;
    prompt?: string;
    model?: string;
    quiet?: boolean;
    appendSystemPrompt?: string;
    projectImage?: string;
    unrestricted?: boolean;
    envVars?: string[];
  } = {}
): Promise<void> {
  const {
    fresh = false,
    ephemeralLogs = false,
    debug = 0,
    prompt,
    model,
    quiet = false,
    appendSystemPrompt,
    projectImage,
    unrestricted = false,
    envVars,
  } = options;

  log.dim("Starting Claude Code...");
  log.newline();

  const cmd = getDockerRunCmd(config, projectPath, projectName, stack, {
    fresh,
    ephemeralLogs,
    debug,
    prompt,
    model,
    quiet,
    appendSystemPrompt,
    projectImage,
    unrestricted,
    envVars,
  });

  // Debug: print docker command
  if (debug >= 2) {
    log.dim("Docker command: " + cmd.join(" "));
  }

  // stdin: inherit for interactive, ignore for watch-only (-dd)
  const stdin = debug >= 2 ? "ignore" : "inherit";

  let returncode = 0;
  try {
    const p = execInherit("docker", cmd.slice(1), {
      env: getDockerEnv(),
      stdin: stdin as "inherit" | "ignore",
      stdio: [stdin, "inherit", "pipe"],
    });

    const child = p.child;

    // Filter Docker warnings from stderr (e.g. kernel swappiness, cgroup warnings)
    // Pass through all other stderr output (Claude Code errors, debug info)
    if (child.stderr) {
      let partial = "";
      child.stderr.on("data", (chunk: Buffer) => {
        const text = partial + chunk.toString();
        const lines = text.split("\n");
        partial = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("WARNING:")) {
            process.stderr.write(line + "\n");
          }
        }
      });
      child.stderr.on("end", () => {
        if (partial && !partial.startsWith("WARNING:")) {
          process.stderr.write(partial);
        }
      });
    }

    const result = await p;
    returncode = result.exitCode;
  } catch (error: unknown) {
    const err = error as { exitCode?: number };
    returncode = err.exitCode ?? 1;
  }

  // Handle exit codes
  if (returncode !== 0 && returncode !== 130) {
    // 0 = success, 130 = Ctrl+C
    await diagnoseContainerFailure(returncode, projectName);
    process.exit(returncode);
  }
}

/**
 * Try to run using existing project image. Returns true if handled.
 */
async function tryRunExistingImage(
  config: Config,
  projectPath: string,
  projectName: string,
  stack: LanguageStack,
  buildOnly: boolean,
  options: {
    fresh?: boolean;
    ephemeralLogs?: boolean;
    debug?: number;
    prompt?: string;
    model?: string;
    quiet?: boolean;
    appendSystemPrompt?: string;
    unrestricted?: boolean;
    envVars?: string[];
  } = {}
): Promise<boolean> {
  if (!(await projectImageExists(projectName, stack))) {
    return false;
  }

  const projectImage = getProjectImageName(projectName, stack);
  log.dim(`Using existing project image: ${projectImage}`);

  log.newline();
  log.blue(`[${projectName}] -> ${projectImage}`);

  if (buildOnly) {
    log.success("Build complete (image exists)");
    return true;
  }

  await executeContainer(config, projectPath, projectName, stack, {
    ...options,
    projectImage,
  });
  return true;
}

/**
 * Build images and run container (Phase 3).
 */
async function buildAndRun(
  config: Config,
  projectPath: string,
  projectName: string,
  selectedStack: LanguageStack,
  depsList: DepsInfo[],
  resolvedDepsMode: DepsMode,
  buildOnly: boolean,
  options: {
    fresh?: boolean;
    ephemeralLogs?: boolean;
    debug?: number;
    prompt?: string;
    model?: string;
    quiet?: boolean;
    appendSystemPrompt?: string;
    unrestricted?: boolean;
    progress?: string;
    cache?: boolean;
    envVars?: string[];
  } = {}
): Promise<void> {
  const { progress = "auto", cache = true } = options;

  log.newline();
  log.blue(`[${projectName}] -> ccbox/${selectedStack}`);

  // Ensure base image exists (required for all stacks)
  if (!imageExists(LanguageStack.BASE)) {
    log.bold("First-time setup: building base image...");
    try {
      await buildImage(LanguageStack.BASE, { progress, cache });
    } catch (error) {
      if (error instanceof ImageBuildError) {
        log.error(error.message);
      }
      process.exit(1);
    }
    log.newline();
  }

  // Ensure stack image is ready
  try {
    await ensureImageReady(selectedStack, false, { progress, cache });
  } catch (error) {
    if (error instanceof ImageBuildError) {
      log.error(error.message);
    }
    process.exit(1);
  }

  // Build project-specific image if deps requested
  let builtProjectImage: string | undefined = undefined;
  if (resolvedDepsMode !== "skip" && depsList.length > 0) {
    // Check if existing project image has matching deps hash (skip rebuild)
    const currentHash = computeDepsHash(depsList, projectPath);
    const existingHash = await getProjectImageDepsHash(projectName, selectedStack);

    if (existingHash && existingHash === currentHash) {
      builtProjectImage = getProjectImageName(projectName, selectedStack);
      log.dim(`Dependencies unchanged (${currentHash}), reusing project image`);
    } else {
      try {
        builtProjectImage = await buildProjectImage(
          projectPath,
          projectName,
          selectedStack,
          depsList,
          resolvedDepsMode,
          { progress, cache }
        );
      } catch {
        log.error("Failed to build project image with dependencies");
        process.exit(1);
      }
    }
  }

  if (buildOnly) {
    log.success("Build complete");
    return;
  }

  await executeContainer(config, projectPath, projectName, selectedStack, {
    ...options,
    projectImage: builtProjectImage,
  });
}

/**
 * Main run command.
 */
export async function run(
  stackName: string | null,
  buildOnly: boolean,
  path: string,
  options: {
    fresh?: boolean;
    ephemeralLogs?: boolean;
    depsMode?: string;
    debug?: number;
    prompt?: string;
    model?: string;
    quiet?: boolean;
    appendSystemPrompt?: string;
    unattended?: boolean;
    prune?: boolean;
    unrestricted?: boolean;
    verbose?: boolean;
    progress?: string;
    cache?: boolean;
    envVars?: string[];
    timeout?: number;
    buildTimeout?: number;
  } = {}
): Promise<void> {
  const {
    fresh = false,
    ephemeralLogs = false,
    depsMode,
    debug = 0,
    prompt,
    model,
    quiet = false,
    appendSystemPrompt,
    unattended = false,
    prune = true,
    unrestricted = false,
    verbose = false,
    progress = "auto",
    cache = true,
    envVars,
    timeout: _timeout,
    buildTimeout: _buildTimeout,
  } = options;

  // Note: timeout and buildTimeout are accepted but not yet passed through
  // to underlying operations. This is a placeholder for future implementation.
  // The CLI validation ensures they are valid values when provided.
  void _timeout;
  void _buildTimeout;

  if (!(await checkDocker())) {
    log.error(ERR_DOCKER_NOT_RUNNING);
    log.info("Start Docker and try again.");
    process.exit(1);
  }

  // Pre-run cleanup: remove stale resources
  if (prune) {
    await pruneStaleResources(debug > 0);
  }

  // Validate project path early
  const projectPath = validateProjectPath(path);
  const config = await setupGitConfig();
  const projectName = basename(projectPath);

  // Detect recommended stack first (no prompt yet)
  const detection = detectProjectType(projectPath, verbose);
  let initialStack: LanguageStack;
  if (stackName && stackName !== "auto") {
    initialStack = stackName as LanguageStack;
  } else {
    initialStack = detection.recommendedStack;
  }

  // Show detection details
  if (detection.detectedLanguages.length > 0) {
    if (verbose) {
      log.dim("Detection:");
      for (const det of detection.detectedLanguages) {
        log.dim(`  ${det.language.padEnd(12)} ${String(det.confidence).padStart(2)}  ${det.trigger}`);
      }
      log.dim(`  → Stack: ${initialStack}`);
    } else {
      const summary = detection.detectedLanguages
        .map((d) => `${d.language} (${d.confidence})`)
        .join(", ");
      log.dim(`Detection: ${summary} → ${initialStack}`);
    }
  } else if (verbose) {
    log.dim(`Detection: no languages found → ${initialStack}`);
  }

  // Phase 1: Try existing project image (skip prompts if found)
  if (
    await tryRunExistingImage(config, projectPath, projectName, initialStack, buildOnly, {
      fresh,
      ephemeralLogs,
      debug,
      prompt,
      model,
      quiet,
      appendSystemPrompt,
      unrestricted,
      envVars,
    })
  ) {
    return;
  }

  // Phase 2: No project image - prompt for deps, then stack

  // Detect dependencies
  const depsList = !fresh ? detectDependencies(projectPath) : [];
  let resolvedDepsMode: DepsMode = "skip";

  // Prompt for deps first (before stack selection)
  if (depsList.length > 0 && depsMode !== "skip") {
    if (depsMode) {
      // User specified deps mode via flag
      resolvedDepsMode = depsMode as DepsMode;
    } else {
      // Default: install all deps (including dev/test/lint tools)
      // This ensures format, test, lint tools are always available
      resolvedDepsMode = "all";
      if (!unattended) {
        log.dim("Installing all dependencies (including dev/test/lint tools)");
        log.dim("Use --deps-prod for production only, --no-deps to skip");
      }
    }
  }

  // Now resolve stack (with selection menu if needed)
  const selectedStack = await resolveStack(stackName, projectPath, {
    skipIfImageExists: true,
    unattended,
  });
  if (selectedStack === null) {
    log.warn("Cancelled.");
    process.exit(0);
  }

  // Phase 3: Build and run
  await buildAndRun(config, projectPath, projectName, selectedStack, depsList, resolvedDepsMode, buildOnly, {
    fresh,
    ephemeralLogs,
    debug,
    prompt,
    model,
    quiet,
    appendSystemPrompt,
    unrestricted,
    progress,
    cache,
    envVars,
  });
}
