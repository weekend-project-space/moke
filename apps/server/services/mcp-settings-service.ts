import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { createMcpServerFingerprint, parseMcpConfigText, type McpConfig } from '@moke/mcp-client';
import type { PermissionsService } from './permissions-service.js';

const DEFAULT_MCP_CONFIG = `{
  "mcpServers": {}
}
`;

type McpSettingsResult = {
  path: string;
  exists: boolean;
  raw: string;
  valid: boolean;
  servers: Array<{
    id: string;
    enabled: boolean;
    command: string;
    args: string[];
    timeout_ms: number;
    trusted: boolean;
  }>;
  error?: string;
  restart_required: boolean;
};

export class McpSettingsError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

function summarizeConfig(config: McpConfig, permissionsService: PermissionsService): McpSettingsResult['servers'] {
  return config.servers.map((server) => ({
    id: server.id,
    enabled: server.enabled,
    command: server.command,
    args: server.args,
    timeout_ms: server.timeout_ms,
    trusted: permissionsService.isMcpServerTrusted(server.id, createMcpServerFingerprint(server)),
  }));
}

function validateRaw(raw: string, permissionsService: PermissionsService) {
  try {
    const config = parseMcpConfigText(raw);
    return {
      valid: true,
      servers: summarizeConfig(config, permissionsService),
    };
  } catch (error) {
    return {
      valid: false,
      servers: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export class McpSettingsService {
  private restartRequired = false;

  constructor(
    private readonly mcpConfigPath: string,
    private readonly permissionsService: PermissionsService,
  ) {}

  get(): McpSettingsResult {
    const exists = existsSync(this.mcpConfigPath);
    const raw = exists ? readFileSync(this.mcpConfigPath, 'utf8') : DEFAULT_MCP_CONFIG;
    const validation = validateRaw(raw, this.permissionsService);

    return {
      path: this.mcpConfigPath,
      exists,
      raw,
      restart_required: this.restartRequired,
      ...validation,
    };
  }

  save(input: unknown): McpSettingsResult {
    const raw = typeof input === 'object' && input !== null && typeof (input as { raw?: unknown }).raw === 'string'
      ? (input as { raw: string }).raw
      : '';
    const validation = validateRaw(raw, this.permissionsService);
    if (!validation.valid) {
      return {
        path: this.mcpConfigPath,
        exists: existsSync(this.mcpConfigPath),
        raw,
        restart_required: this.restartRequired,
        ...validation,
      };
    }

    mkdirSync(dirname(this.mcpConfigPath), { recursive: true });
    writeFileSync(this.mcpConfigPath, raw.endsWith('\n') ? raw : `${raw}\n`);
    this.restartRequired = true;

    return {
      path: this.mcpConfigPath,
      exists: true,
      raw: raw.endsWith('\n') ? raw : `${raw}\n`,
      restart_required: true,
      ...validation,
    };
  }

  addServer(input: { id: string; command: string; args: string[] }) {
    const config = this.currentConfig();
    if (config.servers.some((server) => server.id === input.id)) {
      throw new McpSettingsError('MCP_SERVER_EXISTS', `MCP server already exists: ${input.id}`);
    }
    config.servers.push({
      id: input.id,
      transport: 'stdio',
      command: input.command,
      args: input.args,
      enabled: true,
      timeout_ms: 30_000,
      max_output_chars: 20_000,
      disabled_tools: [],
      read_only_tools: [],
    });
    return this.saveConfig(config);
  }

  updateServer(serverId: string, input: { command?: string; args?: string[] }) {
    const config = this.currentConfig();
    const server = config.servers.find((candidate) => candidate.id === serverId);
    if (!server) throw new McpSettingsError('MCP_SERVER_NOT_FOUND', `MCP server not found: ${serverId}`);
    if (input.command !== undefined) server.command = input.command;
    if (input.args !== undefined) server.args = input.args;
    return this.saveConfig(config);
  }

  setServerEnabled(serverId: string, enabled: boolean) {
    const config = this.currentConfig();
    const server = config.servers.find((candidate) => candidate.id === serverId);
    if (!server) throw new McpSettingsError('MCP_SERVER_NOT_FOUND', `MCP server not found: ${serverId}`);
    server.enabled = enabled;
    return this.saveConfig(config);
  }

  removeServer(serverId: string) {
    const config = this.currentConfig();
    const nextServers = config.servers.filter((server) => server.id !== serverId);
    if (nextServers.length === config.servers.length) {
      throw new McpSettingsError('MCP_SERVER_NOT_FOUND', `MCP server not found: ${serverId}`);
    }
    config.servers = nextServers;
    this.permissionsService.revokeMcpServerTrust(serverId);
    return this.saveConfig(config);
  }

  trust(serverId: string) {
    const server = this.currentConfig().servers.find((candidate) => candidate.id === serverId);
    if (!server) return false;
    this.permissionsService.trustMcpServer(server.id, createMcpServerFingerprint(server));
    return true;
  }

  revokeTrust(serverId: string) {
    return this.permissionsService.revokeMcpServerTrust(serverId);
  }

  private currentConfig() {
    const raw = existsSync(this.mcpConfigPath)
      ? readFileSync(this.mcpConfigPath, 'utf8')
      : DEFAULT_MCP_CONFIG;
    return parseMcpConfigText(raw);
  }

  private saveConfig(config: McpConfig) {
    const raw = `${JSON.stringify({ servers: config.servers }, null, 2)}\n`;
    return this.save({ raw });
  }
}
