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

  validate(input: unknown) {
    const raw = typeof input === 'object' && input !== null && typeof (input as { raw?: unknown }).raw === 'string'
      ? (input as { raw: string }).raw
      : '';

    return {
      path: this.mcpConfigPath,
      raw,
      restart_required: this.restartRequired,
      ...validateRaw(raw, this.permissionsService),
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
}
