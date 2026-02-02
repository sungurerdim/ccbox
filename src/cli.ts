#!/usr/bin/env bun
/**
 * CLI entry point for ccbox.
 *
 * Commander.js-based CLI with all commands and options.
 */

import { Command } from "commander";

import { style } from "./logger.js";

import { VERSION, MAX_PROMPT_LENGTH, MAX_SYSTEM_PROMPT_LENGTH, VALID_MODELS } from "./constants.js";
import { LanguageStack, STACK_INFO, filterStacks } from "./config.js";
import { ValidationError } from "./errors.js";
import { checkDocker, ERR_DOCKER_NOT_RUNNING } from "./utils.js";
import { run } from "./commands/run.js";
import { buildImage, getInstalledCcboxImages } from "./build.js";
import {
  removeCcboxContainers,
  removeCcboxImages,
  cleanTempFiles,
} from "./cleanup.js";
import { selfUpdate, selfUninstall, showVersion } from "./upgrade.js";

/**
 * Validate and normalize prompt parameter.
 */
function validatePrompt(prompt: string | undefined): string | undefined {
  if (!prompt) {return undefined;}
  const trimmed = prompt.trim();
  if (!trimmed) {
    throw new ValidationError("--prompt cannot be empty or whitespace-only");
  }
  if (trimmed.length > MAX_PROMPT_LENGTH) {
    throw new ValidationError(`--prompt must be ${MAX_PROMPT_LENGTH} characters or less`);
  }
  return trimmed;
}

/**
 * Validate and normalize append-system-prompt parameter.
 */
function validateSystemPrompt(prompt: string | undefined): string | undefined {
  if (!prompt) {return undefined;}
  const trimmed = prompt.trim();
  if (!trimmed) {
    throw new ValidationError("--append-system-prompt cannot be empty or whitespace-only");
  }
  if (trimmed.length > MAX_SYSTEM_PROMPT_LENGTH) {
    throw new ValidationError(
      `--append-system-prompt must be ${MAX_SYSTEM_PROMPT_LENGTH} characters or less`
    );
  }
  return trimmed;
}

/**
 * Validate model parameter (warns on unknown, doesn't block).
 */
function validateModel(model: string | undefined): string | undefined {
  if (model) {
    const modelLower = model.toLowerCase();
    if (!VALID_MODELS.has(modelLower)) {
      console.log(
        style.yellow(
          `Warning: Unknown model '${model}'. Known models: ${[...VALID_MODELS].sort().join(", ")}`
        )
      );
    }
  }
  return model;
}

// Build the CLI program
const program = new Command();

