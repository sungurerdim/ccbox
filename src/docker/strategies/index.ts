/**
 * Docker execution strategy pattern for ccbox.
 *
 * Each strategy encapsulates the logic for a specific execution mode,
 * reducing cyclomatic complexity in getDockerRunCmd().
 */

import type { Config } from "../../config.js";
import type { LanguageStack } from "../../config.js";

/** Options passed to execution strategies. */
export interface StrategyOptions {
  fresh?: boolean;
  ephemeralLogs?: boolean;
  debug?: number;
  prompt?: string;
  model?: string;
  quiet?: boolean;
  appendSystemPrompt?: string;
  projectImage?: string;
  unrestricted?: boolean;
  envVars?: string[];
}

/** Interface for Docker execution strategies. */
export interface ExecutionStrategy {
  /** Apply strategy-specific modifications to the docker run command. */
  apply(cmd: string[], config: Config, stack: LanguageStack, options: StrategyOptions): void;
}

/**
 * FreshModeStrategy: Handles --fresh flag.
 * Uses minimal mounts (auth only, no plugins/rules/commands).
 */
export class FreshModeStrategy implements ExecutionStrategy {
  apply(_cmd: string[], _config: Config, _stack: LanguageStack, _options: StrategyOptions): void {
    // Fresh mode signals are handled by the mount logic in docker-runtime.ts
    // This strategy is a marker that activates minimal mount path
  }

  static shouldActivate(options: StrategyOptions): boolean {
    return options.fresh === true;
  }
}

/**
 * DebugModeStrategy: Handles --debug flag.
 * Sets debug environment variables and adjusts stdin behavior.
 */
export class DebugModeStrategy implements ExecutionStrategy {
  apply(cmd: string[], _config: Config, _stack: LanguageStack, options: StrategyOptions): void {
    const debugLevel = options.debug ?? 0;
    if (debugLevel > 0) {
      cmd.push("-e", `CCBOX_DEBUG=${debugLevel}`);
    }
  }

  static shouldActivate(options: StrategyOptions): boolean {
    return (options.debug ?? 0) > 0;
  }
}

/**
 * RestrictedModeStrategy: Handles default resource restrictions.
 * Applied when --unrestricted is NOT set.
 */
export class RestrictedModeStrategy implements ExecutionStrategy {
  apply(cmd: string[]): void {
    cmd.push("--cpu-shares=512");
  }

  static shouldActivate(options: StrategyOptions): boolean {
    return !options.unrestricted;
  }
}

/**
 * UnrestrictedModeStrategy: Handles --unrestricted flag.
 * Removes CPU/priority limits and sets environment signal.
 */
export class UnrestrictedModeStrategy implements ExecutionStrategy {
  apply(cmd: string[]): void {
    cmd.push("-e", "CCBOX_UNRESTRICTED=1");
  }

  static shouldActivate(options: StrategyOptions): boolean {
    return options.unrestricted === true;
  }
}

/**
 * Select and return all applicable strategies for the given options.
 */
export function selectStrategies(options: StrategyOptions): ExecutionStrategy[] {
  const strategies: ExecutionStrategy[] = [];

  if (FreshModeStrategy.shouldActivate(options)) {
    strategies.push(new FreshModeStrategy());
  }
  if (DebugModeStrategy.shouldActivate(options)) {
    strategies.push(new DebugModeStrategy());
  }
  if (RestrictedModeStrategy.shouldActivate(options)) {
    strategies.push(new RestrictedModeStrategy());
  }
  if (UnrestrictedModeStrategy.shouldActivate(options)) {
    strategies.push(new UnrestrictedModeStrategy());
  }

  return strategies;
}
