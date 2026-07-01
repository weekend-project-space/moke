import type { ToolCategory, ToolRendererKind, ToolStepSummary } from '../types/conversation'

export type ToolDescription = {
  actionLabel: string
  objectLabel: string
  renderer: ToolRendererKind
  summary: ToolStepSummary
  toolCategory: ToolCategory
}

const DONE = '\u5df2\u5b8c\u6210'
const NOT_FOUND = '\u6ca1\u6709\u627e\u5230\u76f8\u5173\u5185\u5bb9'

const CHANGE_TOOLS = new Set([
  'apply_patch',
  'click',
  'close_page',
  'create_page',
  'edit_file',
  'fill',
  'fill_form',
  'handle_dialog',
  'hide_browser',
  'navigate_page',
  'press_key',
  'resize_page',
  'select_page',
  'show_browser',
  'type_text',
  'upload_file',
  'write_file',
])

export function summarizeOutput(output: Record<string, any> | undefined) {
  if (!output) return DONE
  if (output.error) return String(output.error)

  if (Array.isArray(output.matches)) {
    const count = output.count ?? output.matches.length
    return count > 0 ? `\u627e\u5230 ${count} \u6761\u76f8\u5173\u5185\u5bb9` : NOT_FOUND
  }

  return DONE
}

export function formatToolName(rawName: unknown, toolLabels: Record<string, string>) {
  const name = String(rawName || '').trim()
  return toolLabels[name] || name || '\u5de5\u5177'
}

export function formatJson(value: unknown) {
  try {
    return JSON.stringify(value ?? {}, null, 2)
  } catch {
    return String(value ?? '')
  }
}

export function parseToolContent(content: string) {
  try {
    return JSON.parse(content)
  } catch {
    return content
  }
}

export function shortText(value: string, maxLength: number) {
  const text = value.replace(/\s+/g, ' ').trim()
  if (text.length <= maxLength) return text
  return `${text.slice(0, maxLength - 1)}...`
}

function firstString(args: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = args[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
    if (typeof value === 'number') return String(value)
  }

  return ''
}

export function describeToolCall(name: string, args: Record<string, unknown>): ToolDescription {
  const command = firstString(args, ['command', 'cmd', 'script'])
  const path = firstString(args, ['path', 'file', 'filePath', 'cwd'])
  const query = firstString(args, ['query', 'pattern', 'q'])
  const pageId = firstString(args, ['pageId'])
  const uid = firstString(args, ['uid'])
  const url = firstString(args, ['url'])
  const text = firstString(args, ['text'])
  const value = firstString(args, ['value'])
  const key = firstString(args, ['key'])
  const selector = firstString(args, ['selector'])
  let objectLabel = name

  switch (name) {
    case 'apply_patch':
      objectLabel = path ? shortText(path, 88) : '\u5e94\u7528\u4ee3\u7801\u8865\u4e01'
      break
    case 'write_file':
    case 'edit_file':
    case 'read_file':
    case 'cat':
    case 'sed':
      objectLabel = path ? shortText(path, 88) : '\u6587\u4ef6\u5185\u5bb9'
      break
    case 'execute':
    case 'shell_command':
    case 'exec_command':
    case 'bash':
    case 'npm':
      objectLabel = command ? shortText(command, 96) : name
      break
    case 'glob':
    case 'grep':
    case 'search':
    case 'rg':
    case 'find':
      objectLabel = shortText(query || path || '\u5728\u9879\u76ee\u4e2d\u67e5\u627e', 88)
      break
    case 'ls':
      objectLabel = path ? shortText(path, 88) : '\u67e5\u770b\u6587\u4ef6\u5217\u8868'
      break
    case 'view_image':
      objectLabel = path ? shortText(path, 88) : '\u6253\u5f00\u672c\u5730\u56fe\u7247'
      break
    case 'navigate_page': {
      const type = firstString(args, ['type'])
      if (type === 'url' && url) {
        objectLabel = shortText(url, 96)
        break
      }
      if (type === 'back') {
        objectLabel = '\u4e0a\u4e00\u9875'
        break
      }
      if (type === 'forward') {
        objectLabel = '\u4e0b\u4e00\u9875'
        break
      }
      if (type === 'reload') {
        objectLabel = '\u5f53\u524d\u9875\u9762'
        break
      }
      objectLabel = url ? shortText(url, 96) : '\u6d4f\u89c8\u5668\u9875\u9762'
      break
    }
    case 'create_page':
      objectLabel = url ? shortText(url, 96) : '\u65b0\u6807\u7b7e\u9875'
      break
    case 'select_page':
    case 'close_page':
    case 'resize_page':
      objectLabel = pageId ? `\u9875\u9762 ${pageId}` : '\u6d4f\u89c8\u5668\u6807\u7b7e\u9875'
      break
    case 'take_snapshot':
      objectLabel = pageId ? `\u9875\u9762 ${pageId}` : '\u5f53\u524d\u7f51\u9875'
      break
    case 'take_screenshot':
      objectLabel = args.fullPage ? '\u5b8c\u6574\u9875\u9762' : '\u5f53\u524d\u89c6\u53e3'
      break
    case 'click':
    case 'hover':
      objectLabel = uid ? `\u5143\u7d20 ${uid}` : selector || '\u76ee\u6807\u5143\u7d20'
      break
    case 'fill':
      objectLabel = uid
        ? `\u5143\u7d20 ${uid}${value ? `: ${shortText(value, 48)}` : ''}`
        : shortText(value || '\u8f93\u5165\u5185\u5bb9', 72)
      break
    case 'fill_form':
      objectLabel = '\u9875\u9762\u8868\u5355'
      break
    case 'upload_file':
      objectLabel = path || (uid ? `\u5143\u7d20 ${uid}` : '\u9009\u62e9\u6587\u4ef6')
      break
    case 'wait_for':
      objectLabel = text ? shortText(text, 72) : '\u76ee\u6807\u72b6\u6001\u51fa\u73b0'
      break
    case 'press_key':
      objectLabel = key || '\u952e\u76d8\u64cd\u4f5c'
      break
    case 'type_text':
      objectLabel = text ? shortText(text, 72) : '\u6587\u672c\u5185\u5bb9'
      break
    case 'evaluate_script':
      objectLabel = selector ? shortText(selector, 72) : '\u5f53\u524d\u9875\u9762'
      break
    case 'handle_dialog':
      objectLabel = firstString(args, ['action', 'type']) || '\u5f53\u524d\u5f39\u7a97'
      break
    case 'show_browser':
    case 'hide_browser':
      objectLabel = '\u53f3\u4fa7\u9762\u677f'
      break
    case 'active_skill':
      objectLabel = firstString(args, ['name', 'skill']) || '\u80fd\u529b\u914d\u7f6e'
      break
    case 'list_skills':
      objectLabel = '\u53ef\u7528\u80fd\u529b\u5217\u8868'
      break
    default:
      objectLabel = name
  }

  const descriptor = displayToolDescriptor(name)
  const renderer = toolRendererKind(name)

  return {
    actionLabel: descriptor.actionLabel,
    objectLabel,
    renderer,
    summary: {
      command,
      cwd: firstString(args, ['cwd']),
      path,
      query,
      url,
      uid,
      value: text || value || key,
    },
    toolCategory: descriptor.category,
  }
}

