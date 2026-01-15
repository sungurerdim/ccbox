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
