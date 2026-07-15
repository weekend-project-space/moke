import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { parseMcpConfigText, type McpConfig } from '@moke/mcp-client';

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
  }>;
  error?: string;
  restart_required: boolean;
};

function summarizeConfig(config: McpConfig): McpSettingsResult['servers'] {
  return config.servers.map((server) => ({
    id: server.id,
    enabled: server.enabled,
    command: server.command,
    args: server.args,
    timeout_ms: server.timeout_ms,
  }));
}

function validateRaw(raw: string) {
  try {
    const config = parseMcpConfigText(raw);
    return {
      valid: true,
      servers: summarizeConfig(config),
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
  constructor(private readonly mcpConfigPath: string) {}

  get(): McpSettingsResult {
    const exists = existsSync(this.mcpConfigPath);
    const raw = exists ? readFileSync(this.mcpConfigPath, 'utf8') : DEFAULT_MCP_CONFIG;
    const validation = validateRaw(raw);

    return {
      path: this.mcpConfigPath,
      exists,
      raw,
      restart_required: false,
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
      restart_required: false,
      ...validateRaw(raw),
    };
  }

  save(input: unknown): McpSettingsResult {
    const raw = typeof input === 'object' && input !== null && typeof (input as { raw?: unknown }).raw === 'string'
      ? (input as { raw: string }).raw
      : '';
    const validation = validateRaw(raw);
    if (!validation.valid) {
      return {
        path: this.mcpConfigPath,
        exists: existsSync(this.mcpConfigPath),
        raw,
        restart_required: false,
        ...validation,
      };
    }

    mkdirSync(dirname(this.mcpConfigPath), { recursive: true });
    writeFileSync(this.mcpConfigPath, raw.endsWith('\n') ? raw : `${raw}\n`);

    return {
      path: this.mcpConfigPath,
      exists: true,
      raw: raw.endsWith('\n') ? raw : `${raw}\n`,
      restart_required: true,
      ...validation,
    };
  }
}
