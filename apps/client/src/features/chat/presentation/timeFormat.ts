export function formatSessionTime(value: string, now = new Date()) {
  const time = Date.parse(value)
  if (Number.isNaN(time)) return 'Just now'

  const date = new Date(time)
  const today = startOfDay(now)
  const targetDay = startOfDay(date)

  if (targetDay === today) return formatTime(date)

  const dateLabel = formatDate(date)
  if (date.getFullYear() === now.getFullYear()) return dateLabel
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`
}

export function formatTimelineTime(time: number, now = new Date()) {
  const date = new Date(time)
  const today = startOfDay(now)
  const targetDay = startOfDay(date)
  const timeLabel = formatTime(date)

  if (targetDay === today) return timeLabel
  if (targetDay === today - 24 * 60 * 60 * 1000) return `Yesterday ${timeLabel}`

  const dateLabel = formatDate(date)
  if (date.getFullYear() === now.getFullYear()) return `${dateLabel} ${timeLabel}`
  return `${date.getFullYear()} ${dateLabel} ${timeLabel}`
}

function startOfDay(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

function formatTime(date: Date) {
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

function formatDate(date: Date) {
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
  }).format(date)
}
