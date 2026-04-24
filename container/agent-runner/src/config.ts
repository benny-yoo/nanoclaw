/**
 * Runner config — reads /workspace/agent/container.json at startup.
 *
 * This file is mounted read-only inside the container. The host writes it;
 * the runner only reads. All NanoClaw-specific configuration lives here
 * instead of environment variables.
 */
import fs from 'fs';
import type { McpServerConfig } from './providers/types.js';

const CONFIG_PATH = '/workspace/agent/container.json';

export interface RunnerConfig {
  provider: string;
  assistantName: string;
  groupName: string;
  agentGroupId: string;
  maxMessagesPerPrompt: number;
  mcpServers: Record<string, McpServerConfig>;
}

const DEFAULT_MAX_MESSAGES = 10;

let _config: RunnerConfig | null = null;

/**
 * Load config from container.json. Called once at startup.
 * Falls back to sensible defaults for any missing field.
 */
export function loadConfig(): RunnerConfig {
  if (_config) return _config;

  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    console.error(`[config] Failed to read ${CONFIG_PATH}, using defaults`);
  }

  _config = {
    provider: (raw.provider as string) || 'claude',
    assistantName: (raw.assistantName as string) || '',
    groupName: (raw.groupName as string) || '',
    agentGroupId: (raw.agentGroupId as string) || '',
    maxMessagesPerPrompt: (raw.maxMessagesPerPrompt as number) || DEFAULT_MAX_MESSAGES,
    mcpServers: loadMcpServers(raw),
  };

  return _config;
}

/** Get the loaded config. Throws if loadConfig() hasn't been called. */
export function getConfig(): RunnerConfig {
  if (!_config) throw new Error('Config not loaded — call loadConfig() first');
  return _config;
}
function loadMcpServers(raw: Record<string, unknown>): Record<string, McpServerConfig> {
  const parsed: Record<string, McpServerConfig> = {};
  const source = raw.mcpServers;
  if (!source || typeof source !== 'object') return parsed;

  for (const [name, value] of Object.entries(source as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue;
    const server = value as Record<string, unknown>;
    const type = typeof server.type === 'string' ? server.type.trim().toLowerCase() : '';

    if (type === 'http' || typeof server.url === 'string') {
      if (typeof server.url !== 'string' || server.url.trim().length === 0) {
        console.error(`[config] MCP server '${name}' has invalid http url, skipping`);
        continue;
      }
      parsed[name] = {
        type: 'http',
        url: server.url,
        headers:
          server.headers && typeof server.headers === 'object'
            ? (server.headers as Record<string, string>)
            : undefined,
      };
      continue;
    }

    if (typeof server.command !== 'string' || server.command.trim().length === 0) {
      console.error(`[config] MCP server '${name}' has invalid stdio command, skipping`);
      continue;
    }

    parsed[name] = {
      type: 'stdio',
      command: server.command,
      args: Array.isArray(server.args) ? (server.args as string[]) : [],
      env: server.env && typeof server.env === 'object' ? (server.env as Record<string, string>) : {},
    };
  }

  return parsed;
}
