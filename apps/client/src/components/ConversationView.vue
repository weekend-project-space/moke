<script setup lang="ts">
import DOMPurify from 'dompurify'
import { Copy, RotateCcw } from 'lucide-vue-next'
import MarkdownIt from 'markdown-it'
import { nextTick, ref, watch } from 'vue'
import MessageBubble from './MessageBubble.vue'
import ProcessGroup from './ProcessGroup.vue'
import type { DisplayItem, TaskTemplate } from '../types/conversation'

const props = defineProps<{
  copiedKey: string
  displayItems: DisplayItem[]
  lastAssistantContent: string
  scrollKey: string
  showEmptyState: boolean
  showResultActions: boolean
  showThinking: boolean
  streamingText: string
  taskTemplates: TaskTemplate[]
  timelineNote: string
}>()

const emit = defineEmits<{
  applySuggestion: [prompt: string]
  copyMessage: [payload: { key: string; content: string }]
  openLink: [url: string]
  toggleProcessGroup: [id: string]
}>()

const conversationEl = ref<HTMLElement | null>(null)
const autoScroll = ref(true)
const showJumpToBottom = ref(false)

const markdown = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
})

const defaultLinkOpen =
  markdown.renderer.rules.link_open ||
  ((tokens, index, options, _env, self) => self.renderToken(tokens, index, options))

markdown.renderer.rules.link_open = (tokens, index, options, env, self) => {
  const token = tokens[index]
  const href = token.attrGet('href')
  if (href) token.attrSet('data-browser-url', href)
  token.attrSet('target', '_self')
  token.attrSet('rel', 'noreferrer')
  return defaultLinkOpen(tokens, index, options, env, self)
}

function renderMarkdown(content: string) {
  return DOMPurify.sanitize(markdown.render(content))
}

function scrollToBottom(force = false) {
  const el = conversationEl.value
  if (!el || (!force && !autoScroll.value)) return

  el.scrollTop = el.scrollHeight
  showJumpToBottom.value = false
}

function resetAutoScroll() {
  autoScroll.value = true
  showJumpToBottom.value = false
}

function handleConversationScroll() {
  const el = conversationEl.value
  if (!el) return

  autoScroll.value = el.scrollHeight - el.scrollTop - el.clientHeight < 48
  if (autoScroll.value) showJumpToBottom.value = false
}

function handleConversationClick(event: MouseEvent) {
  const target = event.target
  if (!(target instanceof Element)) return

  const link = target.closest<HTMLAnchorElement>('a[data-browser-url]')
  if (!link) return

  const url = link.dataset.browserUrl || link.href
  if (!url) return

  event.preventDefault()
  emit('openLink', url)
}

function jumpToBottom() {
  resetAutoScroll()
  void nextTick(() => scrollToBottom(true))
}

watch(
  () => props.scrollKey,
  () => {
    if (!autoScroll.value) showJumpToBottom.value = true
    void nextTick(() => scrollToBottom())
  },
)

defineExpose({
  resetAutoScroll,
  scrollToBottom,
})
</script>

<template>
  <div class="conversation" ref="conversationEl" @scroll.passive="handleConversationScroll" @click="handleConversationClick">
    <div v-if="timelineNote" class="timeline-note">{{ timelineNote }}</div>

    <div v-if="showEmptyState" class="empty-state">
      <h3>想让 Moke 帮你做什么？</h3>
      <div class="suggestion-grid">
        <button v-for="template in taskTemplates" :key="template.title" type="button" @click="emit('applySuggestion', template.prompt)">
          <span>{{ template.title }}</span>
          <small>{{ template.description }}</small>
        </button>
      </div>
    </div>

    <template v-for="item in displayItems" :key="item.id">
      <div v-if="item.type === 'time'" class="timeline-note time-note">{{ item.label }}</div>
      <ProcessGroup
        v-else-if="item.type === 'process-group'"
        :label="item.label"
        :items="item.items"
        :collapsed="item.collapsed"
        :has-error="item.hasError"
        :render-markdown="renderMarkdown"
        @toggle="emit('toggleProcessGroup', item.id)"
      />
      <MessageBubble
        v-else
        :id="item.id"
        :message="item.message"
        :copied-key="copiedKey"
        :render-markdown="renderMarkdown"
        @copy="emit('copyMessage', $event)"
      />
    </template>

    <div v-if="streamingText" class="message-row assistant">
      <article class="bubble assistant">
        <div class="markdown streaming" v-html="renderMarkdown(streamingText)"></div>
      </article>
    </div>
    <div v-else-if="showThinking" class="message-row assistant">
      <article class="bubble assistant thinking" aria-label="Moke 正在思考">
        <span class="dot"></span>
        <span class="dot"></span>
        <span class="dot"></span>
      </article>
    </div>
    <div v-if="showResultActions" class="result-actions">
      <button type="button" @click="emit('copyMessage', { key: 'latest-result', content: lastAssistantContent })">
        <Copy :size="14" stroke-width="2.2" />
        {{ copiedKey === 'latest-result' ? '已复制' : '复制结果' }}
      </button>
      <button type="button" @click="emit('applySuggestion', '基于上面的结果，继续帮我整理成更清晰的下一步。')">
        <RotateCcw :size="14" stroke-width="2.2" />
        继续整理
      </button>
    </div>
  </div>

  <button v-if="showJumpToBottom" class="jump-bottom" type="button" @click="jumpToBottom">
    跳到底部
  </button>
</template>
