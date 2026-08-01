import path from 'node:path';
import { homedir } from 'node:os';

export type CommandSafetyIssueCode =
  | 'absolute_path_outside_workspace'
  | 'relative_path_escapes_workspace'
  | 'drive_relative_path'
  | 'working_directory_escapes_workspace'
  | 'environment_path'
  | 'home_path'
  | 'dynamic_path'
  | 'unc_path'
  | 'redirection_target_escapes_workspace';

export type CommandSafetyIssue = {
  code: CommandSafetyIssueCode;
  path: string;
  suggestedRoot: string;
  reason: string;
};

export type CommandSafetyInput = {
  commandText: string;
  cwd: string;
  approvedRoots: string[];
};

export type CommandComplexityIssueCode =
  | 'shell_control_operator'
  | 'substitution'
  | 'encoded_command'
  | 'background_process';

export type CommandComplexityIssue = {
  code: CommandComplexityIssueCode;
  token: string;
  reason: string;
};

export type PowerShellCompatibilityIssue = {
  command: string;
  token: string;
  reason: string;
};

const POWERSHELL_CMD_ALIAS_COMMANDS = new Set([
  'copy',
  'del',
  'dir',
  'erase',
  'move',
  'rd',
  'ren',
  'rename',
  'rmdir',
  'type',
]);

export function analyzeCommandSafety(input: CommandSafetyInput) {
  const issues: CommandSafetyIssue[] = [];
  const commandText = maskUrls(input.commandText);

  for (const rawPath of findDriveRelativePathTokens(commandText)) {
    issues.push({
      code: 'drive_relative_path',
      path: rawPath,
      suggestedRoot: input.cwd,
      reason: `Command path is ambiguous outside workspace: ${rawPath}`,
    });
  }

  for (const rawPath of findLocationChangeTargetTokens(commandText)) {
    const fullPath = resolveShellPathToken(rawPath, input.cwd);
    if (fullPath && !isInsideApprovedRoots(input.approvedRoots, fullPath)) {
      issues.push({
        code: 'working_directory_escapes_workspace',
        path: fullPath,
        suggestedRoot: suggestApprovalRoot(fullPath),
        reason: `Command changes working directory outside workspace: ${rawPath}`,
      });
    }
  }

  for (const rawPath of findEnvironmentPathTokens(commandText)) {
    const fullPath = resolveEnvironmentPathToken(rawPath);
    if (!fullPath || !isInsideApprovedRoots(input.approvedRoots, fullPath)) {
      issues.push({
        code: 'environment_path',
        path: fullPath || rawPath,
        suggestedRoot: fullPath ? suggestApprovalRoot(fullPath) : input.cwd,
        reason: `Command path uses an environment variable and requires approval: ${rawPath}`,
      });
    }
  }

  for (const rawPath of findHomePathTokens(commandText)) {
    const fullPath = resolveHomePathToken(rawPath);
    if (!isInsideApprovedRoots(input.approvedRoots, fullPath)) {
      issues.push({
        code: 'home_path',
        path: fullPath,
        suggestedRoot: suggestApprovalRoot(fullPath),
        reason: `Command path uses the home directory and requires approval: ${rawPath}`,
      });
    }
  }

  for (const rawPath of findDynamicPathRootTokens(commandText)) {
    const fullPath = resolveShellPathToken(rawPath, input.cwd);
    if (fullPath && !isInsideApprovedRoots(input.approvedRoots, fullPath)) {
      issues.push({
        code: 'dynamic_path',
        path: fullPath,
        suggestedRoot: suggestApprovalRoot(fullPath),
        reason: `Command builds a path outside workspace and requires approval: ${rawPath}`,
      });
    }
  }

  for (const rawPath of findAbsolutePathTokens(commandText)) {
    const fullPath = path.resolve(rawPath);
    if (!isInsideApprovedRoots(input.approvedRoots, fullPath)) {
      issues.push({
        code: rawPath.startsWith('\\\\') ? 'unc_path' : 'absolute_path_outside_workspace',
        path: fullPath,
        suggestedRoot: suggestApprovalRoot(fullPath),
        reason: `Command path requires approval: ${rawPath}`,
      });
    }
  }

  const absoluteRawPaths = new Set(findAbsolutePathTokens(commandText));
  for (const rawPath of findRelativePathTokens(commandText)) {
    if (absoluteRawPaths.has(rawPath) || isWindowsDrivePath(rawPath) || rawPath.startsWith('\\\\')) continue;

    const fullPath = path.resolve(input.cwd, rawPath);
    if (!isInsideApprovedRoots(input.approvedRoots, fullPath)) {
      issues.push({
        code: 'relative_path_escapes_workspace',
        path: fullPath,
        suggestedRoot: suggestApprovalRoot(fullPath),
        reason: `Command relative path escapes workspace: ${rawPath}`,
      });
    }
  }

  for (const rawPath of findRedirectionTargetTokens(commandText)) {
    const fullPath = path.isAbsolute(rawPath) || isWindowsDrivePath(rawPath) ? path.resolve(rawPath) : path.resolve(input.cwd, rawPath);
    if (!isInsideApprovedRoots(input.approvedRoots, fullPath)) {
      issues.push({
        code: 'redirection_target_escapes_workspace',
        path: fullPath,
        suggestedRoot: suggestApprovalRoot(fullPath),
        reason: `Command redirection target requires approval: ${rawPath}`,
      });
    }
  }

  return { issues };
}

