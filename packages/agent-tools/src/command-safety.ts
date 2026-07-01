import path from 'node:path';

export type CommandSafetyIssueCode =
  | 'absolute_path_outside_workspace'
  | 'relative_path_escapes_workspace'
  | 'drive_relative_path'
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
  const windowsDrivePath = /[a-zA-Z]:[\\/][^\s"'`|&;<>]+/g;
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

function stripTrailingPunctuation(value: string) {
  return value.replace(/[),\].]+$/, '');
}
