<script setup lang="ts">
import { Check, Copy } from 'lucide-vue-next'
import type { Message } from '../types/conversation'

defineProps<{
  copiedKey: string
  id: string
  message: Message
  renderMarkdown: (content: string) => string
}>()

const emit = defineEmits<{
  copy: [payload: { key: string; content: string }]
}>()
</script>

<template>
  <article class="message-row" :class="message.role">
    <div class="bubble" :class="message.role">
      <div v-if="message.role === 'assistant'" class="markdown" v-html="renderMarkdown(message.content)"></div>
      <template v-else>{{ message.content }}</template>
    </div>
    <button
      v-if="message.role === 'assistant'"
      class="copy-button"
      type="button"
      :aria-label="copiedKey === id ? '已复制' : '复制内容'"
      :title="copiedKey === id ? '已复制' : '复制内容'"
      @click="emit('copy', { key: id, content: message.content })"
    >
      <Check v-if="copiedKey === id" :size="14" stroke-width="2.2" />
      <Copy v-else :size="14" stroke-width="2.2" />
    </button>
  </article>
</template>
