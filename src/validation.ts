/**
 * Input validation utilities for ccbox.
 *
 * Centralized validation functions for environment variables and other inputs.
 *
 * Dependency direction:
 *   This module imports from: errors.ts
 *   It should NOT import from: cli, generator, docker-runtime
 */

import { ValidationError } from "./errors.js";

/** POSIX environment variable key pattern: [A-Za-z_][A-Za-z0-9_]* */
const ENV_VAR_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Validate an environment variable key.
 *
 * Checks that the key follows POSIX naming conventions:
 * - Starts with a letter or underscore
 * - Contains only alphanumeric characters and underscores
 *
 * @param key - Environment variable key to validate.
 * @returns True if valid.
 */
export function isValidEnvVarKey(key: string): boolean {
  return ENV_VAR_KEY_PATTERN.test(key);
}

/**
 * Validate environment variable key and throw if invalid.
 *
 * @param key - Environment variable key to validate.
 * @throws ValidationError if key is invalid.
 */
export function validateEnvVarKey(key: string): void {
  if (!isValidEnvVarKey(key)) {
    throw new ValidationError(
      `Invalid env var key '${key}'. Must be alphanumeric/underscore, starting with letter or underscore.`
    );
  }
}

/**
 * Sanitize environment variable value for safe shell usage.
 *
 * Removes characters that could enable injection attacks:
 * - Newlines (CR, LF)
 * - Null bytes
 *
 * @param value - Raw value to sanitize.
 * @returns Sanitized value safe for shell use.
 */
export function sanitizeEnvValue(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\r\n\x00]/g, "");
}

/**
 * Parse and validate a KEY=VALUE environment variable string.
 *
 * @param envVar - String in KEY=VALUE format.
 * @returns Parsed { key, value } or null if format is invalid.
 */
export function parseEnvVar(envVar: string): { key: string; value: string } | null {
  const eqIdx = envVar.indexOf("=");
  if (eqIdx <= 0) {
    return null; // No equals sign, or starts with equals
  }

  const key = envVar.slice(0, eqIdx);
  const value = envVar.slice(eqIdx + 1);

  if (!isValidEnvVarKey(key)) {
    return null;
  }

  return { key, value: sanitizeEnvValue(value) };
}

/**
 * Parse and validate environment variable, throwing on invalid format.
 *
 * @param envVar - String in KEY=VALUE format.
 * @throws ValidationError if format is invalid.
 * @returns Parsed { key, value }.
 */
export function parseEnvVarStrict(envVar: string): { key: string; value: string } {
  if (!envVar.includes("=") || envVar.startsWith("=")) {
    throw new ValidationError(`Invalid env format '${envVar}'. Expected KEY=VALUE`);
  }

  const key = envVar.split("=")[0]!;
  validateEnvVarKey(key);

  const value = envVar.slice(key.length + 1);
  return { key, value: sanitizeEnvValue(value) };
}
