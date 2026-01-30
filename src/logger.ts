/**
 * Unified logging abstraction for ccbox.
 *
 * Centralizes all console output with consistent styling and log levels.
 * Uses picocolors for terminal styling.
 */

import pc from "picocolors";

/** Log levels in order of verbosity (debug is most verbose). */
export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
  SILENT = 4,
}

/** Logger configuration. */
interface LoggerConfig {
  level: LogLevel;
  /** If true, prefix messages with [ccbox] */
  prefix: boolean;
}

/** Global logger configuration. */
const config: LoggerConfig = {
  level: LogLevel.INFO,
  prefix: false,
};

/**
 * Set the minimum log level. Messages below this level are suppressed.
 */
export function setLogLevel(level: LogLevel): void {
  config.level = level;
}

/**
 * Get the current log level.
 */
export function getLogLevel(): LogLevel {
  return config.level;
}

/**
 * Enable or disable the [ccbox] prefix on all messages.
 */
export function setPrefix(enabled: boolean): void {
  config.prefix = enabled;
}

/**
 * Format message with optional prefix.
 */
function formatMessage(message: string): string {
  return config.prefix ? `[ccbox] ${message}` : message;
}

/**
 * Logger object with level-aware methods.
 *
 * Usage:
 *   log.debug("verbose info")
 *   log.info("normal output")
 *   log.warn("warning message")
 *   log.error("error message")
 *   log.success("completed!")
 *   log.dim("subtle info")
 *   log.bold("emphasized")
 */
export const log = {
  /**
   * Debug-level message (shown only when level <= DEBUG).
   * Styled: dim gray
   */
  debug(message: string): void {
    if (config.level <= LogLevel.DEBUG) {
      console.log(pc.dim(formatMessage(message)));
    }
  },

  /**
   * Info-level message (default level).
   * Styled: normal (no color)
   */
  info(message: string): void {
    if (config.level <= LogLevel.INFO) {
      console.log(formatMessage(message));
    }
  },

  /**
   * Warning-level message.
   * Styled: yellow
   */
  warn(message: string): void {
    if (config.level <= LogLevel.WARN) {
      console.log(pc.yellow(formatMessage(message)));
    }
  },

  /**
   * Error-level message.
   * Styled: red
   */
  error(message: string): void {
    if (config.level <= LogLevel.ERROR) {
      console.log(pc.red(formatMessage(message)));
    }
  },

  /**
   * Success message (info level).
   * Styled: green
   */
  success(message: string): void {
    if (config.level <= LogLevel.INFO) {
      console.log(pc.green(formatMessage(message)));
    }
  },

  /**
   * Dim/subtle message (info level).
   * Styled: dim gray
   */
  dim(message: string): void {
    if (config.level <= LogLevel.INFO) {
      console.log(pc.dim(formatMessage(message)));
    }
  },

  /**
   * Bold/emphasized message (info level).
   * Styled: bold
   */
  bold(message: string): void {
    if (config.level <= LogLevel.INFO) {
      console.log(pc.bold(formatMessage(message)));
    }
  },

  /**
   * Cyan highlighted message (info level).
   * Styled: cyan
   */
  cyan(message: string): void {
    if (config.level <= LogLevel.INFO) {
      console.log(pc.cyan(formatMessage(message)));
    }
  },

  /**
   * Blue highlighted message (info level).
   * Styled: blue
   */
  blue(message: string): void {
    if (config.level <= LogLevel.INFO) {
      console.log(pc.blue(formatMessage(message)));
    }
  },

  /**
   * Raw output without any styling (for complex chalk compositions).
   * Respects log level (info).
   */
  raw(message: string): void {
    if (config.level <= LogLevel.INFO) {
      console.log(message);
    }
  },

  /**
   * Empty line (respects log level).
   */
  newline(): void {
    if (config.level <= LogLevel.INFO) {
      console.log();
    }
  },
};

/**
 * Styled string builders (for complex compositions).
 * These return styled strings without printing.
 *
 * Usage:
 *   log.raw(`${style.green("success")} - ${style.dim("details")}`)
 */
export const style = {
  dim: (text: string) => pc.dim(text),
  bold: (text: string) => pc.bold(text),
  red: (text: string) => pc.red(text),
  green: (text: string) => pc.green(text),
  yellow: (text: string) => pc.yellow(text),
  blue: (text: string) => pc.blue(text),
  cyan: (text: string) => pc.cyan(text),
  magenta: (text: string) => pc.magenta(text),
  // Combinations
  cyanBold: (text: string) => pc.bold(pc.cyan(text)),
  blueBold: (text: string) => pc.bold(pc.blue(text)),
  redBold: (text: string) => pc.bold(pc.red(text)),
  greenBold: (text: string) => pc.bold(pc.green(text)),
  yellowBold: (text: string) => pc.bold(pc.yellow(text)),
};
