import assert from 'node:assert/strict'
import test from 'node:test'

import { createProcessGroupView, formatProcessGroupStatus, resolveToolStepState } from './processDisplay'
import type { ProcessItem, ToolStepViewItem } from './types'

const group = {
  label: 'Process details',
  items: [],
  hasError: false,
  startedAt: 1_000,
  endedAt: 4_000,
}

test('formatProcessGroupStatus distinguishes active and completed work', () => {
  assert.deepEqual(formatProcessGroupStatus(group, true, 5_000), {
    durationLabel: '4s',
    label: 'Working · 4s',
  })
  assert.deepEqual(formatProcessGroupStatus(group), {
    durationLabel: '3s',
    label: 'Processed · 3s',
  })
})

test('process display restores an answered ask_user tool step', () => {
  const items: ProcessItem[] = [
    {
      id: 'ask-call',
      kind: 'tool-call',
      title: 'ask_user',
      detail: 'Which side?',
      tone: 'neutral',
      actionLabel: 'User input',
      objectLabel: 'Which side?',
      renderer: 'ask-user',
      summary: { question: 'Which side?' },
      toolCategory: 'run',
      toolCallId: 'call_1',
    },
    {
      id: 'ask-result',
      kind: 'tool-result',
      title: 'ask_user',
      detail: 'Frontend',
      tone: 'neutral',
      toolCallId: 'call_1',
      raw: JSON.stringify({
        question: 'Which side?',
        selected: { id: 'frontend', label: 'Frontend' },
        status: 'answered',
      }),
    },
  ]

  const step = createProcessGroupView(items).items[0] as ToolStepViewItem

  assert.equal(step.kind, 'tool-step')
  assert.equal(step.renderer, 'ask-user')
  assert.equal(step.summary.question, 'Which side?')
  assert.equal(step.summary.selectedLabel, 'Frontend')
})

test('process display attaches approval history to the original tool step', () => {
  const approval = {
    approval_id: 'approval_1',
    kind: 'tool' as const,
    decision: 'approved' as const,
    scope: 'once' as const,
    reason: 'Run command',
  }
  const items: ProcessItem[] = [
    {
      id: 'execute-call',
      kind: 'tool-call',
      title: 'execute',
      detail: 'npm test',
      tone: 'neutral',
      toolCallId: 'call_1',
    },
    {
      id: 'execute-result',
      kind: 'tool-result',
      title: 'execute',
      detail: 'Done',
      tone: 'neutral',
      toolCallId: 'call_1',
      raw: '{}',
      approvals: [approval],
    },
  ]

  const step = createProcessGroupView(items).items[0] as ToolStepViewItem

  assert.deepEqual(step.approvals, [approval])
  assert.deepEqual(step.state, { kind: 'approved', label: 'Allowed once' })
})

test('process display prioritizes rejection and execution failure states', () => {
  const rejected = {
    approval_id: 'approval_1',
    kind: 'tool' as const,
    decision: 'rejected' as const,
    scope: 'once' as const,
    reason: 'Run command',
  }
  const approved = { ...rejected, decision: 'approved' as const }

  assert.deepEqual(resolveToolStepState('error', [rejected]), { kind: 'rejected', label: 'Rejected' })
  assert.deepEqual(resolveToolStepState('error', [approved]), { kind: 'failed', label: 'Failed' })
  assert.deepEqual(resolveToolStepState('error'), { kind: 'failed', label: 'Failed' })
})

test('process display retains a non-zero command exit code', () => {
  const items: ProcessItem[] = [
    {
      id: 'command-call',
      kind: 'tool-call',
      title: 'execute',
      detail: 'npm test',
      tone: 'neutral',
      actionLabel: 'Run command',
      objectLabel: 'npm test',
      renderer: 'command',
      summary: { command: 'npm test' },
      toolCategory: 'run',
      toolCallId: 'call_1',
    },
    {
      id: 'command-result',
      kind: 'tool-result',
      title: 'execute',
      detail: 'Completed',
      tone: 'neutral',
      toolCallId: 'call_1',
      raw: JSON.stringify({ exit_code: 1, stdout: 'partial output' }),
    },
  ]

  const step = createProcessGroupView(items).items[0] as ToolStepViewItem
  assert.equal(step.summary.exitCode, 1)
  assert.equal(step.tone, 'error')
})

test('process display merges tool name, arguments, and output into one step', () => {
  const items: ProcessItem[] = [
    {
      id: 'command-created',
      kind: 'tool-call',
      title: 'execute',
      detail: '',
      tone: 'neutral',
      toolCallId: 'call_1',
    },
    {
      id: 'command-ready',
      kind: 'tool-args',
      title: 'Arguments',
      detail: '',
      tone: 'neutral',
      toolCallId: 'call_1',
      raw: JSON.stringify({ command: 'npm test' }),
    },
    {
      id: 'command-completed',
      kind: 'tool-result',
      title: 'execute',
      detail: 'Completed',
      tone: 'neutral',
      toolCallId: 'call_1',
      raw: JSON.stringify({ exit_code: 0, stdout: 'passed' }),
    },
  ]

  const group = createProcessGroupView(items)
  const step = group.items[0] as ToolStepViewItem

  assert.equal(group.items.length, 1)
  assert.equal(step.toolName, 'execute')
  assert.equal(step.renderer, 'command')
  assert.equal(step.objectLabel, 'npm test')
  assert.equal(step.inputRaw, JSON.stringify({ command: 'npm test' }))
  assert.equal(step.outputRaw, JSON.stringify({ exit_code: 0, stdout: 'passed' }))
  assert.equal(step.summary.command, 'npm test')
  assert.equal(step.summary.stdout, 'passed')
})

test('process display keeps activated skill rows compact', () => {
  const items: ProcessItem[] = [
    {
      id: 'skill-call',
      kind: 'tool-call',
      title: 'activate_skill',
      detail: 'openwalk-usage',
      tone: 'neutral',
      actionLabel: 'Run tool',
      objectLabel: 'openwalk-usage',
      renderer: 'generic',
      summary: {},
      toolCategory: 'skill',
      toolCallId: 'call_1',
    },
    {
      id: 'skill-result',
      kind: 'tool-result',
      title: 'activate_skill',
      detail: 'activated',
      tone: 'neutral',
      toolCallId: 'call_1',
      raw: JSON.stringify({
        status: 'activated',
        truncated: true,
        notice: 'Skill instructions were truncated to fit the context budget.',
      }),
    },
  ]

  const step = createProcessGroupView(items).items[0] as ToolStepViewItem
  assert.equal(step.objectLabel, 'openwalk-usage')
  assert.equal(step.summary.preview, 'activated \u00b7 truncated \u00b7 Skill instructions were truncated to fit the context budget.')
})
