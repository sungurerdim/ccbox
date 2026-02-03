#!/usr/bin/env bun
/**
 * CLI entry point for ccbox.
 *
 * Commander.js-based CLI with all commands and options.
 */

import { Command } from "commander";

import { log, style, enableQuietMode } from "./logger.js";

import { VERSION } from "./constants.js";
import { LanguageStack, STACK_INFO, filterStacks } from "./config.js";
import { parseEnvVarStrict } from "./validation.js";
import { loadCcboxConfig, configEnvToArray } from "./config-file.js";
import { checkDocker, ERR_DOCKER_NOT_RUNNING } from "./utils.js";
import { run } from "./commands/run.js";
import { buildImage, getInstalledCcboxImages } from "./build.js";
import {
  removeCcboxContainers,
  removeCcboxImages,
  cleanTempFiles,
} from "./cleanup.js";
import { selfUpdate, selfUninstall, showVersion } from "./upgrade.js";

// Build the CLI program
const program = new Command();

program
  .name("ccbox")
  .description("Run Claude Code in isolated Docker containers")
  .version(VERSION)
  .option("-y, --yes", "Unattended mode: auto-confirm all prompts")
  .option("-q, --quiet", "Suppress all output (exit code only)")
  .hook("preAction", (thisCommand) => {
    // Apply quiet mode before any command runs
    const opts = thisCommand.opts();
    if (opts.quiet) {
      enableQuietMode();
    }
  })
  .option(
    "-s, --stack <stack>",
    "Language stack (auto=detect from project)",
    undefined
  )
  .option("-b, --build", "Build image only (no start)")
  .option("--path <path>", "Project path", ".")
  .option("-C, --chdir <dir>", "Change to directory before running (like git -C)")
  .option("--fresh", "Fresh mode: auth only, clean slate (no rules/settings/commands)")
  .option("--no-debug-logs", "Don't persist debug logs (use ephemeral tmpfs)")
  .option("--deps", "Install all dependencies including dev (default)")
  .option("--deps-prod", "Install production dependencies only")
  .option("--no-deps", "Skip dependency installation")
  .option("-d, --debug", "Debug mode (-d entrypoint logs, -dd + stream output)", (_, prev) => prev + 1, 0)
  .option("--headless", "Non-interactive/unattended mode (adds --print --output-format stream-json)")
  .option("--no-prune", "Skip automatic cleanup of stale Docker resources")
  .option("-U, --unrestricted", "Remove CPU/priority limits (use full system resources)")
  .option("--zero-residue", "Zero-trace mode: no cache, logs, or artifacts left behind")
  .option("--memory <limit>", "Container memory limit (e.g., 4g, 2048m)", "4g")
  .option("--cpus <limit>", "Container CPU limit (e.g., 2.0)", "2.0")
  .option("--network <policy>", "Network policy: full (default), isolated, or path to policy.json", "full")
  .option("-v, --verbose", "Show detection details (which files triggered stack selection)")
  .option("--progress <mode>", "Docker build progress mode (auto|plain|tty)", "auto")
  .option("--no-cache", "Disable Docker build cache (default: cache enabled)")
  .option("-e, --env <KEY=VALUE...>", "Pass environment variables to container (can override defaults)", (value: string, prev: string[]) => {
    // Validate format and key (throws ValidationError on invalid input)
    parseEnvVarStrict(value);
    return [...(prev || []), value];
  })
  .allowUnknownOption()
  .passThroughOptions()
  .action(async (options, command: Command) => {
    // Change directory if --chdir/-C specified (like git -C)
    if (options.chdir) {
      process.chdir(options.chdir);
    }

    const projectPath = options.path ?? ".";

    // Load config file (ccbox.yaml or .ccboxrc)
    const fileConfig = loadCcboxConfig(projectPath);

    // Collect all unknown/passthrough args for Claude CLI
    const claudeArgs = command.args;

    // Determine deps mode from flags (CLI > config file)
    let depsMode: string | undefined = undefined;
    if (options.deps === true) {
      depsMode = "all";
    } else if (options.depsProd) {
      depsMode = "prod";
    } else if (options.deps === false) {
      depsMode = "skip";
    } else if (fileConfig.deps) {
      depsMode = fileConfig.deps;
    }

    // Merge env vars: config file + CLI (CLI overrides)
    const configEnvVars = configEnvToArray(fileConfig);
    const mergedEnvVars = [...configEnvVars, ...(options.env || [])];

    await run(options.stack ?? fileConfig.stack ?? null, !!options.build, projectPath, {
      fresh: options.fresh ?? fileConfig.fresh,
      ephemeralLogs: !options.debugLogs,
      depsMode,
      debug: options.debug ?? fileConfig.debug,
      headless: options.headless ?? fileConfig.headless,
      unattended: options.yes,
      prune: options.prune !== false && fileConfig.prune !== false,
      unrestricted: options.unrestricted ?? fileConfig.unrestricted,
      verbose: options.verbose,
      progress: options.progress ?? fileConfig.progress,
      cache: options.cache ?? fileConfig.cache,
      envVars: mergedEnvVars.length > 0 ? mergedEnvVars : undefined,
      claudeArgs,
      // New options (CLI > config file)
      zeroResidue: options.zeroResidue ?? fileConfig.zeroResidue,
      memoryLimit: options.memory ?? fileConfig.memory,
      cpuLimit: options.cpus ?? fileConfig.cpus,
      networkPolicy: options.network ?? fileConfig.networkPolicy,
    });
  });

