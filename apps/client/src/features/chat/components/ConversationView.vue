<script setup lang="ts">
import DOMPurify from 'dompurify'
import MarkdownIt from 'markdown-it'
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import MessageBubble from './MessageBubble.vue'
import ProcessDetails from './ProcessDetails.vue'
import { conversationScrollState, conversationTurnSpacerHeight } from '../presentation/conversationScroll'
import type { DisplayItem, TaskTemplate } from '../presentation/types'
import { uiText } from '../../../text/uiText'

const props = defineProps<{
  apiBase: string
  copiedKey: string
  displayItems: DisplayItem[]
  sessionKey: string
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
const contentEl = ref<HTMLElement | null>(null)
const turnSpacerEl = ref<HTMLElement | null>(null)
let anchoredUserId = ''
let anchorFrame: number | undefined
let followLatest = true
let isJumpingToBottom = false
let lastScrollHeight = 0
let lastScrollTop = 0
let pendingScrollForce = false
let disposed = false
let lastJumpVisibility: boolean | undefined
let resizeObserver: ResizeObserver | undefined
let scrollFrame: number | undefined
let scrollScheduled = false
let turnSpacerHeight = 0
let userScrollIntent = false
const lastAssistantDisplayItemId = computed(() => {
  for (let index = props.displayItems.length - 1; index >= 0; index -= 1) {
    const item = props.displayItems[index]
    if (item.type === 'message' && item.message.role === 'assistant') return item.id
  }

  return ''
})
const lastUserDisplayItemId = computed(() => {
  for (let index = props.displayItems.length - 1; index >= 0; index -= 1) {
    const item = props.displayItems[index]
    if (item.type === 'message' && item.message.role === 'user') return item.id
  }

  return ''
})
const streamsBeforeActiveProcess = computed(() => props.displayItems.some(
  (item) => item.type === 'process-group' && Boolean(item.isActive) && !item.items.some(processItem => processItem.kind === 'assistant'),
))
const liveTextRenderedInProcess = computed(() => props.displayItems.some(
  (item) => item.type === 'process-group' && item.isActive && item.items.some(processItem => processItem.kind === 'assistant'),
))

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
  if (!el || (!force && !followLatest)) return

  if (force) followLatest = true
  el.scrollTop = el.scrollHeight
  lastScrollTop = el.scrollTop
  lastScrollHeight = el.scrollHeight
  emitJumpVisibility(false)
}

function setTurnSpacerHeight(height: number) {
  const nextHeight = Math.max(0, Math.ceil(height))
  if (nextHeight === turnSpacerHeight) return
  turnSpacerHeight = nextHeight
  if (turnSpacerEl.value) turnSpacerEl.value.style.height = `${nextHeight}px`
}

function clearTurnAnchor() {
  anchoredUserId = ''
  setTurnSpacerHeight(0)
}

function updateTurnAnchor() {
  const el = conversationEl.value
  const content = contentEl.value
  if (!el || !content || !anchoredUserId) return false

  const anchor = content.querySelector<HTMLElement>(`[data-display-item-id="${CSS.escape(anchoredUserId)}"]`)
  if (!anchor) return false

  const topInset = Number.parseFloat(getComputedStyle(el).paddingTop) || 0
  const anchorScrollTop = Math.max(0, el.scrollTop + anchor.getBoundingClientRect().top - el.getBoundingClientRect().top - topInset)
  setTurnSpacerHeight(conversationTurnSpacerHeight({
    anchorScrollTop,
    clientHeight: el.clientHeight,
    currentSpacerHeight: turnSpacerHeight,
    scrollHeight: el.scrollHeight,
  }))
  el.scrollTo({ top: anchorScrollTop, behavior: 'auto' })
  lastScrollTop = el.scrollTop
  lastScrollHeight = el.scrollHeight
  return true
}

function scheduleTurnAnchor(id: string) {
  anchoredUserId = id
  followLatest = false
  userScrollIntent = false
  if (anchorFrame !== undefined) window.cancelAnimationFrame(anchorFrame)

  void nextTick(() => {
    anchorFrame = window.requestAnimationFrame(() => {
      anchorFrame = undefined
      if (!updateTurnAnchor()) {
        clearTurnAnchor()
        return
      }
      emitJumpVisibility(false)
    })
  })
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

function scheduleLatestUserPosition() {
  const userId = lastUserDisplayItemId.value
  if (userId) scheduleTurnAnchor(userId)
  else scheduleScrollToBottom(true)
}

function resetScrollState() {
  clearTurnAnchor()
  followLatest = true
  isJumpingToBottom = false
  lastScrollTop = 0
  lastScrollHeight = 0
  emitJumpVisibility(false)
}

function updateScrollState() {
  const el = conversationEl.value
  if (!el) return null

  const state = conversationScrollState(el)
  emitJumpVisibility(state.showJumpToBottom)
  return state
}

function handleConversationScroll() {
  const el = conversationEl.value
  if (!el) return

  if (!anchoredUserId && el.scrollHeight === lastScrollHeight && el.scrollTop < lastScrollTop) {
    followLatest = false
  }
  const state = updateScrollState()
  if (anchoredUserId) {
    followLatest = false
    if (userScrollIntent) scheduleTurnAnchor(anchoredUserId)
  } else if (state?.isAtBottom) {
    followLatest = true
    isJumpingToBottom = false
  }
  lastScrollTop = el.scrollTop
  lastScrollHeight = el.scrollHeight
}

function cancelJumpToBottom() {
  if (!isJumpingToBottom) return
  isJumpingToBottom = false
  const el = conversationEl.value
  if (el) el.scrollTo({ top: el.scrollTop, behavior: 'auto' })
}

function handleScrollIntent() {
  userScrollIntent = true
  cancelJumpToBottom()
}

function handleConversationScrollEnd() {
  if (!isJumpingToBottom) return
  const state = updateScrollState()
  if (state?.isAtBottom) {
    isJumpingToBottom = false
    return
  }

  conversationEl.value?.scrollTo({
    top: conversationEl.value.scrollHeight,
    behavior: 'smooth',
  })
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
  const el = conversationEl.value
  if (!el) return

  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    resetScrollState()
    scrollToBottom(true)
    return
  }

  clearTurnAnchor()
  followLatest = true
  isJumpingToBottom = true
  el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
}

