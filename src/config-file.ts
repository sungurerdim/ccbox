/**
 * Configuration file support for ccbox.
 *
 * Loads settings from ccbox.yaml or .ccboxrc files.
 * Supports both per-project and global configuration.
 *
 * Config file locations (in order of precedence):
 *   1. ./ccbox.yaml (project-specific)
 *   2. ./.ccboxrc (project-specific, alternative)
 *   3. ~/.ccbox/config.yaml (global)
 *
 * Dependency direction:
 *   This module imports from: constants.ts, errors.ts
 *   It should NOT import from: cli, generator, docker-runtime
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { log } from "./logger.js";

/**
 * ccbox configuration options.
 * All fields are optional - CLI flags take precedence.
 */
export interface CcboxConfig {
  // Stack selection
  stack?: string;

  // Dependencies
  deps?: "all" | "prod" | "skip";

  // Security
  zeroResidue?: boolean;
  networkPolicy?: "full" | "isolated" | string;

  // Resource limits
  memory?: string;
  cpus?: string;

  // Docker
  progress?: "auto" | "plain" | "tty";
  cache?: boolean;
  prune?: boolean;

  // Behavior
  fresh?: boolean;
  headless?: boolean;
  unrestricted?: boolean;
  debug?: number;

  // Environment variables
  env?: Record<string, string>;
}

/**
 * Config file search paths.
 */
const PROJECT_CONFIG_FILES = ["ccbox.yaml", "ccbox.yml", ".ccboxrc"];
const GLOBAL_CONFIG_PATH = join(homedir(), ".ccbox", "config.yaml");

/**
 * Parse YAML-like config (simple key: value format).
 * Supports basic YAML without external dependencies.
 */
