import assert from 'node:assert/strict'
import test from 'node:test'
import { ref } from 'vue'
import type { AgentEvent } from '../model/conversation'
import type { ToolStepViewItem } from './types'
import { projectToolCalls } from './toolCallProjector'
import { useConversationDisplay } from './useConversationDisplay'

const approvedOnce = {
  approval_id: 'approval_1',
  kind: 'tool' as const,
  decision: 'approved' as const,
  scope: 'once' as const,
  reason: 'Write file',
  policy_reason: 'Allowed by the read-only permission policy',
  approval_mode: 'read-only' as const,
}

function event<T extends AgentEvent['type']>(type: T, fields: Omit<Extract<AgentEvent, { type: T }>, 'eventId' | 'sequence' | 'threadId' | 'runId' | 'timestamp'>, sequence: number): Extract<AgentEvent, { type: T }> {
  return { ...fields, type, eventId: `evt_${sequence}`, sequence, threadId: 'thread_1', runId: 'run_1', timestamp: 1000 + sequence } as Extract<AgentEvent, { type: T }>
}

test('conversation display combines tool argument deltas into one tool step', () => {
  const events: AgentEvent[] = [
    event('tool_call.started', { toolCallId: 'call_1', toolCallName: 'execute' }, 1),
    event('tool_call.args', { toolCallId: 'call_1', delta: '{"command":' }, 2),
    event('tool_call.args', { toolCallId: 'call_1', delta: '"npm test"}' }, 3),
  ]
  const display = useConversationDisplay({
    messages: ref([]), events: ref(events), isRunning: ref(true), runtimeNow: ref(2000),
    runError: ref(''), pendingAsk: ref(null), pendingApproval: ref(null), processCollapsed: ref({}),
  })

  const group = display.displayItems.value.find(item => item.type === 'process-group')
  assert.ok(group && group.type === 'process-group')
  assert.equal(group.items.length, 1)
  const step = group.items[0] as ToolStepViewItem
  assert.equal(step.kind, 'tool-step')
  assert.equal(step.inputRaw, JSON.stringify({ command: 'npm test' }, null, 2))
  assert.equal(step.summary.command, 'npm test')
})

test('completed assistant text remains before its tool in the process group', () => {
  const display = useConversationDisplay({
    messages: ref([{
      id: 'msg_1', role: 'assistant', content: 'I will inspect it.', created_at: new Date(1000).toISOString(),
      tool_calls: [{ id: 'call_1', name: 'read_file', args: { path: 'a.ts' } }],
    }]),
    events: ref([]), isRunning: ref(false), runtimeNow: ref(2000), runError: ref(''),
    pendingAsk: ref(null), pendingApproval: ref(null), processCollapsed: ref({}),
  })
  const group = display.displayItems.value.find(item => item.type === 'process-group')
  assert.ok(group && group.type === 'process-group')
  assert.deepEqual(group.items.map(item => item.kind), ['assistant', 'tool-step'])
})

test('conversation display updates reasoning while deltas are streaming', () => {
  const events = ref<AgentEvent[]>([
    event('reasoning_message.content', { messageId: 'reason_1', delta: 'first' }, 1),
  ])
  const display = useConversationDisplay({
    messages: ref([]), events, isRunning: ref(true), runtimeNow: ref(2000), runError: ref(''),
    pendingAsk: ref(null), pendingApproval: ref(null), processCollapsed: ref({}),
  })

  const reasoningRaw = () => {
    const group = display.displayItems.value.find(item => item.type === 'process-group')
    assert.ok(group && group.type === 'process-group')
    return group.items.find(item => item.kind === 'reasoning')?.raw
  }

  assert.equal(reasoningRaw(), 'first')
  events.value = [{ ...events.value[0]!, delta: 'first second' }]
  assert.equal(reasoningRaw(), 'first second')
})

test('file change tool row shows a streaming path without exposing arguments', () => {
  const events: AgentEvent[] = [
    event('tool_call.started', { toolCallId: 'call_1', toolCallName: 'write_file' }, 1),
    event('tool_call.args', { toolCallId: 'call_1', delta: '{"path":"src/app.ts","content":"streaming' }, 2),
  ]
  const display = useConversationDisplay({
    messages: ref([]),
    events: ref([events[0]!]),
    toolCalls: ref(projectToolCalls(events)),
    isRunning: ref(true), runtimeNow: ref(2000), runError: ref(''), pendingAsk: ref(null),
    pendingApproval: ref(null), processCollapsed: ref({}),
  })

  const group = display.displayItems.value.find(item => item.type === 'process-group')
  assert.ok(group && group.type === 'process-group')
  const step = group.items[0] as ToolStepViewItem
  assert.equal(step.renderer, 'file-change')
  assert.equal(step.objectLabel, 'src/app.ts')
  assert.equal(step.inputRaw, undefined)
})

test('answered ask is shown in the live user-input tool row', () => {
  const display = useConversationDisplay({
    messages: ref([]),
    events: ref([event('tool_call.started', { toolCallId: 'call_1', toolCallName: 'ask_user' }, 1)]),
    answeredInteractions: ref(new Map([['call_1', 'Frontend']])),
    isRunning: ref(true), runtimeNow: ref(2000), runError: ref(''), pendingAsk: ref(null),
    pendingApproval: ref(null), processCollapsed: ref({}),
  })

  const group = display.displayItems.value.find(item => item.type === 'process-group')
  assert.ok(group && group.type === 'process-group')
  const step = group.items[0] as ToolStepViewItem
  assert.equal(step.renderer, 'ask-user')
  assert.equal(step.summary.selectedLabel, 'Frontend')
})

test('live tool result attaches after the assistant tool call is persisted', () => {
  const display = useConversationDisplay({
    messages: ref([{
      id: 'msg_1', role: 'assistant', content: '', created_at: new Date(1000).toISOString(),
      tool_calls: [{ id: 'call_1', name: 'write_file', args: { path: 'src/app.ts', content: 'hello' } }],
    }]),
    events: ref([
      event('tool_call.started', { toolCallId: 'call_1', toolCallName: 'write_file' }, 1),
      event('tool_result.completed', {
        messageId: 'tool_msg_1', toolCallId: 'call_1', toolName: 'write_file',
        content: '{"path":"src/app.ts","bytes":5}', output: { path: 'src/app.ts', bytes: 5 },
        metadata: {
          approvals: [approvedOnce],
        },
      }, 2),
    ]),
    isRunning: ref(true), runtimeNow: ref(2000), runError: ref(''), pendingAsk: ref(null),
    pendingApproval: ref(null), processCollapsed: ref({}),
  })

  const group = display.displayItems.value.find(item => item.type === 'process-group')
  assert.ok(group && group.type === 'process-group')
  const step = group.items.find(item => item.kind === 'tool-step') as ToolStepViewItem
  assert.equal(step.renderer, 'file-change')
  assert.equal(step.outputRaw, JSON.stringify({ path: 'src/app.ts', bytes: 5 }, null, 2))
  assert.deepEqual(step.approvals, [approvedOnce])
  assert.deepEqual(step.state, { kind: 'approved', label: 'Allowed once' })
  assert.equal(step.executionStatus, 'completed')
})
