/**
 * User prompts and selection for ccbox.
 *
 * Handles interactive prompts for stack selection, dependency installation, etc.
 */

import chalk from "chalk";
import { input, confirm } from "@inquirer/prompts";

import {
  createConfig,
  getImageName,
  imageExists,
  LanguageStack,
  STACK_INFO,
  type Config,
} from "./config.js";
import { detectProjectType } from "./detector.js";
import type { DepsInfo, DepsMode } from "./deps.js";
import { getInstalledCcboxImages } from "./build.js";
import { getGitConfig } from "./utils.js";

/**
 * Validate user's dependency installation choice.
 */
function validateDepsChoice(choice: string, maxOption: number): number | null {
  const choiceInt = parseInt(choice, 10);
  if (!isNaN(choiceInt) && choiceInt >= 1 && choiceInt <= maxOption) {
    return choiceInt;
  }
  return null;
}

/**
 * Prompt user for dependency installation preference.
 */
export async function promptDeps(depsList: DepsInfo[]): Promise<DepsMode> {
  console.log(chalk.cyan.bold("Dependencies Detected"));
  console.log();

  // Show detected package managers
  for (const deps of depsList) {
    const filesStr =
      deps.files.length > 3
        ? `${deps.files.slice(0, 3).join(", ")} (+${deps.files.length - 3} more)`
        : deps.files.join(", ");
    console.log(`  ${chalk.cyan(deps.name)}: ${filesStr}`);
  }

  console.log();

  // Check if any have dev dependencies
  const hasDev = depsList.some((d) => d.hasDev);

  if (hasDev) {
    console.log(chalk.bold("Install dependencies?"));
    console.log(`  ${chalk.cyan("1")}. All (including dev/test)`);
    console.log(`  ${chalk.cyan("2")}. Production only`);
    console.log(`  ${chalk.cyan("3")}. Skip`);
    console.log();

    while (true) {
      const choice = await input({ message: "Select [1-3]", default: "1" });
      const validated = validateDepsChoice(choice, 3);
      if (validated === 1) {return "all";}
      if (validated === 2) {return "prod";}
      if (validated === 3) {return "skip";}
      console.log(chalk.red("Invalid choice. Try again."));
    }
  } else {
    // No dev distinction - just ask yes/no
    const installDeps = await confirm({ message: "Install dependencies?", default: true });
    return installDeps ? "all" : "skip";
  }
}

/**
 * Show interactive stack selection menu.
 */
export async function selectStack(
  detectedStack: LanguageStack,
  detectedLanguages: string[]
): Promise<LanguageStack | null> {
  console.log(chalk.blue.bold("Stack Selection"));
  console.log();

  if (detectedLanguages.length > 0) {
    console.log(chalk.dim(`Detected languages: ${detectedLanguages.join(", ")}`));
    console.log();
  }

  // Build options list
  const options: { name: LanguageStack; label: string; isDetected: boolean }[] = [];
  for (const stack of Object.values(LanguageStack)) {
    const isDetected = stack === detectedStack;
    options.push({ name: stack, label: stack, isDetected });
  }

  // Get all installed images in a single Docker call (avoid N+1 queries)
  const installedImages = await getInstalledCcboxImages();

  // Display options
  console.log(chalk.bold("Available stacks:"));
  for (let idx = 0; idx < options.length; idx++) {
    const { name, isDetected } = options[idx]!;
    const { description, sizeMB } = STACK_INFO[name];
    const marker = isDetected ? chalk.green("->") + " " : "   ";
    const detectedLabel = isDetected ? chalk.green(" (detected)") : "";
    const installed = installedImages.has(getImageName(name))
      ? chalk.dim(" [installed]")
      : "";
    console.log(`  ${marker}${chalk.cyan(idx + 1)}. ${name}${detectedLabel}${installed}`);
    console.log(`      ${chalk.dim(`${description} (~${sizeMB}MB)`)}`);
  }

  console.log();
  console.log(`  ${chalk.dim("0")}. Cancel`);
  console.log();

  // Get user choice
  const defaultIdx = options.findIndex((o) => o.name === detectedStack) + 1;

  while (true) {
    const choice = await input({
      message: `Select stack [1-${options.length}, 0 to cancel]`,
      default: String(defaultIdx),
    });

    const choiceInt = parseInt(choice, 10);
    if (choiceInt === 0) {
      return null;
    }
    if (choiceInt >= 1 && choiceInt <= options.length) {
      return options[choiceInt - 1]!.name;
    }
    console.log(chalk.red("Invalid choice. Try again."));
  }
}

/**
 * Create config with git settings from host.
 */
export async function setupGitConfig(): Promise<Config> {
  const config = createConfig();
  const [name, email] = await getGitConfig();

  if (name) {
    config.gitName = name;
  }
  if (email) {
    config.gitEmail = email;
  }

  if (name || email) {
    console.log(chalk.dim(`Git config: ${name || "(none)"} <${email || "(none)"}>`));
  }

  return config;
}

/**
 * Resolve the stack to use based on user input or detection.
 */
export async function resolveStack(
  stackName: string | null,
  projectPath: string,
  options: {
    skipIfImageExists?: boolean;
    unattended?: boolean;
  } = {}
): Promise<LanguageStack | null> {
  const { skipIfImageExists = false, unattended = false } = options;

  const detection = detectProjectType(projectPath);

  // --stack=auto or unattended mode: use detected stack directly, no prompt
  if (stackName === "auto" || unattended) {
    return detection.recommendedStack;
  }

  // Explicit stack specified
  if (stackName) {
    return stackName as LanguageStack;
  }

  // No --stack: interactive menu (or skip if image exists)
  if (skipIfImageExists && imageExists(detection.recommendedStack)) {
    return detection.recommendedStack;
  }

  return selectStack(detection.recommendedStack, detection.detectedLanguages);
}
