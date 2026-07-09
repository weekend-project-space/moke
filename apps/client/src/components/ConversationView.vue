<script setup lang="ts">
import DOMPurify from 'dompurify'
import MarkdownIt from 'markdown-it'
import { computed, nextTick, onUnmounted, ref, watch } from 'vue'
import MessageBubble from './MessageBubble.vue'
import ProcessGroup from './ProcessGroup.vue'
import type { DisplayItem, TaskTemplate } from '../types/conversation'
import { uiText } from '../text/uiText'

const props = defineProps<{
  copiedKey: string
  displayItems: DisplayItem[]
  scrollKey: string
  showEmptyState: boolean
  isRunning: boolean
  showLastMessageContinue: boolean
  showThinking: boolean
  streamingText: string
  taskTemplates: TaskTemplate[]
  timelineNote: string
}>()

const emit = defineEmits<{
  applySuggestion: [prompt: string]
  copyMessage: [payload: { key: string; content: string }]
  forkMessage: [messageId: string]
  jumpVisibilityChange: [visible: boolean]
  openLink: [url: string]
  toggleProcessGroup: [id: string]
}>()

const conversationEl = ref<HTMLElement | null>(null)
const autoScroll = ref(true)
const showJumpToBottom = ref(false)
let pendingScrollForce = false
let disposed = false
let scrollFrame: number | undefined
let scrollScheduled = false
const lastAssistantDisplayItemId = computed(() => {
  for (let index = props.displayItems.length - 1; index >= 0; index -= 1) {
    const item = props.displayItems[index]
    if (item.type === 'message' && item.message.role === 'assistant') return item.id
  }

  return ''
})

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

markdown.renderer.rules.fence = (tokens, index, options) => {
  const token = tokens[index]
  const info = token.info ? token.info.trim().split(/\s+/)[0] : ''
  const lang = info || 'text'
  const highlighted = options.highlight
    ? options.highlight(token.content, info, '')
    : ''
  const code = highlighted || markdown.utils.escapeHtml(token.content)
  const encoded = encodeURIComponent(token.content)
  const langLabel = markdown.utils.escapeHtml(lang)

  return `<figure class="code-block"><figcaption><span>${langLabel}</span><button type="button" data-code-copy="${encoded}" aria-label="${uiText.message.copyCode}" title="${uiText.message.copyCode}"></button></figcaption><pre><code class="language-${langLabel}">${code}</code></pre></figure>`
}

function renderMarkdown(content: string) {
  return DOMPurify.sanitize(markdown.render(content), {
    ADD_ATTR: ['data-code-copy'],
  })
}

async function copyCodeBlock(encoded: string) {
  const code = decodeURIComponent(encoded)
  try {
    await navigator.clipboard.writeText(code)
  } catch {
    const helper = document.createElement('textarea')
    helper.value = code
    document.body.appendChild(helper)
    helper.select()
    document.execCommand('copy')
    helper.remove()
  }
}

function scrollToBottom(force = false) {
  const el = conversationEl.value
  if (!el || (!force && !autoScroll.value)) return

  el.scrollTop = el.scrollHeight
  setJumpToBottomVisible(false)
}

function scheduleScrollToBottom(force = false) {
  pendingScrollForce = pendingScrollForce || force
  if (scrollScheduled) return

  scrollScheduled = true
  void nextTick(() => {
    if (disposed) return
    scrollFrame = window.requestAnimationFrame(() => {
      if (disposed) return
      const shouldForce = pendingScrollForce
      pendingScrollForce = false
      scrollFrame = undefined
      scrollScheduled = false
      scrollToBottom(shouldForce)
    })
  })
}

function resetAutoScroll() {
  autoScroll.value = true
  setJumpToBottomVisible(false)
}

function handleConversationScroll() {
  const el = conversationEl.value
  if (!el) return

  autoScroll.value = el.scrollHeight - el.scrollTop - el.clientHeight < 48
  if (autoScroll.value) setJumpToBottomVisible(false)
}

