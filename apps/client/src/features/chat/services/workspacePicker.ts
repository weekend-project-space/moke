import { open } from '@tauri-apps/plugin-dialog'

export function isNativeWorkspacePickerAvailable() {
  return typeof window !== 'undefined' && Boolean(window.__TAURI__?.core?.invoke)
}

export async function pickWorkspaceDirectory(defaultPath?: string) {
  const selected = await open({
    defaultPath: defaultPath || undefined,
    directory: true,
    multiple: false,
    title: 'Select workspace',
  })
  return typeof selected === 'string' ? selected : null
}
