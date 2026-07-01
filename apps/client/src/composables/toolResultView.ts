import type { ToolStepViewItem } from '../types/conversation'
import { formatBytes } from './toolContentGuard'

export type FileChangeResultView = {
  path: string
  metaItems: string[]
  contentText: string
  emptyText: string
}

export type CliTextResultView = {
  text: string
}

export function createCliTextResultView(step: ToolStepViewItem): CliTextResultView {
  return {
    text: cliTextFromRaw(step.outputRaw) || step.summary.preview || waitingText(),
  }
}

export function createFileChangeResultView(step: ToolStepViewItem): FileChangeResultView {
  const input = parseJsonObject(step.inputRaw)
  const output = parseJsonObject(step.outputRaw)
  const path =
    firstString(output, ['path', 'file', 'filePath']) ||
    firstString(input, ['path', 'file', 'filePath']) ||
    step.summary.path ||
    step.objectLabel
  const metaItems: string[] = []

  if (typeof output.bytes === 'number') metaItems.push(formatBytes(output.bytes))
  if (typeof output.replacements === 'number') metaItems.push(`${output.replacements} \u5904\u66ff\u6362`)
  if (step.tone === 'error') metaItems.push('\u5931\u8d25')

  return {
    path,
    metaItems,
    contentText: fileChangeContentText(step.toolName, input, output),
    emptyText: '\u6ca1\u6709\u8fd4\u56de\u6587\u4ef6\u5185\u5bb9',
  }
}

export function cliTextFromRaw(raw: string | undefined) {
  if (!raw) return ''

  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return String(parsed ?? '')

    return cliTextFromObject(parsed as Record<string, unknown>)
  } catch {
    return raw
  }
}

function cliTextFromObject(output: Record<string, unknown>) {
  const explicit = stringValue(output.cli_text)
  if (explicit) return explicit

  const stderr = stringValue(output.stderr)
  const stdout = stringValue(output.stdout)
  if (stdout && stderr) return `${stdout}\n${stderr}`
  if (stdout) return stdout
  if (stderr) return stderr

  for (const key of ['content', 'text', 'message', 'error']) {
    const value = stringValue(output[key])
    if (value) return value
  }

  return formatJson(output)
}

function fileChangeContentText(toolName: string, input: Record<string, unknown>, output: Record<string, unknown>) {
  if (toolName === 'write_file') return stringValue(input.content) || stringValue(output.content)

  if (toolName === 'edit_file') {
    const oldText = stringValue(input.old_string)
    const newText = stringValue(input.new_string)
    const parts: string[] = []
    if (oldText) parts.push(`- ${oldText}`)
    if (newText) parts.push(`+ ${newText}`)
    return parts.join('\n')
  }

  if (toolName === 'apply_patch') {
    return stringValue(input.patch) || stringValue(input.content) || stringValue(output.patch) || stringValue(output.content)
  }

  return stringValue(output.content) || stringValue(output.text)
}

function parseJsonObject(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {}

  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
  } catch {
    return {}
  }

  return {}
}

function firstString(source: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = stringValue(source[key])
    if (value.trim()) return value.trim()
  }

  return ''
}

function stringValue(value: unknown) {
  return typeof value === 'string' ? value : ''
}

function formatJson(value: unknown) {
  try {
    return JSON.stringify(value ?? {}, null, 2)
  } catch {
    return String(value ?? '')
  }
}

function waitingText() {
  return '\u7b49\u5f85\u7ed3\u679c'
}
