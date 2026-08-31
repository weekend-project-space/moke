import { open } from '@tauri-apps/plugin-dialog'

import type { ImageAttachment } from '../model/conversation'
import { isTauriAvailable, tauriInvoke } from '../../../services/tauri'

type LocalImage = Omit<ImageAttachment, 'id' | 'kind'>

export function isNativeWorkspacePickerAvailable() {
  return isTauriAvailable()
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

export async function pickSkillFile(defaultPath?: string) {
  const selected = await open({
    defaultPath: defaultPath || undefined,
    directory: false,
    multiple: false,
    filters: [{ name: 'Skill file', extensions: ['md'] }],
    title: 'Select SKILL.md',
  })
  return typeof selected === 'string' ? selected : null
}

export function isSupportedImagePath(path: string) {
  return /\.(?:gif|jpe?g|png|webp)$/i.test(path)
}

export async function readLocalImage(path: string): Promise<LocalImage> {
  if (!isTauriAvailable()) throw new Error('Native image reader is unavailable')
  return await tauriInvoke<LocalImage>('read_local_image', { path })
}
