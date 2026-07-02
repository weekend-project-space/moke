<script setup lang="ts">
import type { PendingApproval } from '../types/conversation'

defineProps<{
  approval: PendingApproval
}>()

const emit = defineEmits<{
  approve: [payload: { decision: 'approved' | 'rejected'; scope?: 'once' | 'session' | 'persistent' }]
}>()

const text = {
  allowCommandOnce: '\u5141\u8bb8\u672c\u6b21',
  allowExternalPath: '\u5141\u8bb8\u8bbf\u95ee\u5916\u90e8\u76ee\u5f55\uff1f',
  allowSession: '\u672c\u4f1a\u8bdd\u5141\u8bb8',
  allowTool: '\u5141\u8bb8\u6267\u884c\u590d\u6742\u547d\u4ee4\uff1f',
  commandWillRun: '\u5c06\u6267\u884c\uff1a',
  editContent: '\u7f16\u8f91\u5185\u5bb9',
  externalPathReason: '\u539f\u56e0\uff1a\u8bbf\u95ee\u8303\u56f4\u8d85\u51fa\u5f53\u524d\u5de5\u4f5c\u533a',
  permanent: '\u6c38\u4e45\u5141\u8bb8',
  readFile: '\u8bfb\u53d6\u6587\u4ef6',
  reject: '\u62d2\u7edd',
  runCommand: '\u8fd0\u884c\u547d\u4ee4',
  unknownTool: '\u5f85\u786e\u8ba4\u64cd\u4f5c',
  writeFile: '\u5199\u5165\u6587\u4ef6',
}

function toolLabel(tool: string) {
  const labels: Record<string, string> = {
    apply_patch: text.editContent,
    execute: text.runCommand,
    exec_command: text.runCommand,
    read_file: text.readFile,
    write_file: text.writeFile,
  }

  return labels[tool] || tool || text.unknownTool
}

function isWorkspacePathApproval(approval: PendingApproval) {
  return approval.kind === 'workspace_path'
}

function title(approval: PendingApproval) {
  return isWorkspacePathApproval(approval) ? text.allowExternalPath : text.allowTool
}

function detail(approval: PendingApproval) {
  const tool = toolLabel(approval.action?.tool || '')
  if (isWorkspacePathApproval(approval)) return `${tool} \u8bf7\u6c42\u8bbf\u95ee\uff1a`
  return `${tool} ${text.commandWillRun}`
}

function targetText(approval: PendingApproval) {
  if (isWorkspacePathApproval(approval)) return approval.suggested_root || approval.path || ''

  const command = approval.action?.input?.command
  return typeof command === 'string' ? command : approval.reason
}

function reasonText(approval: PendingApproval) {
  if (isWorkspacePathApproval(approval)) return text.externalPathReason
  return approval.reason ? `\u539f\u56e0\uff1a${approval.reason}` : ''
}
</script>

<template>
  <section class="approval-inline" aria-live="polite">
    <div class="approval-inline-main">
      <div class="approval-inline-title">{{ title(approval) }}</div>
      <div class="approval-inline-detail">
        <span>{{ detail(approval) }}</span>
        <code v-if="targetText(approval)">{{ targetText(approval) }}</code>
      </div>
      <div v-if="reasonText(approval)" class="approval-inline-reason">{{ reasonText(approval) }}</div>
    </div>
    <menu>
      <template v-if="isWorkspacePathApproval(approval)">
        <button type="button" class="primary" @click="emit('approve', { decision: 'approved', scope: 'session' })">
          {{ text.allowSession }}
        </button>
        <button type="button" class="secondary" @click="emit('approve', { decision: 'approved', scope: 'persistent' })">
          {{ text.permanent }}
        </button>
      </template>
      <button v-else type="button" class="primary" @click="emit('approve', { decision: 'approved', scope: 'once' })">
        {{ text.allowCommandOnce }}
      </button>
      <button type="button" class="ghost" @click="emit('approve', { decision: 'rejected' })">{{ text.reject }}</button>
    </menu>
  </section>
</template>
