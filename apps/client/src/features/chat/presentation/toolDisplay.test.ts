import assert from 'node:assert/strict'
import test from 'node:test'

import { createProcessGroupView } from './processDisplay'
import { describeToolCall, summarizeOutput } from './toolDisplay'
import type { ProcessItem, ToolStepViewItem } from './types'

test('classifies workspace, browser, and channel tools by their owning surface', () => {
  assert.equal(describeToolCall('read_file', { path: 'README.md' }).toolCategory, 'view')
  assert.equal(describeToolCall('write_file', { path: 'README.md' }).toolCategory, 'change')
  assert.equal(describeToolCall('execute', { command: 'npm test' }).toolCategory, 'run')
  assert.equal(describeToolCall('create_page', { url: 'https://example.com' }).toolCategory, 'browser')
  assert.equal(describeToolCall('send_message', { text: 'Hello' }).toolCategory, 'claw')
  assert.equal(describeToolCall('activate_skill', { id: 'openwalk-usage' }).toolCategory, 'skill')
})

test('describes send_message media and gives it the channel renderer', () => {
  const description = describeToolCall('send_message', {
    images: [{ path: 'image.png' }, { path: 'image-2.png' }],
    files: [{ path: 'report.pdf' }],
  })

  assert.equal(description.renderer, 'channel')
  assert.equal(description.objectLabel, '2 images \u00b7 1 file')
})

test('summarizes activated skills instead of reporting a generic completion', () => {
  assert.equal(
    summarizeOutput({
      status: 'activated',
      truncated: true,
      notice: 'Skill instructions were truncated to fit the context budget.',
    }),
    'activated \u00b7 truncated \u00b7 Skill instructions were truncated to fit the context budget.',
  )
})

test('renders structured search, browser, and channel tool results', () => {
  const steps = createProcessGroupView([
    toolCall('search', 'search', 'call-search'),
    toolResult('call-search', {
      count: 2,
      results: [
        { path: 'src/main.ts', snippet: 'const answer = 42', line: 12 },
        { path: 'src/main.ts', snippet: 'export { answer }', line: 18 },
      ],
    }),
    toolCall('list_pages', 'browser', 'call-browser'),
    toolResult('call-browser', {
      activePageId: 2,
      pages: [
        { pageId: 1, title: 'Home', url: 'https://home.example' },
        { pageId: 2, title: 'Docs', url: 'https://docs.example' },
      ],
      snapshot: { title: 'Docs', url: 'https://docs.example', elements: [{ uid: 'a' }, { uid: 'b' }] },
    }),
    toolCall('send_message', 'channel', 'call-channel'),
    toolResult('call-channel', {
      receipts: [{ type: 'text', delivered_at: '2026-07-25T10:00:00Z' }],
    }),
  ]).items as ToolStepViewItem[]

  assert.deepEqual(steps[0].summary.files, ['src/main.ts'])
  assert.equal(steps[0].summary.preview, 'const answer = 42')
  assert.equal(steps[1].summary.preview, 'Docs \u00b7 https://docs.example \u00b7 2 elements \u00b7 2 tabs')
  assert.equal(steps[2].summary.preview, 'Delivered to 1 message (text)')
})

function toolCall(name: string, renderer: ToolStepViewItem['renderer'], toolCallId: string): ProcessItem {
  return {
    id: `${toolCallId}-input`,
    kind: 'tool-call',
    title: name,
    detail: name,
    tone: 'neutral',
    actionLabel: name,
    objectLabel: name,
    renderer,
    summary: {},
    toolCategory: renderer === 'browser' ? 'browser' : renderer === 'channel' ? 'claw' : 'run',
    toolCallId,
  }
}

function toolResult(toolCallId: string, output: Record<string, unknown>): ProcessItem {
  return {
    id: `${toolCallId}-output`,
    kind: 'tool-result',
    title: 'result',
    detail: 'Done',
    tone: 'neutral',
    raw: JSON.stringify(output),
    toolCallId,
  }
}