function parseSimpleYaml(content: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = content.split("\n");
  let inEnvBlock = false;
  const envVars: Record<string, string> = {};

  for (const line of lines) {
    // Skip comments and empty lines
    const trimmed = line.trim();
    if (trimmed.startsWith("#") || trimmed === "") {
      continue;
    }

    // Check for env block
    if (trimmed === "env:") {
      inEnvBlock = true;
      continue;
    }

    // Handle env block entries (indented)
    if (inEnvBlock && line.startsWith("  ")) {
      const envMatch = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/);
      if (envMatch) {
        const [, key, value] = envMatch;
        if (key && value !== undefined) {
          envVars[key] = value.replace(/^["']|["']$/g, "");
        }
      }
      continue;
    } else if (inEnvBlock && !line.startsWith("  ")) {
      inEnvBlock = false;
      result.env = envVars;
    }

    // Parse key: value
    const match = trimmed.match(/^([a-zA-Z_][a-zA-Z0-9_-]*):\s*(.*)$/);
    if (match) {
      const [, key, value] = match;
      if (key && value !== undefined) {
        // Parse value types
        const cleanValue = value.replace(/^["']|["']$/g, "").trim();
        if (cleanValue === "true") {
          result[key] = true;
        } else if (cleanValue === "false") {
          result[key] = false;
        } else if (/^\d+$/.test(cleanValue)) {
          result[key] = parseInt(cleanValue, 10);
        } else if (/^\d+\.\d+$/.test(cleanValue)) {
          result[key] = parseFloat(cleanValue);
        } else if (cleanValue !== "") {
          result[key] = cleanValue;
        }
      }
    }
  }

  // Handle env block at end of file
  if (inEnvBlock && Object.keys(envVars).length > 0) {
    result.env = envVars;
  }

  return result;
}

/**
 * Load configuration from file.
 */
function loadConfigFile(path: string): CcboxConfig | null {
  if (!existsSync(path)) {
    return null;
  }

  try {
    const content = readFileSync(path, "utf-8");
    const parsed = parseSimpleYaml(content);

    // Map parsed values to CcboxConfig
    const config: CcboxConfig = {};

    if (typeof parsed.stack === "string") {config.stack = parsed.stack;}
    if (typeof parsed.deps === "string") {config.deps = parsed.deps as CcboxConfig["deps"];}
    if (typeof parsed.zeroResidue === "boolean") {config.zeroResidue = parsed.zeroResidue;}
    if (typeof parsed.networkPolicy === "string") {config.networkPolicy = parsed.networkPolicy as CcboxConfig["networkPolicy"];}
    if (typeof parsed.memory === "string") {config.memory = parsed.memory;}
    if (typeof parsed.cpus === "string") {config.cpus = parsed.cpus;}
    if (typeof parsed.progress === "string") {config.progress = parsed.progress as CcboxConfig["progress"];}
    if (typeof parsed.cache === "boolean") {config.cache = parsed.cache;}
    if (typeof parsed.prune === "boolean") {config.prune = parsed.prune;}
    if (typeof parsed.fresh === "boolean") {config.fresh = parsed.fresh;}
    if (typeof parsed.headless === "boolean") {config.headless = parsed.headless;}
    if (typeof parsed.unrestricted === "boolean") {config.unrestricted = parsed.unrestricted;}
    if (typeof parsed.debug === "number") {config.debug = parsed.debug;}
    if (parsed.env && typeof parsed.env === "object") {config.env = parsed.env as Record<string, string>;}

    return config;
  } catch (e) {
    log.debug(`Failed to parse config file ${path}: ${String(e)}`);
    return null;
  }
}

/**
 * Find and load project-specific config file.
 */
function loadProjectConfig(projectPath: string): CcboxConfig | null {
  for (const filename of PROJECT_CONFIG_FILES) {
    const configPath = join(projectPath, filename);
    const config = loadConfigFile(configPath);
    if (config) {
      log.debug(`Loaded project config: ${configPath}`);
      return config;
    }
  }
  return null;
}

/**
 * Load global config file.
 */
function loadGlobalConfig(): CcboxConfig | null {
  const config = loadConfigFile(GLOBAL_CONFIG_PATH);
  if (config) {
    log.debug(`Loaded global config: ${GLOBAL_CONFIG_PATH}`);
  }
  return config;
}

/**
 * Merge configurations with proper precedence.
 * Order: global < project < CLI flags
 */
function mergeConfigs(...configs: (CcboxConfig | null)[]): CcboxConfig {
  const result: CcboxConfig = {};

  for (const config of configs) {
    if (!config) {continue;}

    // Simple fields: later values override earlier
    if (config.stack !== undefined) {result.stack = config.stack;}
    if (config.deps !== undefined) {result.deps = config.deps;}
    if (config.zeroResidue !== undefined) {result.zeroResidue = config.zeroResidue;}
    if (config.networkPolicy !== undefined) {result.networkPolicy = config.networkPolicy;}
    if (config.memory !== undefined) {result.memory = config.memory;}
    if (config.cpus !== undefined) {result.cpus = config.cpus;}
    if (config.progress !== undefined) {result.progress = config.progress;}
    if (config.cache !== undefined) {result.cache = config.cache;}
    if (config.prune !== undefined) {result.prune = config.prune;}
    if (config.fresh !== undefined) {result.fresh = config.fresh;}
    if (config.headless !== undefined) {result.headless = config.headless;}
    if (config.unrestricted !== undefined) {result.unrestricted = config.unrestricted;}
    if (config.debug !== undefined) {result.debug = config.debug;}

    // Env vars: merge (later overrides same keys)
    if (config.env) {
      result.env = { ...(result.env || {}), ...config.env };
    }
  }

  return result;
}

/**
 * Load ccbox configuration.
 *
 * Loads and merges configuration from:
 *   1. Global config (~/.ccbox/config.yaml)
 *   2. Project config (./ccbox.yaml, ./.ccboxrc)
 *
 * CLI flags should be applied on top of the returned config.
 *
 * @param projectPath - Project directory path.
 * @returns Merged configuration.
 */
export function loadCcboxConfig(projectPath: string): CcboxConfig {
  const globalConfig = loadGlobalConfig();
  const projectConfig = loadProjectConfig(projectPath);

  return mergeConfigs(globalConfig, projectConfig);
}

/**
 * Convert CcboxConfig env to CLI-compatible string array.
 */
export function configEnvToArray(config: CcboxConfig): string[] {
  if (!config.env) {return [];}
  return Object.entries(config.env).map(([key, value]) => `${key}=${value}`);
}