// Voice command (voice-to-text with whisper.cpp)
program
  .command("voice")
  .description("Voice-to-text: record, transcribe with whisper.cpp, send to container")
  .option("--model <model>", "Whisper model (tiny, base, small)", "base")
  .option("--duration <seconds>", "Max recording duration in seconds", "10")
  .option("-n, --name <container>", "Target container name (auto-detects if not specified)")
  .action(async (options) => {
    const { voicePipeline } = await import("./voice.js");
    const success = await voicePipeline({
      model: options.model,
      duration: parseInt(options.duration, 10),
      containerName: options.name,
    });
    if (!success) {
      process.exit(1);
    }
  });

// Paste command (clipboard image transfer to running container)
program
  .command("paste")
  .description("Paste clipboard image into running ccbox container")
  .option("-n, --name <container>", "Target container name (auto-detects if not specified)")
  .action(async (options) => {
    const { pasteToContainer } = await import("./clipboard.js");
    const success = await pasteToContainer(options.name);
    if (!success) {
      process.exit(1);
    }
  });

// Rebuild command (rebuild Docker images with latest Claude Code)
program
  .command("rebuild")
  .description("Rebuild Docker image(s) with latest Claude Code")
  .option("-s, --stack <stack>", "Stack to rebuild")
  .option("-a, --all", "Rebuild all installed images")
  .action(async (options) => {
    if (!(await checkDocker())) {
      log.error(ERR_DOCKER_NOT_RUNNING);
      process.exit(1);
    }

    const stacksToBuild: LanguageStack[] = [];

    if (options.stack) {
      stacksToBuild.push(options.stack as LanguageStack);
    } else if (options.all) {
      // Single Docker call to get all installed images (instead of N execSync calls)
      const installed = await getInstalledCcboxImages();
      for (const s of Object.values(LanguageStack)) {
        if (installed.has(`ccbox_${s}:latest`)) {
          stacksToBuild.push(s);
        }
      }
    } else {
      // Default: rebuild base (full refresh)
      stacksToBuild.push(LanguageStack.BASE);
    }

    if (stacksToBuild.length === 0) {
      log.yellow("No images to rebuild.");
      return;
    }

    for (const s of stacksToBuild) {
      await buildImage(s);
    }
  });

