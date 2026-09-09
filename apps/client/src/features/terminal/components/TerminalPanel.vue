<script setup lang="ts">
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useTerminal } from '../composables/useTerminal'

const props = defineProps<{
  active: boolean
  cwd: string
}>()

const emit = defineEmits<{ close: [] }>()
const terminalElement = ref<HTMLElement | null>(null)
const terminal = ref<Terminal | null>(null)
const fitAddon = new FitAddon()
const resizeObserver = ref<ResizeObserver | null>(null)
let themeObserver: MutationObserver | null = null
let resizeFrame = 0
let lastSize = ''
const {
  sessionId,
  errorMessage,
  startTerminal,
  write,
  resize,
} = useTerminal()

function readThemeColor(name: string, fallback: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback
}

function terminalTheme() {
  return {
    background: readThemeColor('--color-bg-content', '#17191c'),
    foreground: readThemeColor('--color-cli-fg', '#f1f2f3'),
    cursor: readThemeColor('--color-cli-cursor', '#8bc5ff'),
    selectionBackground: readThemeColor('--color-cli-selection', '#35516d'),
  }
}

function fitAndResize() {
  if (!terminal.value) return
  fitAddon.fit()
  const size = `${terminal.value.cols}x${terminal.value.rows}`
  if (size === lastSize) return
  lastSize = size
  void resize(terminal.value.cols, terminal.value.rows)
}

function scheduleFitAndResize() {
  window.cancelAnimationFrame(resizeFrame)
  resizeFrame = window.requestAnimationFrame(fitAndResize)
}

async function start() {
  if (!terminal.value || !props.cwd) return
  if (sessionId.value) {
    await nextTick()
    scheduleFitAndResize()
    terminal.value.focus()
    return
  }
  terminal.value.reset()
  const started = await startTerminal({
    cwd: props.cwd,
    cols: terminal.value.cols || 100,
    rows: terminal.value.rows || 30,
    onOutput: (data) => terminal.value?.write(data),
    onExit: () => emit('close'),
  })
  if (started) {
    await nextTick()
    scheduleFitAndResize()
    terminal.value.focus()
  }
}

watch(() => props.active, (active) => {
  if (active) void start()
})

onMounted(() => {
  const instance = new Terminal({
    convertEol: true,
    cursorBlink: true,
    fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
    fontSize: 12,
    scrollback: 5000,
    theme: terminalTheme(),
  })
  terminal.value = instance
  instance.loadAddon(fitAddon)
  instance.open(terminalElement.value!)
  themeObserver = new MutationObserver(() => {
    instance.options.theme = terminalTheme()
  })
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
  instance.onData((data) => void write(data))
  resizeObserver.value = new ResizeObserver(scheduleFitAndResize)
  if (terminalElement.value) resizeObserver.value.observe(terminalElement.value)
  if (props.active) void start()
})

onUnmounted(() => {
  resizeObserver.value?.disconnect()
  themeObserver?.disconnect()
  themeObserver = null
  window.cancelAnimationFrame(resizeFrame)
  terminal.value?.dispose()
})
</script>

<template>
  <section class="terminal-panel" aria-label="Terminal">
    <div ref="terminalElement" class="terminal-viewport"></div>
    <div v-if="errorMessage" class="terminal-error" role="alert">{{ errorMessage }}</div>
  </section>
</template>
