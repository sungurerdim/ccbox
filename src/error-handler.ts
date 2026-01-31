/**
 * Unified error handling utilities for ccbox.
 *
 * Provides standardized error diagnosis, logging, and retry logic
 * for Docker operations and container failures.
 */

import { log } from "./logger.js";

/** Known Docker/container exit codes with their meanings and suggestions. */
export interface ExitCodeInfo {
  code: number;
  name: string;
  description: string;
  suggestion?: string;
  severity: "info" | "warn" | "error";
}

/** Exit code database for container failures. */
const EXIT_CODES: Record<number, ExitCodeInfo> = {
  0: {
    code: 0,
    name: "SUCCESS",
    description: "Container exited successfully",
    severity: "info",
  },
  1: {
    code: 1,
    name: "GENERAL_ERROR",
    description: "General error or command failure",
    suggestion: "Check container logs for details",
    severity: "error",
  },
  2: {
    code: 2,
    name: "MISUSE",
    description: "Shell builtin misuse or permission error",
    suggestion: "Check file permissions and command syntax",
    severity: "error",
  },
  126: {
    code: 126,
    name: "NOT_EXECUTABLE",
    description: "Command not executable",
    suggestion: "Check file permissions (chmod +x)",
    severity: "error",
  },
  127: {
    code: 127,
    name: "NOT_FOUND",
    description: "Command not found",
    suggestion: "Verify the command exists in container PATH",
    severity: "error",
  },
  128: {
    code: 128,
    name: "INVALID_EXIT",
    description: "Invalid exit argument",
    severity: "error",
  },
  130: {
    code: 130,
    name: "SIGINT",
    description: "Interrupted by Ctrl+C",
    severity: "info",
  },
  137: {
    code: 137,
    name: "OOM_KILLED",
    description: "Container was killed (OOM or manual stop)",
    suggestion: "Try: ccbox --unrestricted (removes memory limits)",
    severity: "warn",
  },
  139: {
    code: 139,
    name: "SEGFAULT",
    description: "Container crashed (segmentation fault)",
    suggestion: "Check for memory corruption or native code issues",
    severity: "error",
  },
  143: {
    code: 143,
    name: "SIGTERM",
    description: "Container terminated by signal",
    severity: "info",
  },
};

/**
 * Get information about an exit code.
 */
export function getExitCodeInfo(code: number): ExitCodeInfo {
  return (
    EXIT_CODES[code] ?? {
      code,
      name: "UNKNOWN",
      description: `Unknown exit code ${code}`,
      suggestion: "Check container logs for details",
      severity: "warn" as const,
    }
  );
}

/**
 * Check if an exit code indicates a transient/retryable failure.
 */
export function isRetryable(code: number): boolean {
  // Transient failures that might succeed on retry
  const retryableCodes = new Set([
    137, // OOM (might be temporary resource pressure)
    // Network-related would go here but container exit codes don't expose them directly
  ]);
  return retryableCodes.has(code);
}

/**
 * Check if an exit code indicates user-initiated termination (not an error).
 */
export function isUserTermination(code: number): boolean {
  return code === 130 || code === 143; // SIGINT (Ctrl+C) or SIGTERM
}

/**
 * Check if an exit code indicates success.
 */
export function isSuccess(code: number): boolean {
  return code === 0;
}

/**
 * Log an exit code with appropriate styling and suggestions.
 */
export function logExitCode(code: number, context?: string): void {
  const info = getExitCodeInfo(code);

  // Skip logging for user termination (normal exit)
  if (isUserTermination(code)) {
    log.dim(info.description);
    return;
  }

  // Skip success
  if (isSuccess(code)) {
    return;
  }

  // Format message with context
  const contextStr = context ? ` (${context})` : "";

  switch (info.severity) {
    case "error":
      log.error(`${info.description}${contextStr}`);
      break;
    case "warn":
      log.warn(`${info.description}${contextStr}`);
      break;
    default:
      log.dim(`${info.description}${contextStr}`);
  }

  if (info.suggestion) {
    log.dim(info.suggestion);
  }
}

/**
 * Log an error with context.
 *
 * @param error - The error object
 * @param operation - What operation was being performed
 * @param details - Additional context (optional)
 */
export function logError(
  error: unknown,
  operation: string,
  details?: Record<string, unknown>
): void {
  const message = error instanceof Error ? error.message : String(error);

  log.error(`Failed to ${operation}: ${message}`);

  if (details) {
    const SENSITIVE_KEY_PATTERN = /(password|secret|token|key|auth|credential)/i;
    const detailsStr = Object.entries(details)
      .filter(([k]) => !SENSITIVE_KEY_PATTERN.test(k))
      .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
      .join(", ");
    log.dim(`Context: ${detailsStr}`);
  }

  // Log stack trace in debug mode
  if (error instanceof Error && error.stack) {
    log.debug(error.stack);
  }
}

/** Type guard for execa-like error objects with stderr, exitCode, etc. */
function isExecaError(err: unknown): err is { stderr?: string; shortMessage?: string; message?: string; exitCode?: number } {
  return err instanceof Error || (typeof err === "object" && err !== null && ("stderr" in err || "exitCode" in err));
}

/**
 * Log Docker command error with extracted details.
 */
export function logDockerError(
  error: unknown,
  command: string,
  args: string[]
): void {
  const execaError = isExecaError(error) ? error : { message: String(error) };

  const exitCode = execaError.exitCode ?? 1;
  const cmdStr = `docker ${command} ${args.slice(0, 3).join(" ")}...`;

  log.error(`Docker command failed: ${cmdStr}`);

  if (exitCode !== 1) {
    logExitCode(exitCode, "docker");
  }

  // Extract meaningful error from stderr
  if (execaError.stderr) {
    const stderr = execaError.stderr.trim();
    const firstLine = stderr.split("\n")[0] ?? stderr;
    if (firstLine.length > 0 && firstLine.length < 200) {
      log.dim(`Error: ${firstLine}`);
    }
  } else if (execaError.shortMessage) {
    log.dim(`Error: ${execaError.shortMessage}`);
  }
}