function emitJumpVisibility(visible: boolean) {
  if (lastJumpVisibility === visible) return
  lastJumpVisibility = visible
  emit('jumpVisibilityChange', visible)
}

function handleContentResize() {
  if (anchoredUserId) {
    if (!updateTurnAnchor()) clearTurnAnchor()
    updateScrollState()
  } else if (followLatest) scheduleScrollToBottom()
  else updateScrollState()
}

function shouldShowProcessDivider(item: DisplayItem, index: number) {
  if (item.type !== 'process-group') return false

  const nextItem = props.displayItems.slice(index + 1).find((candidate) => candidate.type !== 'time')
  if (nextItem?.type === 'message' && nextItem.message.role === 'assistant') return true

  return !nextItem && Boolean(props.streamingText)
}

watch(
  [() => props.sessionKey, lastUserDisplayItemId],
  ([sessionKey], previous) => {
    if (sessionKey !== previous?.[0]) resetScrollState()
    scheduleLatestUserPosition()
  },
)

onMounted(() => {
  emitJumpVisibility(false)
  resizeObserver = new ResizeObserver(handleContentResize)
  if (contentEl.value) resizeObserver.observe(contentEl.value)
  if (conversationEl.value) {
    resizeObserver.observe(conversationEl.value)
    lastScrollTop = conversationEl.value.scrollTop
    lastScrollHeight = conversationEl.value.scrollHeight
  }
  scheduleLatestUserPosition()
})

onUnmounted(() => {
  disposed = true
  resizeObserver?.disconnect()
  if (anchorFrame !== undefined) window.cancelAnimationFrame(anchorFrame)
  if (scrollFrame !== undefined) window.cancelAnimationFrame(scrollFrame)
  emit('jumpVisibilityChange', false)
})

defineExpose({
  jumpToBottom,
})
</script>

<template>
  <div
    ref="conversationEl"
    class="conversation"
    @click="handleConversationClick"
    @pointerdown.passive="handleScrollIntent"
    @scroll.passive="handleConversationScroll"
    @scrollend="handleConversationScrollEnd"
    @touchstart.passive="handleScrollIntent"
    @wheel.passive="handleScrollIntent"
  >
    <div ref="contentEl" class="conversation-content">
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

    <div v-if="streamingText && streamsBeforeActiveProcess" class="message-row assistant">
      <article class="bubble assistant">
        <div class="markdown streaming" :class="{ active: props.isRunning }" v-html="renderMarkdown(streamingText)"></div>
      </article>
    </div>

    <template v-for="(item, index) in displayItems" :key="item.id">
      <div v-if="item.type === 'time'" class="timeline-note time-note">{{ item.label }}</div>
      <ProcessDetails
        v-else-if="item.type === 'process-group'"
        :label="item.label"
        :duration-label="item.durationLabel"
        :items="item.items"
        :collapsed="item.collapsed"
        :has-error="item.hasError"
        :is-active="item.isActive"
        :render-markdown="renderMarkdown"
        :show-result-divider="shouldShowProcessDivider(item, index)"
        @toggle="emit('toggleProcessGroup', item.id)"
      />
      <MessageBubble
        v-else
        :api-base="apiBase"
        :id="item.id"
        :data-display-item-id="item.id"
        :message="item.message"
        :copied-key="copiedKey"
        :render-markdown="renderMarkdown"
        :show-continue="showLastMessageContinue && item.id === lastAssistantDisplayItemId"
        @copy="emit('copyMessage', $event)"
        @fork="emit('forkMessage', $event)"
        @continue="emit('applySuggestion', uiText.chat.continuePrompt)"
      />
    </template>

    <div v-if="streamingText && !streamsBeforeActiveProcess && !liveTextRenderedInProcess" class="message-row assistant">
      <article class="bubble assistant">
        <div class="markdown streaming" :class="{ active: props.isRunning }" v-html="renderMarkdown(streamingText)"></div>
      </article>
    </div>
    <div v-else-if="showThinking" class="message-row assistant">
      <article class="bubble assistant thinking" :aria-label="uiText.chat.thinking">
        <span class="thinking-label live-text-sweep">{{ uiText.chat.thinkingLabel }}</span>
      </article>
    </div>
    </div>
    <div ref="turnSpacerEl" class="conversation-turn-spacer" aria-hidden="true"></div>
  </div>
</template>