export function analyzeCommandComplexity(commandText: string) {
  const issues: CommandComplexityIssue[] = [];
  const maskedCommand = maskUrls(commandText);
  const controlOperator = /(?:&&|\|\||[;|])/g;
  const substitution = /(?:\$\(|`[^`]+`)/g;
  const encodedCommand = /(?:^|[\s-])(?:encodedcommand|enc)\b/gi;
  const backgroundProcess = /(?:^|[\s|&;])(?:start-process|start\s+\/?b)\b/gi;

  for (const match of maskedCommand.matchAll(controlOperator)) {
    issues.push({
      code: 'shell_control_operator',
      token: match[0],
      reason: `Command uses shell control operator: ${match[0]}`,
    });
  }

  for (const match of maskedCommand.matchAll(substitution)) {
    issues.push({
      code: 'substitution',
      token: match[0],
      reason: 'Command uses shell substitution',
    });
  }

  for (const match of maskedCommand.matchAll(encodedCommand)) {
    issues.push({
      code: 'encoded_command',
      token: match[0].trim(),
      reason: 'Command uses encoded shell content',
    });
  }

  for (const match of maskedCommand.matchAll(backgroundProcess)) {
    issues.push({
      code: 'background_process',
      token: match[0].trim(),
      reason: 'Command starts a background process',
    });
  }

  return { issues };
}

export function analyzePowerShellCompatibility(commandText: string) {
  const issues: PowerShellCompatibilityIssue[] = [];

  for (const segment of commandText.split(/&&|\|\||[;|]/)) {
    const match = segment.trim().match(/^(?:&\s*)?(?:"([^"]+)"|'([^']+)'|([^\s]+))\s+([\s\S]*)$/);
    if (!match) continue;

    const command = path.win32.basename(match[1] || match[2] || match[3] || '').toLowerCase();
    if (!POWERSHELL_CMD_ALIAS_COMMANDS.has(command)) continue;

    const switchMatch = (match[4] || '').match(/(?:^|\s)(\/[a-z?][\w?:,+-]*)(?=\s|$)/i);
    if (!switchMatch) continue;

    const token = switchMatch[1];
    issues.push({
      command,
      token,
      reason: `Command uses cmd.exe switch ${token} with PowerShell command ${command}. Use PowerShell parameters instead.`,
    });
  }

  return { issues };
}

function maskUrls(commandText: string) {
  return commandText.replace(/\b[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s"'`|&;<>]+/g, (url) => ' '.repeat(url.length));
}

