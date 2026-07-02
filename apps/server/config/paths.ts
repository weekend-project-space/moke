import { existsSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

export type ServerConfig = {
  envPaths: string[];
  mcpConfigPath: string;
  permissionsPath: string;
  port: number;
  settingsPath: string;
  statePath: string;
  workspace: string;
};

export function normalizeWindowsDrivePath(value: string) {
  // Tauri/Windows can hand Node paths like "\E:\..." which node:path treats as root-relative.
  return process.platform === 'win32' ? value.replace(/^[/\\]+([a-zA-Z]:[/\\])/, '$1') : value;
}

export function resolvePath(value: string | undefined, basePath: string, fallback: string) {
  const raw = normalizeWindowsDrivePath((value || fallback).trim());
  return isAbsolute(raw) ? resolve(raw) : resolve(basePath, raw);
}

export function resolvePort(value: string | undefined) {
  const port = Number(value || 4010);
  if (Number.isInteger(port) && port > 0 && port <= 65535) return port;

  console.warn(`Invalid PORT value "${value}", falling back to 4010.`);
  return 4010;
}

export function resolveServerConfig(): ServerConfig {
  const workspace = resolvePath(process.env.MOKE_WORKSPACE, process.cwd(), process.cwd());

  return {
    envPaths: resolveEnvPaths(workspace),
    mcpConfigPath: resolvePath(process.env.MOKE_MCP_CONFIG, workspace, join('.moke', 'mcp.json')),
    permissionsPath: resolvePath(process.env.MOKE_PERMISSIONS_PATH, workspace, join('.moke', 'permissions.json')),
    port: resolvePort(process.env.PORT),
    settingsPath: resolvePath(process.env.MOKE_SETTINGS_PATH, workspace, join('.moke', 'settings.json')),
    statePath: resolvePath(process.env.MOKE_STATE_PATH, workspace, join('.moke', 'state.json')),
    workspace,
  };
}

export function resolveEnvPaths(workspace: string) {
  return [
    process.env.MOKE_ENV_PATH ? resolvePath(process.env.MOKE_ENV_PATH, workspace, '') : '',
    join(workspace, '.env'),
  ].filter(Boolean);
}

export function loadFirstEnvFile(envPaths: string[]) {
  for (const envPath of envPaths) {
    if (existsSync(envPath)) {
      process.loadEnvFile(envPath);
      return envPath;
    }
  }

  return '';
}
