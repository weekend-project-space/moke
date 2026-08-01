<script setup lang="ts">
import { CalendarClock, Folder, MessageSquare, PanelLeft, Pencil, Plus, Trash2, X } from 'lucide-vue-next'
import { computed, onMounted, reactive, ref } from 'vue'
import type {
  ApprovalMode,
  CreateScheduledTaskRequest,
  ScheduledTask,
  ScheduledTaskStatus,
} from '@moke/protocol'
import { createScheduledTasksApi } from '../api/scheduledTasks'
import { isNativeWorkspacePickerAvailable, pickWorkspaceDirectory } from '../../chat/services/workspacePicker'

const props = defineProps<{
  apiBase: string
  defaultWorkspace: string
  workspaceOptions: string[]
}>()

const emit = defineEmits<{
  openSession: [id: string]
  toggleSidebar: []
}>()

type Filter = 'all' | ScheduledTaskStatus
type Frequency = 'daily' | 'weekly' | 'custom'

const api = createScheduledTasksApi(props.apiBase)
const tasks = ref<ScheduledTask[]>([])
const filter = ref<Filter>('all')
const loading = ref(true)
const saving = ref(false)
const error = ref('')
const editorOpen = ref(false)
const editingId = ref('')
const frequency = ref<Frequency>('daily')
const time = ref('09:00')
const weekday = ref('1')
const form = reactive<CreateScheduledTaskRequest>({
  name: '',
  prompt: '',
  cron: '0 9 * * *',
  timezone: localTimezone(),
  workspace_root: props.defaultWorkspace,
  approval_mode: 'ai_review',
  status: 'enabled',
})

const filteredTasks = computed(() => filter.value === 'all'
  ? tasks.value
  : tasks.value.filter((task) => task.status === filter.value))
const canSave = computed(() => Boolean(
  form.name.trim()
  && form.prompt.trim()
  && form.workspace_root.trim()
  && (frequency.value !== 'custom' || form.cron.trim()),
))

async function loadTasks() {
  loading.value = true
  error.value = ''
  try {
    tasks.value = await api.list()
  } catch (loadError) {
    error.value = errorMessage(loadError)
  } finally {
    loading.value = false
  }
}

function openCreate() {
  editingId.value = ''
  frequency.value = 'daily'
  time.value = '09:00'
  weekday.value = '1'
  Object.assign(form, {
    name: '',
    prompt: '',
    cron: '0 9 * * *',
    timezone: localTimezone(),
    workspace_root: props.defaultWorkspace || props.workspaceOptions[0] || '',
    approval_mode: 'ai_review' satisfies ApprovalMode,
    status: 'enabled' satisfies ScheduledTaskStatus,
  })
  error.value = ''
  editorOpen.value = true
}

function openEdit(task: ScheduledTask) {
  editingId.value = task.id
  Object.assign(form, {
    name: task.name,
    prompt: task.prompt,
    cron: task.cron,
    timezone: task.timezone,
    workspace_root: task.workspace_root,
    approval_mode: task.approval_mode,
    status: task.status,
  })
  inferFrequency(task.cron)
  error.value = ''
  editorOpen.value = true
}

function closeEditor() {
  if (saving.value) return
  editorOpen.value = false
}

async function saveTask() {
  if (!canSave.value || saving.value) return
  saving.value = true
  error.value = ''
  try {
    const payload = { ...form, cron: cronFromFrequency() }
    if (editingId.value) await api.update(editingId.value, payload)
    else await api.create(payload)
    editorOpen.value = false
    await loadTasks()
  } catch (saveError) {
    error.value = errorMessage(saveError)
  } finally {
    saving.value = false
  }
}

async function toggleTask(task: ScheduledTask) {
  error.value = ''
  try {
    const updated = await api.setPaused(task.id, task.status === 'enabled')
    replaceTask(updated)
  } catch (toggleError) {
    error.value = errorMessage(toggleError)
  }
}

async function removeTask(task: ScheduledTask) {
  if (!window.confirm(`Delete "${task.name}"?`)) return
  error.value = ''
  try {
    await api.remove(task.id)
    tasks.value = tasks.value.filter((item) => item.id !== task.id)
  } catch (removeError) {
    error.value = errorMessage(removeError)
  }
}

async function chooseWorkspace() {
  if (!isNativeWorkspacePickerAvailable()) return
  const selected = await pickWorkspaceDirectory(form.workspace_root)
  if (selected) form.workspace_root = selected
}

