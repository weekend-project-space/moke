<script setup lang="ts">
import { Plus, RefreshCw, Trash2 } from 'lucide-vue-next'
import { computed, onMounted, ref } from 'vue'

import { pickSkillFile } from '../../chat/services/workspacePicker'
import { apiFetch } from '../../../services/apiAccess'
import { uiText } from '../../../text/uiText'
import SettingsConfirmSheet from './SettingsConfirmSheet.vue'

type SkillSummary = {
  id: string
  name: string
  description: string
  path: string
  enabled: boolean
  valid: boolean
  error?: string
  updatedAt: string
}

const props = defineProps<{ apiBase: string }>()
const skills = ref<SkillSummary[]>([])
const filter = ref<'all' | 'enabled' | 'disabled' | 'invalid'>('all')
const loading = ref(false)
const importing = ref(false)
const updatingId = ref('')
const error = ref('')
const message = ref('')
const deleteTarget = ref<SkillSummary | null>(null)
const deleting = ref(false)

const visibleSkills = computed(() => skills.value.filter((skill) => {
  if (filter.value === 'enabled') return skill.valid && skill.enabled
  if (filter.value === 'disabled') return skill.valid && !skill.enabled
  if (filter.value === 'invalid') return !skill.valid
  return true
}))

function isSkillSummary(value: unknown): value is SkillSummary {
  const item = value as Partial<SkillSummary> | null
  return Boolean(item && typeof item.id === 'string' && typeof item.name === 'string'
    && typeof item.description === 'string' && typeof item.enabled === 'boolean'
    && typeof item.valid === 'boolean')
}

async function requestJson(url: string, init?: RequestInit) {
  const response = await apiFetch(url, init)
  const data = await response.json().catch(() => ({})) as Record<string, unknown>
  if (!response.ok) {
    const apiError = data.error as { message?: unknown } | undefined
    throw new Error(typeof apiError?.message === 'string' ? apiError.message : `HTTP ${response.status}`)
  }
  return data
}

async function loadSkills() {
  loading.value = true
  error.value = ''
  try {
    const data = await requestJson(`${props.apiBase}/api/settings/skills`)
    skills.value = Array.isArray(data.skills) ? data.skills.filter(isSkillSummary) : []
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : uiText.skills.loadFailed
  } finally {
    loading.value = false
  }
}

async function importSkill() {
  const sourcePath = await pickSkillFile()
  if (!sourcePath || importing.value) return
  importing.value = true
  error.value = ''
  message.value = ''
  try {
    const data = await requestJson(`${props.apiBase}/api/settings/skills/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: sourcePath }),
    })
    if (isSkillSummary(data)) {
      skills.value = [...skills.value.filter((skill) => skill.id !== data.id), data].sort((left, right) => left.name.localeCompare(right.name))
    } else {
      await loadSkills()
    }
    message.value = uiText.skills.imported
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : uiText.skills.importFailed
  } finally {
    importing.value = false
  }
}

async function toggleSkill(skill: SkillSummary) {
  if (!skill.valid || updatingId.value) return
  updatingId.value = skill.id
  error.value = ''
  try {
    const data = await requestJson(`${props.apiBase}/api/settings/skills/${encodeURIComponent(skill.id)}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: !skill.enabled }),
    })
    if (isSkillSummary(data)) {
      skills.value = skills.value.map((item) => item.id === data.id ? data : item)
    }
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : uiText.skills.statusFailed
  } finally {
    updatingId.value = ''
  }
}

function requestDelete(skill: SkillSummary) {
  deleteTarget.value = skill
}

function cancelDelete() {
  if (!deleting.value) deleteTarget.value = null
}

async function confirmDelete() {
  const target = deleteTarget.value
  if (!target || deleting.value) return
  deleting.value = true
  error.value = ''
  try {
    await requestJson(`${props.apiBase}/api/settings/skills/${encodeURIComponent(target.id)}`, { method: 'DELETE' })
    skills.value = skills.value.filter((skill) => skill.id !== target.id)
    deleteTarget.value = null
    message.value = uiText.skills.deleted
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : uiText.skills.deleteFailed
  } finally {
    deleting.value = false
  }
}

onMounted(() => { void loadSkills() })
</script>

<template>
  <div class="settings-section skill-settings-simple">
    <header class="settings-group-heading">
      <div>
        <h3>{{ uiText.skills.title }}</h3>
        <span>{{ uiText.skills.countLabel(skills.length) }}</span>
      </div>
      <div class="settings-toolbar">
        <button type="button" class="settings-icon-button" :title="uiText.settings.refresh" :aria-label="uiText.settings.refresh" :disabled="loading" @click="loadSkills">
          <RefreshCw :size="14" :class="{ spinning: loading }" />
        </button>
        <button type="button" class="settings-secondary" :disabled="importing" @click="importSkill">
          <Plus :size="14" />{{ importing ? uiText.skills.importing : uiText.skills.import }}
        </button>
      </div>
    </header>

    <div class="skill-filter" role="tablist" :aria-label="uiText.skills.filterLabel">
      <button v-for="option in (['all', 'enabled', 'disabled', 'invalid'] as const)" :key="option" type="button" role="tab" :aria-selected="filter === option" :class="{ active: filter === option }" @click="filter = option">
        {{ uiText.skills[option] }}
      </button>
    </div>

    <div v-if="error" class="settings-note error" role="alert">{{ error }}</div>
    <div v-else-if="message" class="settings-note success" role="status">{{ message }}</div>
    <div v-if="loading && skills.length === 0" class="settings-note">{{ uiText.settings.loading }}</div>
    <div v-else-if="visibleSkills.length === 0" class="settings-empty-state">{{ uiText.skills.empty }}</div>
    <div v-else class="skill-list-simple">
      <div v-for="skill in visibleSkills" :key="skill.id" class="settings-list-row skill-list-row-simple">
        <div class="settings-list-main">
          <span class="skill-status-dot" :class="{ enabled: skill.valid && skill.enabled, disabled: skill.valid && !skill.enabled, invalid: !skill.valid }" aria-hidden="true"></span>
          <div class="settings-list-copy">
            <strong>{{ skill.name }}</strong>
            <span>{{ skill.valid ? skill.description : (skill.error || uiText.skills.invalid) }}</span>
          </div>
        </div>
        <div class="skill-list-actions">
          <span class="skill-status-label" :class="{ invalid: !skill.valid }">{{ skill.valid ? (skill.enabled ? uiText.skills.enabled : uiText.skills.disabled) : uiText.skills.invalid }}</span>
          <input class="skill-toggle" type="checkbox" role="switch" :checked="skill.enabled" :aria-label="skill.name" :disabled="!skill.valid || updatingId === skill.id" @change="toggleSkill(skill)" />
          <button type="button" class="settings-icon-button" :title="uiText.settings.delete" :aria-label="uiText.skills.deleteLabel(skill.name)" :disabled="deleting" @click="requestDelete(skill)"><Trash2 :size="14" /></button>
        </div>
      </div>
    </div>
  </div>

  <SettingsConfirmSheet
    :open="Boolean(deleteTarget)"
    dialog-id="skill-delete-confirm"
    :title="uiText.skills.deleteTitle"
    :description="deleteTarget ? uiText.skills.confirmDelete(deleteTarget.name) : ''"
    :confirm-label="uiText.settings.delete"
    :cancel-label="uiText.settings.cancel"
    :busy="deleting"
    @cancel="cancelDelete"
    @confirm="confirmDelete"
  />
</template>
