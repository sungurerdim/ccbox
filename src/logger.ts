/**
 * Unified logging abstraction for ccbox.
 *
 * Centralizes all console output with consistent styling and log levels.
 * Uses picocolors for terminal styling.
 *
 * IMPORTANT: All ccbox output MUST go through this module.
 * Never use console.log/console.error directly in other modules.
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
  /** If true, suppress ALL output including errors */
  quiet: boolean;
}

/** Global logger configuration. */
const config: LoggerConfig = {
  level: LogLevel.INFO,
  prefix: false,
  quiet: false,
};

/** Original console references (saved before quiet mode). */
const originalConsole = {
  log: console.log.bind(console),
  error: console.error.bind(console),
  warn: console.warn.bind(console),
};

/**
 * Check if output is allowed at current level.
 */
function canOutput(level: LogLevel): boolean {
  return !config.quiet && config.level <= level;
}

/**
 * Enable quiet mode: suppress ALL output (stdout and stderr).
 * Only exit codes communicate success/failure.
 */
export function enableQuietMode(): void {
  config.quiet = true;
  config.level = LogLevel.SILENT;
  // Override all console methods
  console.log = () => {};
  console.error = () => {};
  console.warn = () => {};
}

/**
 * Disable quiet mode: restore normal output.
 */
export function disableQuietMode(): void {
  config.quiet = false;
  config.level = LogLevel.INFO;
  console.log = originalConsole.log;
  console.error = originalConsole.error;
  console.warn = originalConsole.warn;
}

/**
 * Check if quiet mode is enabled.
 */
export function isQuiet(): boolean {
  return config.quiet;
}

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
    if (canOutput(LogLevel.DEBUG)) {
      originalConsole.log(pc.dim(formatMessage(message)));
    }
  },

  /**
   * Info-level message (default level).
   * Styled: normal (no color)
   */
  info(message: string): void {
    if (canOutput(LogLevel.INFO)) {
      originalConsole.log(formatMessage(message));
    }
  },

  /**
   * Warning-level message.
   * Styled: yellow, outputs to stderr
   */
  warn(message: string): void {
    if (canOutput(LogLevel.WARN)) {
      originalConsole.warn(pc.yellow(formatMessage(message)));
    }
  },

  /**
   * Error-level message.
   * Styled: red, outputs to stderr
   */
  error(message: string): void {
    if (canOutput(LogLevel.ERROR)) {
      originalConsole.error(pc.red(formatMessage(message)));
    }
  },

  /**
   * Success message (info level).
   * Styled: green
   */
  success(message: string): void {
    if (canOutput(LogLevel.INFO)) {
      originalConsole.log(pc.green(formatMessage(message)));
    }
  },

  /**
   * Dim/subtle message (info level).
   * Styled: dim gray
   */
  dim(message: string): void {
    if (canOutput(LogLevel.INFO)) {
      originalConsole.log(pc.dim(formatMessage(message)));
    }
  },

  /**
   * Bold/emphasized message (info level).
   * Styled: bold
   */
  bold(message: string): void {
    if (canOutput(LogLevel.INFO)) {
      originalConsole.log(pc.bold(formatMessage(message)));
    }
  },

  /**
   * Cyan highlighted message (info level).
   * Styled: cyan
   */
  cyan(message: string): void {
    if (canOutput(LogLevel.INFO)) {
      originalConsole.log(pc.cyan(formatMessage(message)));
    }
  },

  /**
   * Blue highlighted message (info level).
   * Styled: blue
   */
  blue(message: string): void {
    if (canOutput(LogLevel.INFO)) {
      originalConsole.log(pc.blue(formatMessage(message)));
    }
  },

  /**
   * Yellow highlighted message (info level).
   * Styled: yellow
   */
  yellow(message: string): void {
    if (canOutput(LogLevel.INFO)) {
      originalConsole.log(pc.yellow(formatMessage(message)));
    }
  },

  /**
   * Green highlighted message (info level).
   * Styled: green
   */
  green(message: string): void {
    if (canOutput(LogLevel.INFO)) {
      originalConsole.log(pc.green(formatMessage(message)));
    }
  },

  /**
   * Red highlighted message (info level, not error).
   * Styled: red
   */
  red(message: string): void {
    if (canOutput(LogLevel.INFO)) {
      originalConsole.log(pc.red(formatMessage(message)));
    }
  },

  /**
   * Raw output without any styling (for complex chalk compositions).
   * Respects log level (info).
   */
  raw(message: string): void {
    if (canOutput(LogLevel.INFO)) {
      originalConsole.log(message);
    }
  },

  /**
   * Empty line (respects log level).
   */
  newline(): void {
    if (canOutput(LogLevel.INFO)) {
      originalConsole.log();
    }
  },

  /**
   * Write without newline (for progress indicators).
   */
  write(message: string): void {
    if (canOutput(LogLevel.INFO)) {
      process.stdout.write(message);
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