program
  .name("ccbox")
  .description("Run Claude Code in isolated Docker containers")
  .version(VERSION)
  .option("-y, --yes", "Unattended mode: auto-confirm all prompts")
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
  .option("-p, --prompt <prompt>", "Initial prompt (enables --print + --verbose)")
  .option("-m, --model <model>", "Model name (passed directly to Claude Code)")
  .option("-q, --quiet", "Quiet mode (enables --print, shows only responses)")
  .option("--append-system-prompt <prompt>", "Append custom instructions to Claude's system prompt")
  .option("-r, --resume [sessionId]", "Resume a previous session (optionally specify session ID)")
  .option("-c, --continue", "Continue the most recent session")
  .option("--no-prune", "Skip automatic cleanup of stale Docker resources")
  .option("-U, --unrestricted", "Remove CPU/priority limits (use full system resources)")
  .option("-v, --verbose", "Show detection details (which files triggered stack selection)")
  .option("--progress <mode>", "Docker build progress mode (auto|plain|tty)", "auto")
  .option("--no-cache", "Disable Docker build cache (default: cache enabled)")
  .option("-e, --env <KEY=VALUE...>", "Pass environment variables to container (can override defaults)", (value: string, prev: string[]) => {
    if (!value.includes('=') || value.startsWith('=')) {
      throw new ValidationError(`Invalid env format '${value}'. Expected KEY=VALUE`);
    }
    // Validate key: alphanumeric + underscore only (POSIX env var standard)
    const key = value.split('=')[0]!;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new ValidationError(`Invalid env var key '${key}'. Must be alphanumeric/underscore, starting with letter or underscore.`);
    }
    return [...(prev || []), value];
  })
  .action(async (options) => {
    // Change directory if --chdir/-C specified (like git -C)
    if (options.chdir) {
      process.chdir(options.chdir);
    }

    // Validate parameters
    try {
      options.prompt = validatePrompt(options.prompt);
      options.appendSystemPrompt = validateSystemPrompt(options.appendSystemPrompt);
      options.model = validateModel(options.model);
    } catch (e: unknown) {
      if (e instanceof ValidationError) {
        console.log(style.red(`Error: ${e.message}`));
        process.exit(1);
      }
      throw e;
    }

    // -dd requires -p (Claude Code needs input in non-interactive mode)
    if (options.debug >= 2 && !options.prompt) {
      console.log(style.red("Error: -dd requires -p <prompt>. Example: ccbox -dd -p \"fix the tests\""));
      process.exit(1);
    }

    // Determine deps mode from flags
    let depsMode: string | undefined = undefined;
    if (options.deps === true) {
      depsMode = "all";
    } else if (options.depsProd) {
      depsMode = "prod";
    } else if (options.deps === false) {
      depsMode = "skip";
    }

    await run(options.stack ?? null, !!options.build, options.path ?? ".", {
      fresh: options.fresh,
      ephemeralLogs: !options.debugLogs,
      depsMode,
      debug: options.debug,
      prompt: options.prompt,
      model: options.model,
      quiet: options.quiet,
      appendSystemPrompt: options.appendSystemPrompt,
      resume: options.resume,
      continueSession: options.continue,
      unattended: options.yes,
      prune: options.prune !== false,
      unrestricted: options.unrestricted,
      verbose: options.verbose,
      progress: options.progress,
      cache: options.cache,
      envVars: options.env,
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
      console.log(ERR_DOCKER_NOT_RUNNING);
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
      console.log(style.yellow("No images to rebuild."));
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
  .option("-f, --force", "Skip confirmation")
  .option("--deep", "Deep clean: also remove temp build files")
  .action(async (options) => {
    if (!(await checkDocker())) {
      console.log(ERR_DOCKER_NOT_RUNNING);
      process.exit(1);
    }

    const isDeep = !!options.deep;

    if (!options.force) {
      const { confirm } = await import("./prompt-io.js");
      if (isDeep) {
        console.log(style.yellow("This will remove ALL ccbox resources:"));
        console.log("  - All ccbox containers (running + stopped)");
        console.log("  - All ccbox images (stacks + project images)");
        console.log("  - Temporary build files (/tmp/ccbox)");
      } else {
        console.log(style.yellow("This will remove ccbox containers and images."));
      }
      console.log();
      const confirmed = await confirm({
        message: isDeep ? "Continue with deep clean?" : "Remove all ccbox containers and images?",
        default: false,
      });
      if (!confirmed) {
        console.log(style.dim("Cancelled."));
        return;
      }
    }

    console.log(style.dim("Removing containers..."));
    const containersRemoved = await removeCcboxContainers();

    console.log(style.dim("Removing images..."));
    const imagesRemoved = await removeCcboxImages();

    let tmpdirRemoved = 0;
    if (isDeep) {
      console.log(style.dim("Removing temp files..."));
      tmpdirRemoved = cleanTempFiles();
    }

    // Summary
    console.log();
    console.log(style.green(isDeep ? "Deep clean complete" : "Cleanup complete"));
    const parts: string[] = [];
    if (containersRemoved) {parts.push(`${containersRemoved} container(s)`);}
    if (imagesRemoved) {parts.push(`${imagesRemoved} image(s)`);}
    if (tmpdirRemoved) {parts.push("temp files");}
    if (parts.length > 0) {
      console.log(style.dim(`Removed: ${parts.join(", ")}`));
    } else {
      console.log(style.dim("Nothing to remove - already clean"));
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
      console.log(style.yellow(`No stacks found matching '${options.filter}'`));
      console.log(style.dim("Try: --filter=core, --filter=python, --filter=web"));
      return;
    }

    console.log(style.bold(options.filter ? `Stacks matching '${options.filter}'` : "Available Stacks"));
    console.log("----------------------------");

    for (const stack of stacks) {
      const { description, sizeMB } = STACK_INFO[stack];
      console.log(`  ${style.cyan(stack)}`);
      console.log(`    ${description} (~${sizeMB}MB)`);
    }

    console.log();
    console.log(style.dim("Usage: ccbox --stack=go"));
    console.log(style.dim("Filter categories: core, combined, usecase"));
  });

// Update command (self-update binary)
program
  .command("update")
  .description("Update ccbox to the latest version")
  .option("-f, --force", "Force re-download (skip version check and confirmation)")
  .action(async (options) => {
    await selfUpdate(!!options.force);
  });

// Uninstall command
program
  .command("uninstall")
  .description("Remove ccbox from this system")
  .option("-f, --force", "Skip confirmation")
  .action(async (options) => {
    await selfUninstall(!!options.force);
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
