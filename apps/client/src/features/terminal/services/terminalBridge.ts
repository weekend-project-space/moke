import { isTauriAvailable, tauriInvoke, tauriListen, type TauriUnlisten } from '../../../services/tauri'

export type TerminalCreated = {
  sessionId: string
  shell: string
  cwd: string
  cols: number
  rows: number
}

export type TerminalOutputEvent = {
  sessionId: string
  dataBase64: string
}

export type TerminalExitEvent = {
  sessionId: string
  code?: number
}

export type TerminalErrorEvent = {
  sessionId?: string
  message: string
}

export function isTerminalAvailable() {
  return isTauriAvailable()
}

export function createTerminal(input: { cwd: string; shell?: string; cols: number; rows: number }) {
  return tauriInvoke<TerminalCreated>('terminal_create', input)
}

export function writeTerminal(sessionId: string, data: string) {
  return tauriInvoke<void>('terminal_write', { sessionId, data })
}

export function resizeTerminal(sessionId: string, cols: number, rows: number) {
  return tauriInvoke<void>('terminal_resize', { sessionId, cols, rows })
}

export function interruptTerminal(sessionId: string) {
  return tauriInvoke<void>('terminal_interrupt', { sessionId })
}

export function closeTerminal(sessionId: string) {
  return tauriInvoke<void>('terminal_close', { sessionId })
}

export function listenTerminalOutput(handler: (event: TerminalOutputEvent) => void): Promise<TauriUnlisten> {
  return tauriListen('terminal-output', handler)
}

export function listenTerminalExit(handler: (event: TerminalExitEvent) => void): Promise<TauriUnlisten> {
  return tauriListen('terminal-exit', handler)
}

export function listenTerminalError(handler: (event: TerminalErrorEvent) => void): Promise<TauriUnlisten> {
  return tauriListen('terminal-error', handler)
}
