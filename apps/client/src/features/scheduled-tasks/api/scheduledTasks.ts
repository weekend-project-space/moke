import type {
  CreateScheduledTaskRequest,
  ScheduledTask,
  ScheduledTaskStatus,
  UpdateScheduledTaskRequest,
} from '@moke/protocol'

export function createScheduledTasksApi(apiBase: string, fetcher: typeof fetch = fetch) {
  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetcher(`${apiBase}${path}`, {
      ...init,
      headers: init?.body ? { 'content-type': 'application/json', ...init.headers } : init?.headers,
    })
    if (!response.ok) {
      const payload = await response.json().catch(() => null) as { error?: { message?: string } } | null
      throw new Error(payload?.error?.message || `Request failed (${response.status})`)
    }
    if (response.status === 204) return undefined as T
    return response.json() as Promise<T>
  }

  return {
    async list(status?: ScheduledTaskStatus) {
      const query = status ? `?status=${status}` : ''
      return (await request<{ tasks: ScheduledTask[] }>(`/api/scheduled-tasks${query}`)).tasks
    },
    async create(input: CreateScheduledTaskRequest) {
      return (await request<{ task: ScheduledTask }>('/api/scheduled-tasks', {
        method: 'POST',
        body: JSON.stringify(input),
      })).task
    },
    async update(id: string, input: UpdateScheduledTaskRequest) {
      return (await request<{ task: ScheduledTask }>(`/api/scheduled-tasks/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify(input),
      })).task
    },
    remove(id: string) {
      return request<void>(`/api/scheduled-tasks/${encodeURIComponent(id)}`, { method: 'DELETE' })
    },
    async setPaused(id: string, paused: boolean) {
      return (await request<{ task: ScheduledTask }>(
        `/api/scheduled-tasks/${encodeURIComponent(id)}/${paused ? 'pause' : 'resume'}`,
        { method: 'POST' },
      )).task
    },
  }
}