function replaceTask(task: ScheduledTask) {
  const index = tasks.value.findIndex((item) => item.id === task.id)
  if (index >= 0) tasks.value[index] = task
}

function cronFromFrequency() {
  if (frequency.value === 'custom') return form.cron.trim()
  const [hour = '9', minute = '0'] = time.value.split(':')
  return frequency.value === 'daily'
    ? `${Number(minute)} ${Number(hour)} * * *`
    : `${Number(minute)} ${Number(hour)} * * ${weekday.value}`
}

function inferFrequency(cron: string) {
  const parts = cron.trim().split(/\s+/)
  if (parts.length === 5 && parts[2] === '*' && parts[3] === '*' && parts[4] === '*'
    && /^\d+$/.test(parts[0]!) && /^\d+$/.test(parts[1]!)) {
    frequency.value = 'daily'
    time.value = `${parts[1]!.padStart(2, '0')}:${parts[0]!.padStart(2, '0')}`
    return
  }
  if (parts.length === 5 && parts[2] === '*' && parts[3] === '*' && /^\d$/.test(parts[4]!)
    && /^\d+$/.test(parts[0]!) && /^\d+$/.test(parts[1]!)) {
    frequency.value = 'weekly'
    time.value = `${parts[1]!.padStart(2, '0')}:${parts[0]!.padStart(2, '0')}`
    weekday.value = parts[4]!
    return
  }
  frequency.value = 'custom'
}

function scheduleLabel(task: ScheduledTask) {
  const parts = task.cron.split(' ')
  const scheduledTime = parts.length === 5 && /^\d+$/.test(parts[0]!) && /^\d+$/.test(parts[1]!)
    ? `${parts[1]!.padStart(2, '0')}:${parts[0]!.padStart(2, '0')}`
    : ''
  if (scheduledTime && parts[2] === '*' && parts[3] === '*' && parts[4] === '*') return `Daily at ${scheduledTime}`
  if (scheduledTime && parts[2] === '*' && parts[3] === '*' && /^\d$/.test(parts[4]!)) {
    return `${weekdayName(parts[4]!)} at ${scheduledTime}`
  }
  return task.cron
}

function formatDate(value?: string) {
  if (!value) return 'Not scheduled'
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value))
}

function weekdayName(value: string) {
  return ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][Number(value)] || 'Weekly'
}

function localTimezone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai'
}

function errorMessage(value: unknown) {
  return value instanceof Error ? value.message : 'Request failed'
}

onMounted(loadTasks)
</script>