// Clean command (unified: default removes containers+images, --deep adds temp files, --system does docker system prune)
program
  .command("clean")
  .description("Remove ccbox containers, images, and temp files")
  .option("--deep", "Deep clean: also remove temp build files")
  .action(async (options, command: Command) => {
    if (!(await checkDocker())) {
      log.error(ERR_DOCKER_NOT_RUNNING);
      process.exit(1);
    }

    const isDeep = !!options.deep;
    const skipConfirm = command.parent?.opts().yes ?? false;

    if (!skipConfirm) {
      const { confirm } = await import("./prompt-io.js");
      if (isDeep) {
        log.yellow("This will remove ALL ccbox resources:");
        log.info("  - All ccbox containers (running + stopped)");
        log.info("  - All ccbox images (stacks + project images)");
        log.info("  - Temporary build files (/tmp/ccbox)");
      } else {
        log.yellow("This will remove ccbox containers and images.");
      }
      log.newline();
      const confirmed = await confirm({
        message: isDeep ? "Continue with deep clean?" : "Remove all ccbox containers and images?",
        default: false,
      });
      if (!confirmed) {
        log.dim("Cancelled.");
        return;
      }
    }

    log.dim("Removing containers...");
    const containersRemoved = await removeCcboxContainers();

    log.dim("Removing images...");
    const imagesRemoved = await removeCcboxImages();

    let tmpdirRemoved = 0;
    if (isDeep) {
      log.dim("Removing temp files...");
      tmpdirRemoved = cleanTempFiles();
    }

    // Summary
    log.newline();
    log.success(isDeep ? "Deep clean complete" : "Cleanup complete");
    const parts: string[] = [];
    if (containersRemoved) {parts.push(`${containersRemoved} container(s)`);}
    if (imagesRemoved) {parts.push(`${imagesRemoved} image(s)`);}
    if (tmpdirRemoved) {parts.push("temp files");}
    if (parts.length > 0) {
      log.dim(`Removed: ${parts.join(", ")}`);
    } else {
      log.dim("Nothing to remove - already clean");
    }
  });

// Stacks command
program
  .command("stacks")
  .description("List available language stacks")
  .option("-f, --filter <term>", "Filter by category (core/combined/usecase) or search term")
  .action((options: { filter?: string }) => {
    const stacks = options.filter
      ? filterStacks(options.filter)
      : Object.values(LanguageStack);

    if (stacks.length === 0) {
      log.yellow(`No stacks found matching '${options.filter}'`);
      log.dim("Try: --filter=core, --filter=python, --filter=web");
      return;
    }

    log.bold(options.filter ? `Stacks matching '${options.filter}'` : "Available Stacks");
    log.info("----------------------------");

    for (const stack of stacks) {
      const { description, sizeMB } = STACK_INFO[stack];
      log.raw(`  ${style.cyan(stack)}`);
      log.info(`    ${description} (~${sizeMB}MB)`);
    }

    log.newline();
    log.dim("Usage: ccbox --stack=go");
    log.dim("Filter categories: core, combined, usecase");
  });

// Update command (self-update binary)
program
  .command("update")
  .description("Update ccbox to the latest version")
  .option("--force", "Force re-download even if already up-to-date")
  .action(async (options, command: Command) => {
    const skipConfirm = command.parent?.opts().yes ?? false;
    await selfUpdate({ skipConfirm, forceReinstall: !!options.force });
  });

// Uninstall command
program
  .command("uninstall")
  .description("Remove ccbox from this system")
  .action(async (_options, command: Command) => {
    const skipConfirm = command.parent?.opts().yes ?? false;
    await selfUninstall(skipConfirm);
  });

// Version command
program
  .command("version")
  .description("Show version and check for updates")
  .option("-c, --check", "Check for updates")
  .action(async (options) => {
    await showVersion(!!options.check);
  });

// Parse and run (async for proper error handling in async actions)
program.parseAsync();
