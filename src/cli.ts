#!/usr/bin/env node
/**
 * CLI entry point for ccbox.
 *
 * Commander.js-based CLI with all commands and options.
 */

import chalk from "chalk";
import { Command } from "commander";

import { VERSION, MAX_PROMPT_LENGTH, MAX_SYSTEM_PROMPT_LENGTH, VALID_MODELS } from "./constants.js";
import { LanguageStack, STACK_INFO, imageExists } from "./config.js";
import { ValidationError } from "./errors.js";
import { checkDocker, ERR_DOCKER_NOT_RUNNING } from "./utils.js";
import { run } from "./commands/run.js";
import { buildImage } from "./build.js";
import {
  removeCcboxContainers,
  removeCcboxImages,
  pruneSystem,
  cleanTempFiles,
} from "./cleanup.js";

/**
 * Validate and normalize prompt parameter.
 */
function validatePrompt(prompt: string | undefined): string | undefined {
  if (!prompt) return undefined;
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
  if (!prompt) return undefined;
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
        chalk.yellow(
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
  .option("--bare", "Vanilla mode: auth only, no CCO/settings/rules")
  .option("--debug-logs", "Persist debug logs (default: ephemeral tmpfs)")
  .option("--deps", "Install all dependencies (including dev)")
  .option("--deps-prod", "Install production dependencies only")
  .option("--no-deps", "Skip dependency installation")
  .option("-d, --debug", "Debug mode (-d entrypoint logs, -dd + stream output)", (_, prev) => prev + 1, 0)
  .option("-p, --prompt <prompt>", "Initial prompt (enables --print + --verbose)")
  .option("-m, --model <model>", "Model name (passed directly to Claude Code)")
  .option("-q, --quiet", "Quiet mode (enables --print, shows only responses)")
  .option("--append-system-prompt <prompt>", "Append custom instructions to Claude's system prompt")
  .option("--no-prune", "Skip automatic cleanup of stale Docker resources")
  .option("-U, --unrestricted", "Remove CPU/priority limits (use full system resources)")
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
    } catch (e) {
      if (e instanceof ValidationError) {
        console.log(chalk.red(`Error: ${e.message}`));
        process.exit(1);
      }
      throw e;
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
      bare: options.bare,
      debugLogs: options.debugLogs,
      depsMode,
      debug: options.debug,
      prompt: options.prompt,
      model: options.model,
      quiet: options.quiet,
      appendSystemPrompt: options.appendSystemPrompt,
      unattended: options.yes,
      prune: options.prune !== false,
      unrestricted: options.unrestricted,
    });
  });

// Update command
program
  .command("update")
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
      for (const s of Object.values(LanguageStack)) {
        if (imageExists(s)) {
          stacksToBuild.push(s);
        }
      }
    } else {
      // Default: rebuild minimal + base (full refresh)
      stacksToBuild.push(LanguageStack.MINIMAL, LanguageStack.BASE);
    }

    if (stacksToBuild.length === 0) {
      console.log(chalk.yellow("No images to update."));
      return;
    }

    for (const s of stacksToBuild) {
      await buildImage(s);
    }
  });

// Clean command
program
  .command("clean")
  .description("Remove ccbox containers and images")
  .option("-f, --force", "Skip confirmation")
  .action(async (options) => {
    if (!(await checkDocker())) {
      console.log(ERR_DOCKER_NOT_RUNNING);
      process.exit(1);
    }

    if (!options.force) {
      const { confirm } = await import("@inquirer/prompts");
      const confirmed = await confirm({
        message: "Remove all ccbox containers and images?",
        default: false,
      });
      if (!confirmed) return;
    }

    console.log(chalk.dim("Removing containers..."));
    const containersRemoved = await removeCcboxContainers();

    console.log(chalk.dim("Removing images..."));
    const imagesRemoved = await removeCcboxImages();

    console.log(chalk.green("Cleanup complete"));
    if (containersRemoved || imagesRemoved) {
      const parts: string[] = [];
      if (containersRemoved) parts.push(`${containersRemoved} container(s)`);
      if (imagesRemoved) parts.push(`${imagesRemoved} image(s)`);
      console.log(chalk.dim(`Removed: ${parts.join(", ")}`));
    }
  });

// Prune command
program
  .command("prune")
  .description("Deep clean: remove ccbox or entire Docker system resources")
  .option("-f, --force", "Skip confirmation")
  .option("--system", "Clean entire Docker system (all unused containers, images, volumes, cache)")
  .action(async (options) => {
    if (!(await checkDocker())) {
      console.log(ERR_DOCKER_NOT_RUNNING);
      process.exit(1);
    }

    if (options.system) {
      await pruneSystem();
      return;
    }

    if (!options.force) {
      const { confirm } = await import("@inquirer/prompts");
      console.log(chalk.yellow("This will remove ALL ccbox resources:"));
      console.log("  - All ccbox containers (running + stopped)");
      console.log("  - All ccbox images (stacks + project images)");
      console.log("  - Temporary build files (/tmp/ccbox)");
      console.log();
      const confirmed = await confirm({
        message: "Continue with deep clean?",
        default: false,
      });
      if (!confirmed) {
        console.log(chalk.dim("Cancelled."));
        return;
      }
    }

    // 1. Stop and remove ALL ccbox containers (including running ones)
    console.log(chalk.dim("Removing containers..."));
    const containersRemoved = await removeCcboxContainers();

    // 2. Remove ALL ccbox images (stacks + project images)
    console.log(chalk.dim("Removing images..."));
    const imagesRemoved = await removeCcboxImages();

    // 3. Clean up ccbox build directory
    console.log(chalk.dim("Removing temp files..."));
    const tmpdirRemoved = cleanTempFiles();

    // Summary
    console.log();
    console.log(chalk.green("Deep clean complete"));
    const parts: string[] = [];
    if (containersRemoved) parts.push(`${containersRemoved} container(s)`);
    if (imagesRemoved) parts.push(`${imagesRemoved} image(s)`);
    if (tmpdirRemoved) parts.push("temp files");
    if (parts.length > 0) {
      console.log(chalk.dim(`Removed: ${parts.join(", ")}`));
    } else {
      console.log(chalk.dim("Nothing to remove - already clean"));
    }
  });

// Stacks command
program
  .command("stacks")
  .description("List available language stacks")
  .action(() => {
    console.log(chalk.bold("Available Stacks"));
    console.log("----------------------------");

    for (const stack of Object.values(LanguageStack)) {
      const { description, sizeMB } = STACK_INFO[stack];
      console.log(`  ${chalk.cyan(stack)}`);
      console.log(`    ${description} (~${sizeMB}MB)`);
    }

    console.log();
    console.log(chalk.dim("Usage: ccbox --stack=go"));
    console.log(chalk.dim("All stacks include: Python + Node.js + lint/test tools"));
    console.log(chalk.dim("All except 'minimal' include CCO plugin (installed at runtime)"));
  });

// Parse and run
program.parse();
