export type TauriInvoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>
export type TauriUnlisten = () => void

export type NativeAppWindow = {
  setTheme(theme?: 'light' | 'dark' | null): Promise<void>
  destroy(): Promise<void>
  onCloseRequested(handler: (event: { preventDefault(): void }) => void | Promise<void>): Promise<TauriUnlisten>
  onResized(handler: () => void): Promise<TauriUnlisten>
  isFullscreen(): Promise<boolean>
  isMaximized(): Promise<boolean>
}

type TauriGlobal = {
  core?: { invoke?: TauriInvoke }
  event?: {
    listen?: <T>(event: string, handler: (event: { payload: T }) => void) => Promise<TauriUnlisten>
  }
  window?: { getCurrentWindow?: () => NativeAppWindow }
}

declare global {
  interface Window {
    __TAURI__?: TauriGlobal
  }
}

function getTauriGlobal() {
  return typeof window === 'undefined' ? undefined : window.__TAURI__
}

export function isTauriAvailable() {
  return Boolean(getTauriGlobal()?.core?.invoke)
}

export function tauriInvoke<T>(command: string, args?: Record<string, unknown>) {
  const invoke = getTauriGlobal()?.core?.invoke
  if (!invoke) throw new Error('Tauri API is not available')
  return invoke<T>(command, args)
}

export function tauriListen<T>(event: string, handler: (payload: T) => void) {
  const listen = getTauriGlobal()?.event?.listen
  if (!listen) return Promise.resolve<TauriUnlisten>(() => undefined)
  return listen<T>(event, (value) => handler(value.payload))
}

export function getCurrentTauriWindow() {
  return getTauriGlobal()?.window?.getCurrentWindow?.() || null
}