function displayToolDescriptor(name: string): { actionLabel: string; category: ToolCategory } {
  if (isViewTool(name)) return { actionLabel: viewActionLabel(name), category: 'view' }
  if (isChangeTool(name)) return { actionLabel: changeActionLabel(name), category: 'change' }
  return { actionLabel: runActionLabel(name), category: 'run' }
}

function isViewTool(name: string) {
  return [
    'cat',
    'hover',
    'list_pages',
    'list_skills',
    'ls',
    'read_file',
    'sed',
    'take_screenshot',
    'take_snapshot',
    'view_image',
  ].includes(name)
}

function isChangeTool(name: string) {
  return CHANGE_TOOLS.has(name)
}

function viewActionLabel(name: string) {
  if (name === 'ls') return '\u67e5\u770b\u76ee\u5f55'
  if (name === 'view_image') return '\u67e5\u770b\u56fe\u7247'
  if (name === 'list_pages' || name === 'take_snapshot' || name === 'take_screenshot' || name === 'hover') {
    return '\u67e5\u770b\u9875\u9762'
  }
  if (name === 'list_skills') return '\u67e5\u770b\u5de5\u5177'
  return '\u67e5\u770b\u6587\u4ef6'
}

function changeActionLabel(name: string) {
  if (['apply_patch', 'edit_file', 'write_file'].includes(name)) return name
  if (['show_browser', 'hide_browser'].includes(name)) return '\u53d8\u66f4\u754c\u9762'
  return '\u53d8\u66f4\u9875\u9762'
}

function runActionLabel(name: string) {
  if (['execute', 'shell_command', 'exec_command', 'bash', 'npm'].includes(name)) return '\u8fd0\u884c\u547d\u4ee4'
  if (['glob', 'grep', 'search', 'rg', 'find'].includes(name)) return '\u8fd0\u884c\u641c\u7d22'
  if (name === 'evaluate_script') return '\u8fd0\u884c\u811a\u672c'
  if (name === 'wait_for') return '\u8fd0\u884c\u7b49\u5f85'
  return '\u8fd0\u884c\u5de5\u5177'
}

function toolRendererKind(name: string): ToolRendererKind {
  if (name === 'ls') return 'directory'
  if (['read_file', 'cat', 'sed'].includes(name)) return 'file-read'
  if (['apply_patch', 'edit_file', 'write_file'].includes(name)) return 'file-change'
  if (['glob', 'grep', 'search', 'rg', 'find'].includes(name)) return 'search'
  if (['execute', 'shell_command', 'exec_command', 'bash', 'npm'].includes(name)) return 'command'
  if (
    [
      'click',
      'close_page',
      'create_page',
      'evaluate_script',
      'fill',
      'fill_form',
      'handle_dialog',
      'hide_browser',
      'hover',
      'list_pages',
      'navigate_page',
      'press_key',
      'resize_page',
      'select_page',
      'show_browser',
      'take_screenshot',
      'take_snapshot',
      'type_text',
      'upload_file',
      'wait_for',
    ].includes(name)
  ) {
    return 'browser'
  }

  return 'generic'
}