function handleConversationClick(event: MouseEvent) {
  const target = event.target
  if (!(target instanceof Element)) return

  const copyButton = target.closest<HTMLButtonElement>('button[data-code-copy]')
  if (copyButton?.dataset.codeCopy) {
    event.preventDefault()
    void copyCodeBlock(copyButton.dataset.codeCopy)
    return
  }

  const link = target.closest<HTMLAnchorElement>('a[href]')
  if (!link) return

  const url = link.href || link.dataset.browserUrl
  if (!url) return

  event.preventDefault()
  emit('openLink', url)
}

function jumpToBottom() {
  resetAutoScroll()
  scheduleScrollToBottom(true)
}

function setJumpToBottomVisible(visible: boolean) {
  if (showJumpToBottom.value === visible) return
  showJumpToBottom.value = visible
  emit('jumpVisibilityChange', visible)
}

function shouldShowProcessDivider(item: DisplayItem, index: number) {
  if (item.type !== 'process-group') return false

  const nextItem = props.displayItems.slice(index + 1).find((candidate) => candidate.type !== 'time')
  if (nextItem?.type === 'message' && nextItem.message.role === 'assistant') return true

  return !nextItem && Boolean(props.streamingText)
}

watch(
  () => props.scrollKey,
  () => {
    if (!autoScroll.value) setJumpToBottomVisible(true)
    scheduleScrollToBottom()
  },
)

onUnmounted(() => {
  disposed = true
  if (scrollFrame !== undefined) window.cancelAnimationFrame(scrollFrame)
})

defineExpose({
  jumpToBottom,
  resetAutoScroll,
  scrollToBottom,
})
</script>

<template>
  <div class="conversation" ref="conversationEl" @scroll.passive="handleConversationScroll" @click="handleConversationClick">
    <div v-if="timelineNote" class="timeline-note">{{ timelineNote }}</div>

    <div v-if="showEmptyState" class="empty-state">
      <h3>{{ uiText.chat.emptyTitle }}</h3>
      <p>{{ uiText.chat.emptyDescription }}</p>
      <div class="suggestion-grid">
        <button v-for="template in taskTemplates" :key="template.title" type="button" @click="emit('applySuggestion', template.prompt)">
          <span>{{ template.title }}</span>
        </button>
      </div>
    </div>

    <template v-for="(item, index) in displayItems" :key="item.id">
      <div v-if="item.type === 'time'" class="timeline-note time-note">{{ item.label }}</div>
      <ProcessGroup
        v-else-if="item.type === 'process-group'"
        :label="item.label"
        :items="item.items"
        :collapsed="item.collapsed"
        :has-error="item.hasError"
        :is-active="item.isActive"
        :render-markdown="renderMarkdown"
        @toggle="emit('toggleProcessGroup', item.id)"
      />
      <MessageBubble
        v-else
        :id="item.id"
        :message="item.message"
        :copied-key="copiedKey"
        :render-markdown="renderMarkdown"
        :show-continue="showLastMessageContinue && item.id === lastAssistantDisplayItemId"
        @copy="emit('copyMessage', $event)"
        @fork="emit('forkMessage', $event)"
        @continue="emit('applySuggestion', uiText.chat.continuePrompt)"
      />
      <div v-if="shouldShowProcessDivider(item, index)" class="process-result-divider" aria-hidden="true"></div>
    </template>

    <div v-if="streamingText" class="message-row assistant">
      <article class="bubble assistant">
        <div class="markdown streaming" v-html="renderMarkdown(streamingText)"></div>
      </article>
    </div>
    <div v-else-if="showThinking" class="message-row assistant">
      <article class="bubble assistant thinking" :aria-label="uiText.chat.thinking">
        <span class="dot"></span>
        <span class="dot"></span>
        <span class="dot"></span>
      </article>
    </div>
  </div>
</template>
