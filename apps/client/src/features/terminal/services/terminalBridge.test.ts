import assert from 'node:assert/strict'
import test from 'node:test'

import {
  closeTerminal,
  createTerminal,
  interruptTerminal,
  resizeTerminal,
  writeTerminal,
} from './terminalBridge'

function installTauriInvoke(calls: Array<{ command: string; args?: Record<string, unknown> }>) {
  const originalWindow = globalThis.window
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      __TAURI__: {
        core: {
          async invoke(command: string, args?: Record<string, unknown>) {
            calls.push({ command, args })
            return command === 'terminal_create'
              ? { sessionId: 'terminal-1', shell: 'pwsh', cwd: 'E:\\workspace', cols: 100, rows: 30 }
              : undefined
          },
        },
      },
    },
  })
  return () => {
    if (originalWindow) Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow })
    else Reflect.deleteProperty(globalThis, 'window')
  }
}

test('terminal bridge maps lifecycle calls to typed Tauri commands', async () => {
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = []
  const restoreWindow = installTauriInvoke(calls)
  try {
    const terminal = await createTerminal({ cwd: 'E:\\workspace', cols: 100, rows: 30 })
    await writeTerminal(terminal.sessionId, 'git status\r')
    await resizeTerminal(terminal.sessionId, 120, 40)
    await interruptTerminal(terminal.sessionId)
    await closeTerminal(terminal.sessionId)
    assert.equal(terminal.sessionId, 'terminal-1')
    assert.deepEqual(calls, [
      { command: 'terminal_create', args: { cwd: 'E:\\workspace', cols: 100, rows: 30 } },
      { command: 'terminal_write', args: { sessionId: 'terminal-1', data: 'git status\r' } },
      { command: 'terminal_resize', args: { sessionId: 'terminal-1', cols: 120, rows: 40 } },
      { command: 'terminal_interrupt', args: { sessionId: 'terminal-1' } },
      { command: 'terminal_close', args: { sessionId: 'terminal-1' } },
    ])
  } finally {
    restoreWindow()
  }
})
