/**
 * Run operations for ccbox.
 *
 * Handles container execution, diagnostics, and the main run workflow.
 */

import { basename } from "node:path";

import chalk from "chalk";
import { execa, type Options as ExecaOptions } from "execa";

import {
  type Config,
  imageExists,
  LanguageStack,
} from "../config.js";
import { DOCKER_COMMAND_TIMEOUT } from "../constants.js";
import type { DepsInfo, DepsMode } from "../deps.js";
import { detectDependencies } from "../deps.js";
import { detectProjectType } from "../detector.js";
import { checkDockerStatus } from "../docker.js";
import { getDockerRunCmd } from "../generator.js";
import { getDockerEnv, validateProjectPath } from "../paths.js";
import {
  buildImage,
  buildProjectImage,
  ensureImageReady,
  getProjectImageName,
  projectImageExists,
} from "../build.js";
import { pruneStaleResources } from "../cleanup.js";
import { promptDeps, resolveStack, setupGitConfig } from "../prompts.js";
import { checkDocker, ERR_DOCKER_NOT_RUNNING } from "../utils.js";

/**
 * Diagnose container failure and provide actionable feedback.
 */
async function diagnoseContainerFailure(returncode: number, projectName: string): Promise<void> {
  // Known exit codes
  if (returncode === 137) {
    console.log(chalk.yellow("Container was killed (OOM or manual stop)"));
    console.log(chalk.dim("Try: ccbox --unrestricted (removes memory limits)"));
    return;
  }
  if (returncode === 139) {
    console.log(chalk.yellow("Container crashed (segmentation fault)"));
    return;
  }
  if (returncode === 143) {
    console.log(chalk.dim("Container terminated by signal"));
    return;
  }

  // Check Docker daemon health
  if (!(await checkDockerStatus())) {
    console.log(chalk.red("Docker daemon is not responding"));
    console.log(chalk.dim("Docker may have restarted or crashed during session"));
    return;
  }

  // Check for container still running (shouldn't happen with --rm)
  try {
    const result = await execa("docker", ["ps", "-q", "--filter", `name=ccbox-${projectName}`], {
      timeout: DOCKER_COMMAND_TIMEOUT,
      env: getDockerEnv(),
      reject: false,
      encoding: "utf8",
    } as ExecaOptions);

    if (String(result.stdout ?? "").trim()) {
      console.log(chalk.yellow("Container still running (cleanup failed)"));
      console.log(chalk.dim(`Run: docker rm -f ccbox-${projectName}`));
      return;
    }
  } catch {
    // Ignore errors
  }

  // Generic error with exit code
  if (returncode !== 0) {
    console.log(chalk.yellow(`Container exited with code ${returncode}`));
    console.log(chalk.dim("Run with --debug-logs to preserve logs for investigation"));
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
    bare?: boolean;
    debugLogs?: boolean;
    debug?: number;
    prompt?: string;
    model?: string;
    quiet?: boolean;
    appendSystemPrompt?: string;
    projectImage?: string;
    depsList?: DepsInfo[];
    unrestricted?: boolean;
    ephemeralTmp?: boolean;
  } = {}
): Promise<void> {
  const {
    bare = false,
    debugLogs = false,
    debug = 0,
    prompt,
    model,
    quiet = false,
    appendSystemPrompt,
    projectImage,
    depsList,
    unrestricted = false,
    ephemeralTmp = false,
  } = options;

  console.log(chalk.dim("Starting Claude Code..."));
  console.log();

  const cmd = getDockerRunCmd(config, projectPath, projectName, stack, {
    bare,
    debugLogs,
    debug,
    prompt,
    model,
    quiet,
    appendSystemPrompt,
    projectImage,
    depsList,
    unrestricted,
    ephemeralTmp,
  });

  // Stream mode (-dd): close stdin for watch-only (no user input)
  const stdin = debug >= 2 ? "ignore" : "inherit";

  let returncode = 0;
  try {
    // Note: Sleep inhibition is skipped in npm version (can be added later)
    const result = await execa("docker", cmd.slice(1), {
      stdio: [stdin, "inherit", "inherit"],
      env: getDockerEnv(),
      reject: false,
    } as ExecaOptions);
    returncode = result.exitCode ?? 0;
  } catch (error) {
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
    bare?: boolean;
    debugLogs?: boolean;
    debug?: number;
    prompt?: string;
    model?: string;
    quiet?: boolean;
    appendSystemPrompt?: string;
    unrestricted?: boolean;
    ephemeralTmp?: boolean;
  } = {}
): Promise<boolean> {
  if (!(await projectImageExists(projectName, stack))) {
    return false;
  }

  const projectImage = getProjectImageName(projectName, stack);
  console.log(chalk.dim(`Using existing project image: ${projectImage}`));

  console.log();
  console.log(chalk.blue(`[${chalk.bold(projectName)}] -> ${projectImage}`));

  if (buildOnly) {
    console.log(chalk.green("Build complete (image exists)"));
    return true;
  }

  // Detect deps for cache mounts (no prompt)
  const depsList = !options.bare ? detectDependencies(projectPath) : [];

  await executeContainer(config, projectPath, projectName, stack, {
    ...options,
    projectImage,
    depsList,
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
    bare?: boolean;
    debugLogs?: boolean;
    debug?: number;
    prompt?: string;
    model?: string;
    quiet?: boolean;
    appendSystemPrompt?: string;
    unrestricted?: boolean;
    ephemeralTmp?: boolean;
  } = {}
): Promise<void> {
  console.log();
  console.log(chalk.blue(`[${chalk.bold(projectName)}] -> ccbox/${selectedStack}`));

  // Ensure base image exists (required for all stacks)
  if (!imageExists(LanguageStack.BASE)) {
    console.log(chalk.bold("First-time setup: building base image..."));
    if (!(await buildImage(LanguageStack.BASE))) {
      process.exit(1);
    }
    console.log();
  }

  // Ensure stack image is ready
  if (!(await ensureImageReady(selectedStack, false))) {
    process.exit(1);
  }

  // Build project-specific image if deps requested
  let builtProjectImage: string | undefined = undefined;
  if (resolvedDepsMode !== "skip" && depsList.length > 0) {
    builtProjectImage = (await buildProjectImage(
      projectPath,
      projectName,
      selectedStack,
      depsList,
      resolvedDepsMode
    )) ?? undefined;
    if (!builtProjectImage) {
      console.log(chalk.yellow("Warning: Failed to build project image, continuing without deps"));
    }
  }

  if (buildOnly) {
    console.log(chalk.green("Build complete"));
    return;
  }

  await executeContainer(config, projectPath, projectName, selectedStack, {
    ...options,
    projectImage: builtProjectImage,
    depsList: resolvedDepsMode !== "skip" ? depsList : undefined,
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
    bare?: boolean;
    debugLogs?: boolean;
    depsMode?: string;
    debug?: number;
    prompt?: string;
    model?: string;
    quiet?: boolean;
    appendSystemPrompt?: string;
    unattended?: boolean;
    prune?: boolean;
    unrestricted?: boolean;
    ephemeralTmp?: boolean;
  } = {}
): Promise<void> {
  const {
    bare = false,
    debugLogs = false,
    depsMode,
    debug = 0,
    prompt,
    model,
    quiet = false,
    appendSystemPrompt,
    unattended = false,
    prune = true,
    unrestricted = false,
    ephemeralTmp = false,
  } = options;

  if (!(await checkDocker())) {
    console.log(ERR_DOCKER_NOT_RUNNING);
    console.log("Start Docker and try again.");
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
  const detection = detectProjectType(projectPath);
  let initialStack: LanguageStack;
  if (stackName && stackName !== "auto") {
    initialStack = stackName as LanguageStack;
  } else {
    initialStack = detection.recommendedStack;
  }

  // Phase 1: Try existing project image (skip prompts if found)
  if (
    await tryRunExistingImage(config, projectPath, projectName, initialStack, buildOnly, {
      bare,
      debugLogs,
      debug,
      prompt,
      model,
      quiet,
      appendSystemPrompt,
      unrestricted,
      ephemeralTmp,
    })
  ) {
    return;
  }

  // Phase 2: No project image - prompt for deps, then stack

  // Detect dependencies
  const depsList = !bare ? detectDependencies(projectPath) : [];
  let resolvedDepsMode: DepsMode = "skip";

  // Prompt for deps first (before stack selection)
  if (depsList.length > 0 && depsMode !== "skip") {
    if (depsMode) {
      // User specified deps mode via flag
      resolvedDepsMode = depsMode as DepsMode;
    } else if (unattended) {
      // Unattended mode (-y): install all deps without prompting
      resolvedDepsMode = "all";
      console.log(chalk.dim("Unattended mode: installing all dependencies"));
    } else {
      // Interactive prompt
      resolvedDepsMode = await promptDeps(depsList);
      console.log();
    }
  }

  // Now resolve stack (with selection menu if needed)
  const selectedStack = await resolveStack(stackName, projectPath, {
    skipIfImageExists: true,
    unattended,
  });
  if (selectedStack === null) {
    console.log(chalk.yellow("Cancelled."));
    process.exit(0);
  }

  // Phase 3: Build and run
  await buildAndRun(config, projectPath, projectName, selectedStack, depsList, resolvedDepsMode, buildOnly, {
    bare,
    debugLogs,
    debug,
    prompt,
    model,
    quiet,
    appendSystemPrompt,
    unrestricted,
    ephemeralTmp,
  });
}
