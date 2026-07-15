import { z } from 'zod';

import type { ExecutableSystemBackend, RuntimeTool } from '@moke/agent-runtime';
import { ToolExecutionError } from '@moke/agent-runtime';
import { analyzeCommandComplexity } from './command-safety.js';

const executeSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  cwd: z.string().optional(),
  timeout_ms: z.number().int().positive().max(120000).optional(),
});

export function createExecuteTool(system: ExecutableSystemBackend): RuntimeTool<typeof executeSchema> {
  return {
    name: 'execute',
    description: 'Run a shell command in the workspace environment.',
    risk: 'dangerous',
    schema: executeSchema,
    async handler(input, context) {
      const commandText = input.args?.length ? [input.command, ...input.args].join(' ') : input.command;
      const complexity = shouldCheckCommandComplexity(input.command, input.args) ? analyzeCommandComplexity(commandText) : { issues: [] };
      if (complexity.issues.length > 0 && !isAllowlistedComplexCommand(commandText)) {
        if (!context.approveTool) {
          throw new ToolExecutionError('Complex shell command requires approval', {
            error: {
              code: 'TOOL_APPROVAL_REQUIRED',
              message: 'Complex shell command requires approval',
              tool: 'execute',
            },
          });
        }

        const decision = await context.approveTool({
          tool: 'execute',
          input,
          risk: 'dangerous',
          callId: context.currentToolCall?.callId,
          reason: `\u590d\u6742\u547d\u4ee4\u9700\u8981\u786e\u8ba4\uff1a${complexityReason(complexity.issues[0].code)}`,
        });
        if (!decision.approved) {
          throw new ToolExecutionError(decision.message || 'User rejected the command', {
            error: {
              code: 'TOOL_ACCESS_REJECTED',
              message: decision.message || 'User rejected the command',
              tool: 'execute',
            },
          });
        }
      }

      return system.execute(input.command, input.args, {
        cwd: input.cwd,
        timeoutMs: input.timeout_ms,
      });
    },
  };
}

function shouldCheckCommandComplexity(command: string, args: string[] = []) {
  return args.length === 0 || isShellExecutable(command);
}

function isShellExecutable(command: string) {
  const name = command.split(/[\\/]/).at(-1)?.toLowerCase().replace(/\.(exe|cmd|bat)$/, '') || command.toLowerCase();
  return ['bash', 'cmd', 'powershell', 'pwsh', 'sh', 'zsh'].includes(name);
}

function isAllowlistedComplexCommand(commandText: string) {
  const normalized = commandText.replace(/\s+/g, ' ').trim();
  if (!normalized.includes('&&')) return false;
  if (/[;|]|\|\||\$\(|`/.test(normalized)) return false;

  return normalized.split('&&').every((part) => isAllowlistedSimpleCommand(part.trim()));
}

function isAllowlistedSimpleCommand(commandText: string) {
  return [
    /^npm test$/,
    /^npm run test$/,
    /^npm run build$/,
    /^npm run build:server$/,
  ].some((pattern) => pattern.test(commandText));
}

function complexityReason(code: ReturnType<typeof analyzeCommandComplexity>['issues'][number]['code']) {
  const labels = {
    background_process: '\u542f\u52a8\u540e\u53f0\u8fdb\u7a0b',
    encoded_command: '\u5305\u542b\u7f16\u7801\u547d\u4ee4',
    shell_control_operator: '\u5305\u542b shell \u63a7\u5236\u7b26',
    substitution: '\u5305\u542b\u547d\u4ee4\u66ff\u6362',
  };

  return labels[code];
}