<template>
  <section class="scheduled-tasks-workspace">
    <header class="scheduled-tasks-header">
      <button class="sidebar-toggle" type="button" aria-label="Toggle chat list" title="Toggle chat list" @click="emit('toggleSidebar')">
        <PanelLeft :size="17" stroke-width="2.1" />
      </button>
      <h1>Scheduled tasks</h1>
      <button class="scheduled-task-primary" type="button" @click="openCreate">
        <Plus :size="15" stroke-width="2.2" />
        New task
      </button>
    </header>

    <div class="scheduled-tasks-scroll">
      <div class="scheduled-tasks-content">
        <div class="scheduled-task-filters" aria-label="Filter scheduled tasks">
          <button v-for="option in (['all', 'enabled', 'paused'] as const)" :key="option" type="button"
            :class="{ active: filter === option }" :aria-pressed="filter === option" @click="filter = option">
            {{ option === 'all' ? 'All' : option === 'enabled' ? 'Enabled' : 'Paused' }}
          </button>
        </div>

        <p v-if="error && !editorOpen" class="scheduled-task-error">{{ error }}</p>
        <div v-if="loading" class="scheduled-task-empty">Loading tasks...</div>
        <div v-else-if="filteredTasks.length === 0" class="scheduled-task-empty">
          <CalendarClock :size="24" stroke-width="1.7" />
          <strong>{{ tasks.length ? 'No tasks in this filter' : 'No scheduled tasks' }}</strong>
          <button v-if="tasks.length === 0" type="button" @click="openCreate">Create a task</button>
        </div>
        <div v-else class="scheduled-task-list">
          <article v-for="task in filteredTasks" :key="task.id" class="scheduled-task-row">
            <button class="scheduled-task-switch" type="button" role="switch" :aria-checked="task.status === 'enabled'"
              :aria-label="task.status === 'enabled' ? `Pause ${task.name}` : `Enable ${task.name}`" @click="toggleTask(task)">
              <span></span>
            </button>
            <div class="scheduled-task-main">
              <strong>{{ task.name }}</strong>
              <span>{{ scheduleLabel(task) }} / {{ task.timezone }}</span>
              <small>{{ task.status === 'enabled' ? `Next ${formatDate(task.next_run_at)}` : 'Paused' }} / {{ task.workspace_root }}</small>
            </div>
            <div class="scheduled-task-actions">
              <button v-if="task.last_session_id" type="button" title="Open last run" aria-label="Open last run" @click="emit('openSession', task.last_session_id)">
                <MessageSquare :size="15" stroke-width="2" />
              </button>
              <button type="button" title="Edit task" aria-label="Edit task" @click="openEdit(task)">
                <Pencil :size="15" stroke-width="2" />
              </button>
              <button class="danger" type="button" title="Delete task" aria-label="Delete task" @click="removeTask(task)">
                <Trash2 :size="15" stroke-width="2" />
              </button>
            </div>
          </article>
        </div>
      </div>
    </div>
  </section>

  <Teleport to="body">
    <div v-if="editorOpen" class="scheduled-task-modal-backdrop" @click.self="closeEditor">
      <form class="scheduled-task-modal" role="dialog" aria-modal="true" aria-labelledby="scheduled-task-dialog-title"
        @keydown.esc.prevent="closeEditor" @submit.prevent="saveTask">
        <header>
          <h2 id="scheduled-task-dialog-title">{{ editingId ? 'Edit scheduled task' : 'New scheduled task' }}</h2>
          <button type="button" aria-label="Close" title="Close" @click="closeEditor"><X :size="17" /></button>
        </header>

        <div class="scheduled-task-form">
          <label><span>Name</span><input v-model="form.name" type="text" maxlength="120" required autofocus /></label>
          <label><span>Instructions</span><textarea v-model="form.prompt" rows="5" maxlength="20000" required></textarea></label>

          <div class="scheduled-task-form-grid">
            <label><span>Frequency</span>
              <select v-model="frequency"><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="custom">Custom cron</option></select>
            </label>
            <label v-if="frequency !== 'custom'"><span>Time</span><input v-model="time" type="time" required /></label>
            <label v-if="frequency === 'weekly'"><span>Day</span>
              <select v-model="weekday"><option value="1">Monday</option><option value="2">Tuesday</option><option value="3">Wednesday</option><option value="4">Thursday</option><option value="5">Friday</option><option value="6">Saturday</option><option value="0">Sunday</option></select>
            </label>
            <label v-if="frequency === 'custom'" class="wide"><span>Cron</span><input v-model="form.cron" type="text" spellcheck="false" placeholder="0 9 * * *" required /></label>
            <label><span>Timezone</span><input v-model="form.timezone" type="text" spellcheck="false" required /></label>
          </div>

          <label><span>Workspace</span>
            <div class="scheduled-task-workspace-input">
              <Folder :size="15" />
              <input v-model="form.workspace_root" type="text" list="scheduled-workspaces" spellcheck="false" required />
              <button v-if="isNativeWorkspacePickerAvailable()" type="button" @click="chooseWorkspace">Choose</button>
            </div>
            <datalist id="scheduled-workspaces"><option v-for="workspace in workspaceOptions" :key="workspace" :value="workspace" /></datalist>
          </label>

          <div class="scheduled-task-form-grid">
            <label><span>Approval</span>
              <select v-model="form.approval_mode"><option value="manual">Manual approval</option><option value="ai_review">AI review</option><option value="auto_approve">Auto approve</option></select>
            </label>
            <label class="scheduled-task-enabled"><input v-model="form.status" type="checkbox" true-value="enabled" false-value="paused" /><span>Enabled</span></label>
          </div>
          <p v-if="error" class="scheduled-task-error">{{ error }}</p>
        </div>

        <footer>
          <button type="button" class="secondary" @click="closeEditor">Cancel</button>
          <button type="submit" class="primary" :disabled="!canSave || saving">{{ saving ? 'Saving...' : editingId ? 'Save changes' : 'Create task' }}</button>
        </footer>
      </form>
    </div>
  </Teleport>
</template>
