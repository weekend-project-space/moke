import { open } from '@tauri-apps/plugin-dialog'

import type { ImageAttachment } from '../model/conversation'

type TauriInvoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>

type LocalImage = Omit<ImageAttachment, 'id' | 'kind'>

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

export async function pickLocalFiles(defaultPath?: string) {
  const selected = await open({
    defaultPath: defaultPath || undefined,
    directory: false,
    multiple: true,
    title: 'Select files',
  })
  if (typeof selected === 'string') return [selected]
  return Array.isArray(selected) ? selected : []
}

export function isSupportedImagePath(path: string) {
  return /\.(?:gif|jpe?g|png|webp)$/i.test(path)
}

export async function readLocalImage(path: string): Promise<LocalImage> {
  const invoke = (window.__TAURI__ as { core?: { invoke?: TauriInvoke } } | undefined)?.core?.invoke
  if (!invoke) throw new Error('Native image reader is unavailable')
  return await invoke('read_local_image', { path }) as LocalImage
}