export function isInsideRoot(root: string, fullPath: string) {
  const relative = path.relative(root, fullPath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function suggestApprovalRoot(fullPath: string) {
  const parsed = path.parse(path.resolve(fullPath));
  const relative = path.relative(parsed.root, fullPath);
  const [firstSegment] = relative.split(path.sep).filter(Boolean);
  return firstSegment ? path.join(parsed.root, firstSegment) : parsed.root;
}

function isInsideApprovedRoots(approvedRoots: string[], fullPath: string) {
  return approvedRoots.some((root) => isInsideRoot(root, fullPath));
}

function findAbsolutePathTokens(commandText: string) {
  const tokens = new Set<string>();
  const uncPath = /\\\\[^\\/\s"'`|&;<>]+[\\/][^\s"'`|&;<>]+/g;
  const windowsDrivePath = /[a-zA-Z]:[\\/][^\s"'`|&;<>]*/g;
  const unixPath = /(?<![\w:])\/(?:[^\s"'`|&;<>]+)/g;

  for (const match of commandText.matchAll(uncPath)) {
    tokens.add(stripTrailingPunctuation(match[0]));
  }

  for (const match of commandText.matchAll(windowsDrivePath)) {
    tokens.add(stripTrailingPunctuation(match[0]));
  }

  for (const match of commandText.matchAll(unixPath)) {
    tokens.add(stripTrailingPunctuation(match[0]));
  }

  return [...tokens];
}

function findLocationChangeTargetTokens(commandText: string) {
  const tokens = new Set<string>();
  const locationCommand =
    /(?:^|[\s|&;])(?:cd|chdir|sl|set-location|push-location)\s+(?:"([^"]+)"|'([^']+)'|([^\s"'`|&;<>]+))/gi;

  for (const match of commandText.matchAll(locationCommand)) {
    const token = stripTrailingCommandPunctuation(match[1] || match[2] || match[3] || '');
    if (token && token !== '-') tokens.add(token);
  }

  return [...tokens];
}

function findEnvironmentPathTokens(commandText: string) {
  const tokens = new Set<string>();
  const powerShellEnvPath = /\$env:[a-zA-Z_][\w]*[\\/][^\s"'`|&;<>)]*/g;
  const cmdEnvPath = /%[a-zA-Z_][\w]*%[\\/][^\s"'`|&;<>)]*/g;

  for (const match of commandText.matchAll(powerShellEnvPath)) {
    tokens.add(stripTrailingPunctuation(match[0]));
  }

  for (const match of commandText.matchAll(cmdEnvPath)) {
    tokens.add(stripTrailingPunctuation(match[0]));
  }

  return [...tokens];
}

function findHomePathTokens(commandText: string) {
  const tokens = new Set<string>();
  const homePath = /(?:^|[\s"'`])(~[\\/][^\s"'`|&;<>)]*)/g;

  for (const match of commandText.matchAll(homePath)) {
    const token = stripTrailingPunctuation(match[1] || '');
    if (token) tokens.add(token);
  }

  return [...tokens];
}

function findDynamicPathRootTokens(commandText: string) {
  const tokens = new Set<string>();
  const joinPath = /(?:^|[\s|&;(])join-path\s+(?:"([^"]+)"|'([^']+)'|([^\s"'`|&;<>)]*))/gi;

  for (const match of commandText.matchAll(joinPath)) {
    const token = stripTrailingPunctuation(match[1] || match[2] || match[3] || '');
    if (token) tokens.add(token);
  }

  return [...tokens];
}

function findDriveRelativePathTokens(commandText: string) {
  const tokens = new Set<string>();
  const driveRelativePath = /\b[a-zA-Z]:(?![\\/])(?:[^\s"'`|&;<>]+)/g;

  for (const match of commandText.matchAll(driveRelativePath)) {
    tokens.add(stripTrailingPunctuation(match[0]));
  }

  return [...tokens];
}

function findRelativePathTokens(commandText: string) {
  const tokens = new Set<string>();
  const relativePath = /(?:^|[\s"'`])((?:\.{1,2}[\\/])+(?:[^\s"'`|&;<>]+)?)/g;

  for (const match of commandText.matchAll(relativePath)) {
    const token = stripTrailingPunctuation(match[1] || '');
    if (token && token.includes('..')) tokens.add(token);
  }

  return [...tokens];
}

function findRedirectionTargetTokens(commandText: string) {
  const tokens = new Set<string>();
  const redirection = /(?:^|[^\d])(?:\d?>{1,2})\s*(?:"([^"]+)"|'([^']+)'|([^\s"'`|&;<>]+))/g;

  for (const match of commandText.matchAll(redirection)) {
    const token = stripTrailingPunctuation(match[1] || match[2] || match[3] || '');
    if (token && token !== '$null' && token !== '/dev/null') tokens.add(token);
  }

  return [...tokens];
}

function isWindowsDrivePath(value: string) {
  return /^[a-zA-Z]:[\\/]/.test(value);
}

function resolveShellPathToken(rawPath: string, cwd: string) {
  if (rawPath.startsWith('$env:') || rawPath.startsWith('%')) return resolveEnvironmentPathToken(rawPath);
  if (rawPath.startsWith('~')) return resolveHomePathToken(rawPath);
  if (path.isAbsolute(rawPath) || isWindowsDrivePath(rawPath)) return path.resolve(rawPath);
  return path.resolve(cwd, rawPath);
}

function resolveEnvironmentPathToken(rawPath: string) {
  const powerShellMatch = rawPath.match(/^\$env:([a-zA-Z_][\w]*)([\\/].*)$/);
  if (powerShellMatch) {
    const root = process.env[powerShellMatch[1]];
    return root ? path.join(root, powerShellMatch[2].replace(/^[\\/]+/, '')) : '';
  }

  const cmdMatch = rawPath.match(/^%([a-zA-Z_][\w]*)%([\\/].*)$/);
  if (cmdMatch) {
    const root = process.env[cmdMatch[1]];
    return root ? path.join(root, cmdMatch[2].replace(/^[\\/]+/, '')) : '';
  }

  return '';
}

function resolveHomePathToken(rawPath: string) {
  return path.join(homedir(), rawPath.replace(/^~[\\/]+/, ''));
}

function stripTrailingPunctuation(value: string) {
  return value.replace(/[),\].]+$/, '');
}

function stripTrailingCommandPunctuation(value: string) {
  return value.replace(/[),\]]+$/, '');
}
