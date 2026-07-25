import type { ToolCategory, ToolRendererKind, ToolStepSummary } from './types'
import { uiText } from '../../../text/uiText'

export type ToolDescription = {
  actionLabel: string
  objectLabel: string
  renderer: ToolRendererKind
  summary: ToolStepSummary
  toolCategory: ToolCategory
}

const DONE = uiText.process.done
const NOT_FOUND = uiText.process.notFound

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

export function summarizeOutput(output: Record<string, unknown> | undefined) {
  if (!output) return DONE
  if (output.error) return String(output.error)

  if (Array.isArray(output.matches)) {
    const count = typeof output.count === 'number' ? output.count : output.matches.length
    return count > 0 ? `Found ${count} matching item${count === 1 ? '' : 's'}` : NOT_FOUND
  }

  return DONE
}

export function formatToolName(rawName: unknown, toolLabels: Record<string, string>) {
  const name = String(rawName || '').trim()
  return toolLabels[name] || name || uiText.tool.unknownTool
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
  const question = firstString(args, ['question'])
  let objectLabel = name

  switch (name) {
    case 'ask_user':
      objectLabel = shortText(question || uiText.tool.userInput, 96)
      break
    case 'apply_patch':
      objectLabel = path ? shortText(path, 88) : uiText.tool.applyPatchFallback
      break
    case 'write_file':
    case 'edit_file':
    case 'read_file':
    case 'cat':
    case 'sed':
      objectLabel = path ? shortText(path, 88) : uiText.tool.fileContent
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
      objectLabel = shortText(query || path || uiText.tool.searchInProject, 88)
      break
    case 'ls':
      objectLabel = path ? shortText(path, 88) : uiText.tool.listFiles
      break
    case 'view_image':
      objectLabel = path ? shortText(path, 88) : uiText.tool.localImage
      break
    case 'navigate_page': {
      const type = firstString(args, ['type'])
      if (type === 'url' && url) {
        objectLabel = shortText(url, 96)
        break
      }
      if (type === 'back') {
        objectLabel = uiText.tool.previousPage
        break
      }
      if (type === 'forward') {
        objectLabel = uiText.tool.nextPage
        break
      }
      if (type === 'reload') {
        objectLabel = uiText.tool.currentPage
        break
      }
      objectLabel = url ? shortText(url, 96) : uiText.tool.browserPage
      break
    }
    case 'create_page':
      objectLabel = url ? shortText(url, 96) : uiText.tool.newTab
      break
    case 'select_page':
    case 'close_page':
    case 'resize_page':
      objectLabel = pageId ? uiText.tool.page(pageId) : uiText.tool.browserPage
      break
    case 'take_snapshot':
      objectLabel = pageId ? uiText.tool.page(pageId) : uiText.tool.currentWebPage
      break
    case 'take_screenshot':
      objectLabel = args.fullPage ? uiText.tool.fullPage : uiText.tool.currentViewport
      break
    case 'click':
    case 'hover':
      objectLabel = uid ? `Element ${uid}` : selector || uiText.tool.targetElement
      break
    case 'fill':
      objectLabel = uid
        ? `Element ${uid}${value ? `: ${shortText(value, 48)}` : ''}`
        : shortText(value || uiText.tool.typeContent, 72)
      break
    case 'fill_form':
      objectLabel = uiText.tool.pageForm
      break
    case 'upload_file':
      objectLabel = path || (uid ? `Element ${uid}` : uiText.tool.selectFile)
      break
    case 'wait_for':
      objectLabel = text ? shortText(text, 72) : uiText.tool.targetState
      break
    case 'press_key':
      objectLabel = key || uiText.tool.keyboardAction
      break
    case 'type_text':
      objectLabel = text ? shortText(text, 72) : uiText.tool.textContent
      break
    case 'evaluate_script':
      objectLabel = selector ? shortText(selector, 72) : uiText.tool.currentPage
      break
    case 'handle_dialog':
      objectLabel = firstString(args, ['action', 'type']) || uiText.tool.currentDialog
      break
    case 'show_browser':
    case 'hide_browser':
      objectLabel = uiText.tool.browserPanel
      break
    case 'activate_skill':
      objectLabel = firstString(args, ['id', 'name', 'skill']) || uiText.tool.skillConfig
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
      question,
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
  if (name === 'ls') return uiText.tool.viewDirectory
  if (name === 'view_image') return uiText.tool.viewImage
  if (name === 'list_pages' || name === 'take_snapshot' || name === 'take_screenshot' || name === 'hover') {
    return uiText.tool.viewPage
  }
  return uiText.tool.viewFile
}

function changeActionLabel(name: string) {
  if (['apply_patch', 'edit_file', 'write_file'].includes(name)) return name
  if (['show_browser', 'hide_browser'].includes(name)) return uiText.tool.changeLayout
  return uiText.tool.changePage
}

function runActionLabel(name: string) {
  if (name === 'ask_user') return uiText.tool.userInput
  if (['execute', 'shell_command', 'exec_command', 'bash', 'npm'].includes(name)) return uiText.tool.runCommand
  if (['glob', 'grep', 'search', 'rg', 'find'].includes(name)) return uiText.tool.runSearch
  if (name === 'evaluate_script') return uiText.tool.runScript
  if (name === 'wait_for') return uiText.tool.wait
  return uiText.tool.runTool
}

function toolRendererKind(name: string): ToolRendererKind {
  if (name === 'ask_user') return 'ask-user'
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
