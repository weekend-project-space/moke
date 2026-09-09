import { onBeforeUnmount, ref } from 'vue'
import {
  closeTerminal,
  createTerminal,
  interruptTerminal,
  isTerminalAvailable,
  listenTerminalError,
  listenTerminalExit,
  listenTerminalOutput,
  resizeTerminal,
  writeTerminal,
  type TerminalErrorEvent,
  type TerminalExitEvent,
} from '../services/terminalBridge'

export function useTerminal() {
  const sessionId = ref('')
  const shell = ref('')
  const cwd = ref('')
  const status = ref<'idle' | 'starting' | 'running' | 'exited' | 'error'>('idle')
  const exitCode = ref<number | undefined>()
  const errorMessage = ref('')
  let unlistenOutput: (() => void) | null = null
  let unlistenExit: (() => void) | null = null
  let unlistenError: (() => void) | null = null
  let outputDecoder = new TextDecoder()
  let writeQueue = Promise.resolve()

  function decodeOutput(dataBase64: string) {
    const binary = atob(dataBase64)
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
    return outputDecoder.decode(bytes, { stream: true })
  }

  function clearListeners() {
    unlistenOutput?.()
    unlistenExit?.()
    unlistenError?.()
    unlistenOutput = null
    unlistenExit = null
    unlistenError = null
  }

  function applyExit(event: TerminalExitEvent, onExit?: (code?: number) => void) {
    if (event.sessionId !== sessionId.value) return
    status.value = 'exited'
    exitCode.value = event.code
    onExit?.(event.code)
  }

  function applyError(event: TerminalErrorEvent) {
    if (event.sessionId && event.sessionId !== sessionId.value) return
    status.value = 'error'
    errorMessage.value = event.message
  }

  async function startTerminal(options: {
    cwd: string
    shell?: string
    cols: number
    rows: number
    onOutput: (data: string) => void
    onExit?: (code?: number) => void
  }) {
    if (!isTerminalAvailable()) {
      status.value = 'error'
      errorMessage.value = 'Terminal is only available in the Tauri desktop app.'
      return false
    }

    await closeCurrentTerminal()
    status.value = 'starting'
    errorMessage.value = ''
    exitCode.value = undefined
    outputDecoder = new TextDecoder()
    writeQueue = Promise.resolve()
    const pendingOutput: Array<{ sessionId: string; dataBase64: string }> = []
    const pendingExit: TerminalExitEvent[] = []
    const pendingErrors: TerminalErrorEvent[] = []
    try {
      unlistenOutput = await listenTerminalOutput((event) => {
        if (!sessionId.value) {
          pendingOutput.push(event)
          return
        }
        if (event.sessionId === sessionId.value) options.onOutput(decodeOutput(event.dataBase64))
      })
      unlistenExit = await listenTerminalExit((event) => {
        if (!sessionId.value) pendingExit.push(event)
        else applyExit(event, options.onExit)
      })
      unlistenError = await listenTerminalError((event) => {
        if (!sessionId.value) pendingErrors.push(event)
        else applyError(event)
      })
      const created = await createTerminal(options)
      sessionId.value = created.sessionId
      shell.value = created.shell
      cwd.value = created.cwd
      status.value = 'running'
      pendingOutput
        .filter((event) => event.sessionId === created.sessionId)
        .forEach((event) => options.onOutput(decodeOutput(event.dataBase64)))
      pendingErrors
        .filter((event) => !event.sessionId || event.sessionId === created.sessionId)
        .forEach(applyError)
      pendingExit
        .filter((event) => event.sessionId === created.sessionId)
        .forEach((event) => applyExit(event, options.onExit))
      return true
    } catch (error) {
      status.value = 'error'
      errorMessage.value = error instanceof Error ? error.message : String(error)
      clearListeners()
      return false
    }
  }

  function write(data: string) {
    if (!sessionId.value || status.value !== 'running') return
    const currentSessionId = sessionId.value
    writeQueue = writeQueue
      .then(() => writeTerminal(currentSessionId, data))
      .catch((error) => applyError({
        sessionId: currentSessionId,
        message: error instanceof Error ? error.message : String(error),
      }))
  }

  async function resize(cols: number, rows: number) {
    if (!sessionId.value || status.value !== 'running') return
    try {
      await resizeTerminal(sessionId.value, cols, rows)
    } catch (error) {
      applyError({ sessionId: sessionId.value, message: error instanceof Error ? error.message : String(error) })
    }
  }

  async function interrupt() {
    if (!sessionId.value || status.value !== 'running') return
    await interruptTerminal(sessionId.value).catch((error) => applyError({
      sessionId: sessionId.value,
      message: error instanceof Error ? error.message : String(error),
    }))
  }

  async function closeCurrentTerminal() {
    const currentSessionId = sessionId.value
    clearListeners()
    sessionId.value = ''
    writeQueue = Promise.resolve()
    if (!currentSessionId) return
    await closeTerminal(currentSessionId).catch(() => undefined)
    status.value = 'idle'
  }

  onBeforeUnmount(() => {
    void closeCurrentTerminal()
  })

  return {
    sessionId,
    shell,
    cwd,
    status,
    exitCode,
    errorMessage,
    startTerminal,
    write,
    resize,
    interrupt,
    closeCurrentTerminal,
  }
}
