import {
  type ExecutableSystemBackend,
  type SystemBackend,
  type ToolRegistry,
  type WritableSystemBackend,
} from '../../agent-runtime/src/index.js';
import { createEditFileTool } from './edit-file.js';
import { createExecuteTool } from './execute.js';
import { createGlobTool } from './glob.js';
import { createGrepTool } from './grep.js';
import { createLsTool } from './ls.js';
import { createReadFileTool } from './read-file.js';
import { createSearchTool } from './search.js';
import { createWriteFileTool } from './write-file.js';

export type AgentToolsSystemBackend = SystemBackend & Partial<WritableSystemBackend> & Partial<ExecutableSystemBackend>;

export function registerAgentTools(toolRegistry: ToolRegistry, system: AgentToolsSystemBackend) {
  toolRegistry
    .register(createLsTool(system))
    .register(createGlobTool(system))
    .register(createGrepTool(system))
    .register(createSearchTool(system))
    .register(createReadFileTool(system));

  if (isWritableSystemBackend(system)) {
    toolRegistry.register(createWriteFileTool(system)).register(createEditFileTool(system));
  }

  if (isExecutableSystemBackend(system)) {
    toolRegistry.register(createExecuteTool(system));
  }

  return toolRegistry;
}

function isWritableSystemBackend(system: AgentToolsSystemBackend): system is SystemBackend & WritableSystemBackend {
  return typeof system.writeFile === 'function' && typeof system.editFile === 'function';
}

function isExecutableSystemBackend(system: AgentToolsSystemBackend): system is SystemBackend & ExecutableSystemBackend {
  return typeof system.execute === 'function';
}
