<script setup lang="ts">
import { ArrowRight, Check, Copy, GitBranchPlus } from 'lucide-vue-next'
import type { Message } from '../types/conversation'
import { uiText } from '../text/uiText'

defineProps<{
  copiedKey: string
  id: string
  message: Message
  renderMarkdown: (content: string) => string
  showContinue?: boolean
}>()

const emit = defineEmits<{
  copy: [payload: { key: string; content: string }]
  continue: []
  fork: [messageId: string]
}>()
</script>

<template>
  <article class="message-row" :class="message.role">
    <div class="bubble" :class="message.role">
      <div v-if="message.attachments?.length" class="message-attachments">
        <img
          v-for="attachment in message.attachments"
          :key="attachment.id"
          :src="attachment.data_url"
          :alt="attachment.name || uiText.composer.imageAttachment"
        />
      </div>
      <div v-if="message.role === 'assistant'" class="markdown" v-html="renderMarkdown(message.content)"></div>
      <template v-else>
        <span v-if="message.content">{{ message.content }}</span>
      </template>
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
    </div>
  </article>
</template>
