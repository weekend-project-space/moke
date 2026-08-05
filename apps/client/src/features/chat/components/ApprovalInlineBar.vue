<script setup lang="ts">
import type { PendingApproval } from '../model/conversation'
import { uiText } from '../../../text/uiText'

defineProps<{
  approval: PendingApproval
  submitting?: boolean
}>()

const emit = defineEmits<{
  approve: [payload: { decision: 'approved' | 'rejected'; scope?: 'once' | 'session' | 'persistent' }]
}>()

const text = {
  allowCommandOnce: uiText.approval.allowOnce,
  allowExternalPath: uiText.approval.allowExternalPath,
  allowMessage: uiText.approval.allowMessage,
  allowSession: uiText.approval.allowSession,
  allowTool: uiText.approval.allowTool,
  commandWillRun: uiText.approval.commandWillRun,
  editContent: uiText.approval.editContent,
  externalPathReason: uiText.approval.externalPathReason,
  messageContent: uiText.approval.messageContent,
  messageWillSend: uiText.approval.messageWillSend,
  mcpTool: uiText.approval.mcpTool,
  permanent: uiText.approval.permanent,
  readFile: uiText.approval.readFile,
  reject: uiText.approval.reject,
  requestAccess: uiText.approval.requestAccess,
  runCommand: uiText.approval.runCommand,
  sendMessage: uiText.approval.sendMessage,
  unknownTool: uiText.approval.unknownTool,
  writeFile: uiText.approval.writeFile,
}

function toolLabel(tool: string) {
  const labels: Record<string, string> = {
    apply_patch: text.editContent,
    execute: text.runCommand,
    exec_command: text.runCommand,
    read_file: text.readFile,
    send_message: text.sendMessage,
    write_file: text.writeFile,
  }

  if (tool.startsWith('mcp__')) return text.mcpTool
  return labels[tool] || tool || text.unknownTool
}

function isWorkspacePathApproval(approval: PendingApproval) {
  return approval.kind === 'workspace_path'
}

function title(approval: PendingApproval) {
  if (isWorkspacePathApproval(approval)) return text.allowExternalPath
  if (approval.action?.tool === 'send_message') return text.allowMessage
  return text.allowTool
}

function detail(approval: PendingApproval) {
  const tool = toolLabel(approval.action?.tool || '')
  if (isWorkspacePathApproval(approval)) return `${tool} ${text.requestAccess}`
  if (approval.action?.tool === 'send_message') return `${tool} ${text.messageWillSend}`
  return `${tool} ${text.commandWillRun}`
}

function targetText(approval: PendingApproval) {
  if (isWorkspacePathApproval(approval)) return approval.suggested_root || approval.path || ''

  if (approval.action?.tool === 'send_message') {
    const input = approval.action.input
    const conversation = recordValue(input.conversation)
    return [
      stringValue(input.platform),
      stringValue(input.connection_id) ? `connection ${stringValue(input.connection_id)}` : '',
      stringValue(conversation.type) && stringValue(conversation.id)
        ? `${stringValue(conversation.type)} ${stringValue(conversation.id)}`
        : stringValue(conversation.id),
      stringValue(input.binding_id) ? `binding ${stringValue(input.binding_id)}` : '',
    ].filter(Boolean).join(' | ')
  }

  const command = approval.action?.input?.command
  const workspace = approval.action?.input?.__moke_workspace
  if (typeof workspace === 'string') return workspace
  return typeof command === 'string' ? command : approval.reason
}

function reasonText(approval: PendingApproval) {
  if (isWorkspacePathApproval(approval)) return text.externalPathReason
  if (approval.action?.tool === 'send_message') {
    const input = approval.action.input
    const parts = [
      stringValue(input.text),
      countLabel(input.images, 'image'),
      countLabel(input.files, 'file'),
    ].filter(Boolean)
    return parts.length ? `${text.messageContent} ${parts.join(' | ')}` : ''
  }
  return approval.reason ? `Reason: ${approval.reason}` : ''
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function stringValue(value: unknown) {
  return typeof value === 'string' ? value : ''
}

function countLabel(value: unknown, label: string) {
  if (!Array.isArray(value) || value.length === 0) return ''
  return `${value.length} ${label}${value.length === 1 ? '' : 's'}`
}
</script>

<template>
  <section class="approval-inline" aria-live="polite">
    <div class="approval-inline-main">
      <div class="approval-inline-title">{{ title(approval) }}</div>
      <div class="approval-inline-detail">
        <span>{{ detail(approval) }}</span>
        <code v-if="targetText(approval)" :title="targetText(approval)">{{ targetText(approval) }}</code>
      </div>
      <div v-if="reasonText(approval)" class="approval-inline-reason" :title="reasonText(approval)">{{ reasonText(approval) }}</div>
    </div>
    <menu>
      <template v-if="isWorkspacePathApproval(approval)">
        <button type="button" class="primary" :disabled="submitting" @click="emit('approve', { decision: 'approved', scope: 'session' })">
          {{ text.allowSession }}
        </button>
        <button type="button" class="secondary" :disabled="submitting" @click="emit('approve', { decision: 'approved', scope: 'persistent' })">
          {{ text.permanent }}
        </button>
      </template>
      <button v-else type="button" class="primary" :disabled="submitting" @click="emit('approve', { decision: 'approved', scope: 'once' })">
        {{ text.allowCommandOnce }}
      </button>
      <button type="button" class="ghost" :disabled="submitting" @click="emit('approve', { decision: 'rejected' })">{{ text.reject }}</button>
    </menu>
  </section>
</template>
