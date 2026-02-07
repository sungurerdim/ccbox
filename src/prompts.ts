/**
 * User prompts and selection for ccbox.
 *
 * Handles interactive prompts for stack selection, dependency installation, etc.
 */

import { log, style } from "./logger.js";
import { input, confirm } from "./prompt-io.js";

import {
  createConfig,
  getImageName,
  getStackValues,
  imageExistsAsync,
  LanguageStack,
  parseStack,
  STACK_INFO,
  type Config,
} from "./config.js";
import { detectProjectType, type LanguageDetection } from "./detector.js";
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
  log.raw(style.cyanBold("Dependencies Detected"));
  log.newline();

  // Show detected package managers
  for (const deps of depsList) {
    const filesStr =
      deps.files.length > 3
        ? `${deps.files.slice(0, 3).join(", ")} (+${deps.files.length - 3} more)`
        : deps.files.join(", ");
    log.raw(`  ${style.cyan(deps.name)}: ${filesStr}`);
  }

  log.newline();

  // Check if any have dev dependencies
  const hasDev = depsList.some((d) => d.hasDev);

  if (hasDev) {
    log.bold("Install dependencies?");
    log.raw(`  ${style.cyan("1")}. All (including dev/test)`);
    log.raw(`  ${style.cyan("2")}. Production only`);
    log.raw(`  ${style.cyan("3")}. Skip`);
    log.newline();

    while (true) {
      const choice = await input({ message: "Select [1-3]", default: "1" });
      const validated = validateDepsChoice(choice, 3);
      if (validated === 1) {return "all";}
      if (validated === 2) {return "prod";}
      if (validated === 3) {return "skip";}
      log.red("Invalid choice. Try again.");
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
  detectedLanguages: LanguageDetection[]
): Promise<LanguageStack | null> {
  log.raw(style.blueBold("Stack Selection"));
  log.newline();

  if (detectedLanguages.length > 0) {
    const summary = detectedLanguages
      .map((d) => `${d.language} (${d.confidence})`)
      .join(", ");
    log.dim(`Detected: ${summary}`);
    log.newline();
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
  log.bold("Available stacks:");
  for (let idx = 0; idx < options.length; idx++) {
    const { name, isDetected } = options[idx]!;
    const { description, sizeMB } = STACK_INFO[name];
    const marker = isDetected ? style.green("->") + " " : "   ";
    const detectedLabel = isDetected ? style.green(" (detected)") : "";
    const installed = installedImages.has(getImageName(name))
      ? style.dim(" [installed]")
      : "";
    log.raw(`  ${marker}${style.cyan(String(idx + 1))}. ${name}${detectedLabel}${installed}`);
    log.raw(`      ${style.dim(`${description} (~${sizeMB}MB)`)}`);
  }

  log.newline();
  log.raw(`  ${style.dim("0")}. Cancel`);
  log.newline();

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
    log.red("Invalid choice. Try again.");
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
    log.dim(`Git config: ${name || "(none)"} <${email || "(none)"}>`);
  }

  return config;
}

/**
 * Resolve the stack to use based on user input or detection.
 *
 * Stack resolution follows this priority:
 * 1. Explicit stack via --stack flag (validates against LanguageStack enum)
 * 2. --stack=auto or --yes (unattended): use detected stack
 * 3. Interactive menu (if image doesn't exist or skipIfImageExists=false)
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

  // Explicit stack specified - validate and use it (takes priority over unattended)
  if (stackName && stackName !== "auto") {
    const validStack = parseStack(stackName);
    if (!validStack) {
      log.error(`Invalid stack: "${stackName}"`);
      log.dim(`Valid stacks: ${getStackValues().join(", ")}`);
      return null;
    }
    // Double-check stack is in LanguageStack enum (defensive validation)
    if (!Object.values(LanguageStack).includes(validStack)) {
      log.error(`Stack "${validStack}" not in LanguageStack enum`);
      return null;
    }
    return validStack;
  }

  // --stack=auto or unattended mode: use detected stack directly, no prompt
  if (stackName === "auto" || unattended) {
    return detection.recommendedStack;
  }

  // No --stack: interactive menu (or skip if image exists)
  if (skipIfImageExists && (await imageExistsAsync(detection.recommendedStack))) {
    return detection.recommendedStack;
  }

  return selectStack(detection.recommendedStack, detection.detectedLanguages);
}
