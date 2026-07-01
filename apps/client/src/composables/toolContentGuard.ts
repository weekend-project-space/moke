const TOOL_CONTENT_LIMIT_BYTES = 100 * 1024

export type GuardedToolContent = {
  text: string
  bytes: number
  isOversize: boolean
}

export function guardToolContent(value: string | undefined): GuardedToolContent {
  const text = value || ''
  const bytes = new TextEncoder().encode(text).byteLength

  return {
    text,
    bytes,
    isOversize: bytes > TOOL_CONTENT_LIMIT_BYTES,
  }
}

export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} kB`

  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
