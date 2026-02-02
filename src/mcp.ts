/**
 * MCP (Model Context Protocol) server configuration support for ccbox.
 *
 * Handles MCP config files that contain host paths needing translation
 * for container execution. MCP configs live in:
 *   - ~/.claude.json (user-scope MCP servers + permissions)
 *   - .mcp.json (project-scope MCP servers)
 *
 * Path translation is handled by FUSE (on Windows/WSL) or natively (macOS/Linux).
 * This module provides validation and diagnostic helpers.
 *
 * Dependency direction:
 *   This module has minimal internal dependencies.
 *   It may be imported by: docker-runtime.ts, commands/run.ts
 *   It should NOT import from: cli, generator
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { log } from "./logger.js";

/** MCP server entry from .claude.json or .mcp.json. */
interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/** Parsed MCP configuration. */
interface McpConfig {
  mcpServers?: Record<string, McpServerConfig>;
}

/**
 * Check if project has MCP server configuration.
 *
 * @param projectPath - Path to the project directory.
 * @returns True if .mcp.json exists in the project.
 */
export function hasProjectMcpConfig(projectPath: string): boolean {
  return existsSync(join(projectPath, ".mcp.json"));
}

/**
 * Validate MCP server commands are available in the container.
 *
 * Known container-available commands:
 * - npx, node (Node.js stack or base image)
 * - uvx, python3, pip (Python stack or base image)
 * - bunx, bun (base image)
 *
 * @param configPath - Path to MCP config file.
 * @returns List of warnings for unavailable commands.
 */
export function validateMcpCommands(configPath: string): string[] {
  const warnings: string[] = [];

  if (!existsSync(configPath)) {
    return warnings;
  }

  try {
    const content = readFileSync(configPath, "utf-8");
    const config: McpConfig = JSON.parse(content);

    if (!config.mcpServers) {
      return warnings;
    }

    // Commands known to be available in ccbox containers
    const knownCommands = new Set([
      "npx", "node", "npm",
      "uvx", "python3", "python", "pip", "pip3",
      "bun", "bunx",
      "bash", "sh",
    ]);

    for (const [name, server] of Object.entries(config.mcpServers)) {
      const cmd = server.command;
      if (cmd && !knownCommands.has(cmd)) {
        warnings.push(`MCP server "${name}" uses command "${cmd}" which may not be available in the container`);
      }
    }
  } catch (e) {
    log.debug(`Failed to parse MCP config ${configPath}: ${String(e)}`);
  }

  return warnings;
}

/**
 * Log MCP configuration status for debugging.
 *
 * @param projectPath - Path to the project directory.
 * @param claudeConfigDir - Path to ~/.claude directory.
 */
export function logMcpStatus(projectPath: string, claudeConfigDir: string): void {
  const projectMcp = join(projectPath, ".mcp.json");
  const globalMcp = join(claudeConfigDir, "..", ".claude.json");

  if (existsSync(projectMcp)) {
    log.debug(`Project MCP config: ${projectMcp}`);
    const warnings = validateMcpCommands(projectMcp);
    for (const w of warnings) {
      log.debug(w);
    }
  }

  if (existsSync(globalMcp)) {
    log.debug(`Global MCP config: ${globalMcp}`);
  }
}
