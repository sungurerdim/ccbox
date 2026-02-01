/**
 * Run operations for ccbox.
 *
 * Handles container execution, diagnostics, and the main run workflow.
 */

import { exec, execInherit } from "../exec.js";
import {
  type Config,
  LanguageStack,
} from "../config.js";
import { DOCKER_COMMAND_TIMEOUT } from "../constants.js";
import type { DepsInfo, DepsMode } from "../deps.js";
import { detectDependencies } from "../deps.js";
import { checkDockerStatus } from "../docker.js";
import { getDockerRunCmd } from "../generator.js";
import { log } from "../logger.js";
import { getDockerEnv } from "../paths.js";
import {
  getProjectImageName,
  projectImageExists,
} from "../build.js";
import { pruneStaleResources } from "../cleanup.js";
import { resolveStack, setupGitConfig } from "../prompts.js";
import { checkDocker, ERR_DOCKER_NOT_RUNNING } from "../utils.js";
import { detectAndReportStack } from "./run-phases.js";
import { ensureBaseImage, ensureStackImage, buildProjectIfNeeded } from "./build-helpers.js";

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
  } catch (e) {
    log.debug(`Container status check error: ${String(e)}`);
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

  // Build phase: ensure base, stack, and project images are ready
  const buildOpts = { progress, cache };
  await ensureBaseImage(buildOpts);
  await ensureStackImage(selectedStack, buildOpts);
  const builtProjectImage = await buildProjectIfNeeded(
    projectPath, projectName, selectedStack, depsList, resolvedDepsMode, buildOpts
  );

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
  } = options;

  if (!(await checkDocker())) {
    log.error(ERR_DOCKER_NOT_RUNNING);
    log.info("Start Docker and try again.");
    process.exit(1);
  }

  // Pre-run cleanup: remove stale resources
  if (prune) {
    await pruneStaleResources(debug > 0);
  }

  // Phase 1: Detect project type and resolve initial stack
  const config = await setupGitConfig();
  const { projectPath, projectName, stack: initialStack } = detectAndReportStack(path, {
    stackName,
    verbose,
  });

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
