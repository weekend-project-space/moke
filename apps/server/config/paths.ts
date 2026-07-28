import { existsSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

export type ServerConfig = {
  appRoot: string;
  defaultWorkspaceRoot: string;
  envPaths: string[];
  mcpConfigPath: string;
  permissionsPath: string;
  port: number;
  settingsPath: string;
  storePath: string;
  statePath: string;
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
  const appRoot = resolvePath(process.env.MOKE_APP_ROOT, process.cwd(), process.cwd());
  const defaultWorkspaceRoot = resolvePath(
    process.env.MOKE_DEFAULT_WORKSPACE || process.env.MOKE_WORKSPACE,
    appRoot,
    appRoot,
  );

  return {
    appRoot,
    defaultWorkspaceRoot,
    envPaths: resolveEnvPaths(appRoot),
    mcpConfigPath: resolvePath(process.env.MOKE_MCP_CONFIG, appRoot, join('.moke', 'mcp.json')),
    permissionsPath: resolvePath(process.env.MOKE_PERMISSIONS_PATH, appRoot, join('.moke', 'permissions.json')),
    port: resolvePort(process.env.PORT),
    settingsPath: resolvePath(process.env.MOKE_SETTINGS_PATH, appRoot, join('.moke', 'settings.json')),
    storePath: resolvePath(process.env.MOKE_STORE_PATH, appRoot, join('.moke', 'store')),
    statePath: resolvePath(process.env.MOKE_STATE_PATH, appRoot, join('.moke', 'state.json')),
  };
}

export function resolveEnvPaths(appRoot: string) {
  return [
    process.env.MOKE_ENV_PATH ? resolvePath(process.env.MOKE_ENV_PATH, appRoot, '') : '',
    join(appRoot, '.env'),
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
