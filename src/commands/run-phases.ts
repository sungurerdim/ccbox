/**
 * Run command phase extraction for ccbox.
 *
 * Phase 1: Project detection, reporting, and stack filtering.
 * Extracted from commands/run.ts to reduce function size and improve testability.
 */

import { basename } from "node:path";

import { LanguageStack } from "../config.js";
import { detectProjectType } from "../detector.js";
import { log } from "../logger.js";
import { validateProjectPath } from "../paths.js";

/** Result of Phase 1: detection and stack resolution. */
export interface DetectionResult {
  readonly projectPath: string;
  readonly projectName: string;
  readonly detected: ReturnType<typeof detectProjectType>;
  readonly stack: LanguageStack;
}

/**
 * Phase 1: Detect project type, report findings, and resolve initial stack.
 *
 * Validates the project path, runs language detection, logs results,
 * and determines the initial stack (from CLI flag or auto-detection).
 */
export function detectAndReportStack(
  path: string,
  options: {
    stackName: string | null;
    verbose?: boolean;
  }
): DetectionResult {
  const projectPath = validateProjectPath(path);
  const projectName = basename(projectPath);

  const detected = detectProjectType(projectPath, options.verbose ?? false);

  let stack: LanguageStack;
  if (options.stackName && options.stackName !== "auto") {
    stack = options.stackName as LanguageStack;
  } else {
    stack = detected.recommendedStack;
  }

  // Report detection results
  if (detected.detectedLanguages.length > 0) {
    if (options.verbose) {
      log.dim("Detection:");
      for (const det of detected.detectedLanguages) {
        log.dim(`  ${det.language.padEnd(12)} ${String(det.confidence).padStart(2)}  ${det.trigger}`);
      }
      log.dim(`  → Stack: ${stack}`);
    } else {
      const summary = detected.detectedLanguages
        .map((d) => `${d.language} (${d.confidence})`)
        .join(", ");
      log.dim(`Detection: ${summary} → ${stack}`);
    }
  } else if (options.verbose) {
    log.dim(`Detection: no languages found → ${stack}`);
  }

  return { projectPath, projectName, detected, stack };
}
