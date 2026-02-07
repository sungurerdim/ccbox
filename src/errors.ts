/**
 * Unified exception hierarchy for ccbox.
 *
 * All custom exceptions inherit from CCBoxError for consistent error handling.
 * CLI catches these and converts to user-friendly messages.
 *
 * Dependency direction:
 *   This module has NO internal dependencies (leaf module).
 *   It may be imported by: all other ccbox modules.
 *   It should NOT import from any other ccbox modules.
 */

/**
 * Base exception for all ccbox errors.
 *
 * All ccbox-specific exceptions should inherit from this class.
 * This enables consistent error handling at the CLI layer.
 */
export class CCBoxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CCBoxError";
    Error.captureStackTrace?.(this, this.constructor);
  }
}

/**
 * Configuration-related errors.
 *
 * Examples:
 *   - Invalid configuration values
 *   - Missing required configuration
 *   - Configuration file parse errors
 */
export class ConfigError extends CCBoxError {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/**
 * Path validation and access errors.
 *
 * Examples:
 *   - Path traversal attempts
 *   - Symlink attacks
 *   - Path outside allowed boundaries
 *   - Invalid path format
 */
export class PathError extends CCBoxError {
  constructor(message: string) {
    super(message);
    this.name = "PathError";
  }
}

/**
 * Docker operation errors.
 *
 * Base class for all Docker-related exceptions.
 */
export class DockerError extends CCBoxError {
  constructor(message: string) {
    super(message);
    this.name = "DockerError";
  }
}

/** Raised when Docker is not installed or not in PATH. */
export class DockerNotFoundError extends DockerError {
  constructor(message = "Docker not found in PATH") {
    super(message);
    this.name = "DockerNotFoundError";
  }
}

/** Raised when a Docker operation times out. */
export class DockerTimeoutError extends DockerError {
  constructor(message = "Docker operation timed out") {
    super(message);
    this.name = "DockerTimeoutError";
  }
}

/** Raised when Docker daemon is not running. */
export class DockerNotRunningError extends DockerError {
  constructor(message = "Docker daemon is not running") {
    super(message);
    this.name = "DockerNotRunningError";
  }
}

/** Raised when Docker image build fails. */
export class ImageBuildError extends DockerError {
  constructor(message: string) {
    super(message);
    this.name = "ImageBuildError";
  }
}

/** Raised when container operations fail. */
export class ContainerError extends DockerError {
  constructor(message: string) {
    super(message);
    this.name = "ContainerError";
  }
}

/**
 * Dependency detection and resolution errors.
 *
 * Examples:
 *   - Unable to detect package manager
 *   - Conflicting dependencies
 *   - Missing required dependencies
 */
export class DependencyError extends CCBoxError {
  constructor(message: string) {
    super(message);
    this.name = "DependencyError";
  }
}

/**
 * Input validation errors.
 *
 * Examples:
 *   - Invalid prompt length
 *   - Invalid model name
 *   - Invalid stack name
 */
export class ValidationError extends CCBoxError {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

/**
 * Extract error details from an unknown error for user-friendly messages.
 *
 * Handles execa-style errors with stderr/shortMessage, plus standard Error objects.
 * Truncates output to maxLength to avoid overwhelming log output.
 *
 * @param error - Unknown error to extract details from.
 * @param maxLength - Maximum length of returned string (default: 1000).
 * @returns Human-readable error details.
 */
export function extractErrorDetails(error: unknown, maxLength = 1000): string {
  if (!(error instanceof Error)) {
    return String(error).slice(0, maxLength);
  }

  const execaError = error as { stderr?: string; shortMessage?: string };

  if (execaError.stderr) {
    return execaError.stderr.slice(0, maxLength);
  }
  if (execaError.shortMessage) {
    return execaError.shortMessage.slice(0, maxLength);
  }
  return error.message.slice(0, maxLength);
}

/**
 * Check if an error is a timeout error (execa-style).
 *
 * @param error - Unknown error to check.
 * @returns True if the error indicates a timeout.
 */
export function isTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const execaError = error as { timedOut?: boolean };
  return !!execaError.timedOut;
}
