<script setup lang="ts">
import type { PendingApproval } from '../types/conversation'

defineProps<{
  approval: PendingApproval
}>()

const emit = defineEmits<{
  approve: [payload: { decision: 'approved' | 'rejected'; scope?: 'once' | 'session' | 'persistent' }]
}>()

function toolLabel(tool: string) {
  const labels: Record<string, string> = {
    apply_patch: '编辑内容',
    execute: '运行命令',
    exec_command: '运行命令',
    read_file: '读取文件',
    write_file: '写入文件',
  }

  return labels[tool] || tool || '待确认操作'
}

function title(approval: PendingApproval) {
  return approval.kind === 'workspace_path' ? '允许访问外部目录？' : approval.reason || '需要确认后继续'
}

function detail(approval: PendingApproval) {
  const tool = toolLabel(approval.action?.tool || '')
  const target = approval.suggested_root || approval.path || ''
  if (approval.kind === 'workspace_path') return target ? `${tool} 请求访问：` : `${tool} 请求访问外部目录`
  return `${tool} 需要确认`
}

function targetPath(approval: PendingApproval) {
  return approval.suggested_root || approval.path || ''
}
</script>

<template>
  <section class="approval-inline" aria-live="polite">
    <div class="approval-inline-main">
      <div class="approval-inline-title">{{ title(approval) }}</div>
      <div class="approval-inline-detail">
        <span>{{ detail(approval) }}</span>
        <code v-if="targetPath(approval)">{{ targetPath(approval) }}</code>
      </div>
    </div>
    <menu>
      <button type="button" class="primary" @click="emit('approve', { decision: 'approved', scope: 'session' })">
        允许本会话
      </button>
      <button
        v-if="approval.kind === 'workspace_path'"
        type="button"
        class="secondary"
        @click="emit('approve', { decision: 'approved', scope: 'persistent' })"
      >
        永久允许
      </button>
      <button type="button" class="ghost" @click="emit('approve', { decision: 'rejected' })">拒绝</button>
    </menu>
  </section>
</template>
