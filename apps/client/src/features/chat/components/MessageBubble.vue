<script setup lang="ts">
import { apiUrl } from '../../../services/apiAccess'
import { ArrowRight, Check, Copy, FileText, GitBranchPlus } from 'lucide-vue-next'
import type { Message, MessageImageAttachment } from '../model/conversation'
import { formatSessionTime } from '../presentation/timeFormat'
import { uiText } from '../../../text/uiText'

const props = defineProps<{
  apiBase: string
  copiedKey: string
  id: string
  message: Message
  renderMarkdown: (content: string) => string
  showContinue?: boolean
}>()

function attachmentSrc(attachment: MessageImageAttachment) {
  if ('data_url' in attachment) return attachment.data_url
  return apiUrl(`${props.apiBase}/api/attachments/${encodeURIComponent(attachment.sha256)}`)
}

const emit = defineEmits<{
  copy: [payload: { key: string; content: string }]
  continue: []
  fork: [messageId: string]
}>()
</script>

<template>
  <article class="message-row" :class="message.role">
    <template v-if="message.role === 'user'">
      <div v-if="message.attachments?.length" class="user-attachments">
        <img
          v-for="attachment in message.attachments"
          :key="attachment.id"
          :src="attachmentSrc(attachment)"
          :alt="attachment.name || uiText.composer.imageAttachment"
          loading="lazy"
          decoding="async"
        />
      </div>
      <div v-if="message.files?.length" class="user-files">
        <div v-for="file in message.files" :key="file.id" class="user-file" :title="file.name">
          <FileText :size="15" stroke-width="1.9" />
          <span>{{ file.name }}</span>
        </div>
      </div>
      <div v-if="message.content" class="bubble user">
        <span>{{ message.content }}</span>
      </div>
    </template>
    <div v-else class="bubble" :class="message.role">
      <div class="markdown" v-html="renderMarkdown(message.content)"></div>
    </div>
    <div v-if="message.role === 'assistant'" class="message-actions">
      <button
        v-if="message.role === 'assistant'"
        class="message-action"
        type="button"
        :aria-label="copiedKey === id ? uiText.message.copied : uiText.message.copyContent"
        :title="copiedKey === id ? uiText.message.copied : uiText.message.copyContent"
        @click="emit('copy', { key: id, content: message.content })"
      >
        <Check v-if="copiedKey === id" :size="14" stroke-width="2.2" />
        <Copy v-else :size="14" stroke-width="2.2" />
      </button>
      <button
        v-if="message.id"
        class="message-action"
        type="button"
        :aria-label="uiText.message.forkChat"
        :title="uiText.message.forkChat"
        @click="emit('fork', message.id)"
      >
        <GitBranchPlus :size="14" stroke-width="2.2" />
      </button>
      <button
        v-if="showContinue"
        class="message-action"
        type="button"
        :aria-label="uiText.message.continue"
        :title="uiText.message.continue"
        @click="emit('continue')"
      >
        <ArrowRight :size="14" stroke-width="2.2" />
      </button>
      <time v-if="message.created_at" class="message-action-time" :datetime="message.created_at">
        {{ formatSessionTime(message.created_at) }}
      </time>
    </div>
  </article>
</template>
