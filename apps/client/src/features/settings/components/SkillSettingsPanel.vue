<script setup lang="ts">
import { CircleCheck, Plus, RotateCw, Save, Trash2 } from 'lucide-vue-next'
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { uiText } from '../../../text/uiText'

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

type SkillDocument = SkillSummary & {
  content: string
}

type SkillDraft = {
  id: string
  name: string
  description: string
  content: string
  enabled: boolean
}

const props = defineProps<{
  apiBase: string
}>()

const emit = defineEmits<{
  dirtyChange: [dirty: boolean]
}>()

const skills = ref<SkillSummary[]>([])
const skillsRoot = ref('')
const selectedId = ref('')
const persistedDraft = ref<SkillDraft | null>(null)
const draft = reactive<SkillDraft>(emptyDraft())
const isNew = ref(false)
const loading = ref(false)
const saving = ref(false)
const validating = ref(false)
const deleting = ref(false)
const toggling = ref(false)
const error = ref('')
const message = ref('')
let loadRequest = 0

const selectedSkill = computed(() => skills.value.find((skill) => skill.id === selectedId.value) || null)
const hasEditor = computed(() => isNew.value || Boolean(selectedSkill.value))
const busy = computed(() => loading.value || saving.value || deleting.value)
const currentPath = computed(() => selectedSkill.value?.path || `.moke/skills/${draft.id || 'new-skill'}/SKILL.md`)
const dirty = computed(() => hasEditor.value && JSON.stringify(draftValue()) !== JSON.stringify(persistedDraft.value))

watch(dirty, (value) => emit('dirtyChange', value), { immediate: true })

function emptyDraft(): SkillDraft {
  return {
    id: '',
    name: '',
    description: '',
    content: '',
    enabled: true,
  }
}

function draftValue(): SkillDraft {
  return {
    id: draft.id,
    name: draft.name,
    description: draft.description,
    content: draft.content,
    enabled: draft.enabled,
  }
}

function applyDocument(document: SkillDocument) {
  selectedId.value = document.id
  isNew.value = false
  Object.assign(draft, {
    id: document.id,
    name: document.name,
    description: document.description,
    content: document.content,
    enabled: document.enabled,
  })
  persistedDraft.value = draftValue()
  upsertSummary(document)
}

function resetEditor() {
  selectedId.value = ''
  isNew.value = false
  Object.assign(draft, emptyDraft())
  persistedDraft.value = null
}

function upsertSummary(document: SkillDocument) {
  const summary: SkillSummary = {
    id: document.id,
    name: document.name,
    description: document.description,
    path: document.path,
    enabled: document.enabled,
    valid: document.valid,
    error: document.error,
    updatedAt: document.updatedAt,
  }
  const index = skills.value.findIndex((skill) => skill.id === summary.id)
  if (index >= 0) skills.value.splice(index, 1, summary)
  else skills.value.push(summary)
  skills.value.sort((left, right) => left.name.localeCompare(right.name))
}

function canDiscardChanges() {
  return !dirty.value || window.confirm(uiText.skills.discardChanges)
}

async function loadSkills(preferredId = selectedId.value) {
  const request = ++loadRequest
  loading.value = true
  error.value = ''
  message.value = ''
  try {
    const data = await requestJson(`${props.apiBase}/api/settings/skills`)
    if (request !== loadRequest) return
    skillsRoot.value = typeof data.root === 'string' ? data.root : ''
    skills.value = Array.isArray(data.skills) ? data.skills.filter(isSkillSummary) : []
    const target = skills.value.find((skill) => skill.id === preferredId) || skills.value[0]
    if (target) await loadSkill(target.id)
    else resetEditor()
  } catch (reason) {
    if (request === loadRequest) error.value = errorMessage(reason, uiText.skills.loadFailed)
  } finally {
    if (request === loadRequest) loading.value = false
  }
}

async function loadSkill(id: string) {
  const request = ++loadRequest
  loading.value = true
  error.value = ''
  message.value = ''
  try {
    const data = await requestJson(`${props.apiBase}/api/settings/skills/${encodeURIComponent(id)}`)
    if (request !== loadRequest || !isSkillDocument(data)) return
    applyDocument(data)
  } catch (reason) {
    if (request === loadRequest) error.value = errorMessage(reason, uiText.skills.loadFailed)
  } finally {
    if (request === loadRequest) loading.value = false
  }
}

async function selectSkill(id: string) {
  if (id === selectedId.value || !canDiscardChanges()) return
  await loadSkill(id)
}

function addSkill() {
  if (!canDiscardChanges()) return
  const used = new Set(skills.value.map((skill) => skill.id))
  let id = 'new-skill'
  let suffix = 2
  while (used.has(id)) id = `new-skill-${suffix++}`
  selectedId.value = ''
  isNew.value = true
  Object.assign(draft, { ...emptyDraft(), id, name: uiText.skills.newSkillName })
  persistedDraft.value = draftValue()
  error.value = ''
  message.value = ''
}

async function refreshSkills() {
  if (!canDiscardChanges()) return
  await loadSkills()
}

async function validateSkill(showSuccess = true) {
  validating.value = true
  error.value = ''
  message.value = ''
  try {
    const data = await requestJson(`${props.apiBase}/api/settings/skills/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...draftValue(), currentId: isNew.value ? undefined : selectedId.value }),
    })
    const errors = Array.isArray(data.errors) ? data.errors.filter((item): item is string => typeof item === 'string') : []
    if (data.valid !== true) {
      error.value = errors.join(' ') || uiText.skills.invalid
      return false
    }
    if (showSuccess) message.value = uiText.skills.valid
    return true
  } catch (reason) {
    error.value = errorMessage(reason, uiText.skills.validationFailed)
    return false
  } finally {
    validating.value = false
  }
}

async function saveSkill() {
  if (!(await validateSkill(false))) return
  saving.value = true
  error.value = ''
  message.value = ''
  try {
    const data = await requestJson(
      isNew.value
        ? `${props.apiBase}/api/settings/skills`
        : `${props.apiBase}/api/settings/skills/${encodeURIComponent(selectedId.value)}`,
      {
        method: isNew.value ? 'POST' : 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(draftValue()),
      },
    )
    if (!isSkillDocument(data)) throw new Error(uiText.skills.saveFailed)
    applyDocument(data)
    message.value = uiText.skills.saved
  } catch (reason) {
    error.value = errorMessage(reason, uiText.skills.saveFailed)
  } finally {
    saving.value = false
  }
}

async function toggleEnabled() {
  if (isNew.value || !persistedDraft.value) return
  const previous = persistedDraft.value.enabled
  toggling.value = true
  error.value = ''
  try {
    const data = await requestJson(`${props.apiBase}/api/settings/skills/${encodeURIComponent(selectedId.value)}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: draft.enabled }),
    })
    if (!isSkillDocument(data)) throw new Error(uiText.skills.statusFailed)
    persistedDraft.value = { ...persistedDraft.value, enabled: data.enabled }
    draft.enabled = data.enabled
    upsertSummary(data)
    message.value = data.enabled ? uiText.skills.enabled : uiText.skills.disabled
  } catch (reason) {
    draft.enabled = previous
    error.value = errorMessage(reason, uiText.skills.statusFailed)
  } finally {
    toggling.value = false
  }
}

async function deleteSkill() {
  if (isNew.value) {
    resetEditor()
    return
  }
  if (!selectedSkill.value || !window.confirm(uiText.skills.confirmDelete(selectedSkill.value.name))) return
  deleting.value = true
  error.value = ''
  try {
    await requestJson(`${props.apiBase}/api/settings/skills/${encodeURIComponent(selectedId.value)}`, {
      method: 'DELETE',
    })
    const next = skills.value.find((skill) => skill.id !== selectedId.value)?.id || ''
    skills.value = skills.value.filter((skill) => skill.id !== selectedId.value)
    if (next) await loadSkill(next)
    else resetEditor()
    message.value = uiText.skills.deleted
  } catch (reason) {
    error.value = errorMessage(reason, uiText.skills.deleteFailed)
  } finally {
    deleting.value = false
  }
}

async function requestJson(url: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const response = await fetch(url, init)
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    const record = toRecord(data)
    const apiError = toRecord(record.error)
    throw new Error(typeof apiError.message === 'string' ? apiError.message : `HTTP ${response.status}`)
  }
  return toRecord(data)
}

function toRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function isSkillSummary(value: unknown): value is SkillSummary {
  const skill = toRecord(value)
  return typeof skill.id === 'string'
    && typeof skill.name === 'string'
    && typeof skill.description === 'string'
    && typeof skill.path === 'string'
    && typeof skill.enabled === 'boolean'
    && typeof skill.valid === 'boolean'
}

function isSkillDocument(value: unknown): value is SkillDocument {
  return isSkillSummary(value) && typeof (value as { content?: unknown }).content === 'string'
}

function errorMessage(reason: unknown, fallback: string) {
  return reason instanceof Error && reason.message ? reason.message : fallback
}

onMounted(() => {
  void loadSkills()
})

onBeforeUnmount(() => {
  emit('dirtyChange', false)
})
</script>

<template>
  <div class="settings-section">
    <div class="settings-section-heading">
      <div class="skill-heading-meta">
        <span :title="skillsRoot">{{ uiText.skills.countLabel(skills.length) }}</span>
        <button
          type="button"
          class="settings-icon-button"
          :title="uiText.settings.refresh"
          :aria-label="uiText.settings.refresh"
          :disabled="loading"
          @click="refreshSkills"
        >
          <RotateCw :size="14" />
        </button>
      </div>
    </div>

    <div class="skill-feedback" :class="{ error: Boolean(error) }" role="status">
      {{ error || message }}
    </div>

    <div class="skill-settings">
      <aside class="skill-list" :aria-label="uiText.skills.title">
        <button
          v-for="skill in skills"
          :key="skill.id"
          type="button"
          :class="{ active: skill.id === selectedId, invalid: !skill.valid, disabled: skill.valid && !skill.enabled }"
          :aria-pressed="skill.id === selectedId"
          @click="selectSkill(skill.id)"
        >
          <span class="skill-list-heading">
            <span
              class="skill-status-dot"
              :class="{ enabled: skill.valid && skill.enabled, disabled: skill.valid && !skill.enabled, invalid: !skill.valid }"
              aria-hidden="true"
            ></span>
            <span class="skill-list-name">{{ skill.name }}</span>
          </span>
          <small :title="skill.valid ? skill.description : skill.error">
            {{ skill.valid ? skill.description : (skill.error || uiText.skills.invalid) }}
          </small>
        </button>
        <button type="button" class="skill-add" @click="addSkill">
          <Plus :size="14" />
          {{ uiText.skills.add }}
        </button>
      </aside>

      <div v-if="hasEditor" class="skill-editor" :aria-busy="busy">
        <div class="skill-editor-meta">
          <div class="skill-editor-path" :title="currentPath">{{ currentPath }}</div>
          <span class="skill-toggle-control">
            <input
              v-model="draft.enabled"
              class="skill-toggle"
              type="checkbox"
              role="switch"
              :aria-label="draft.enabled ? uiText.skills.enabled : uiText.skills.disabled"
              :disabled="toggling"
              @change="toggleEnabled"
            />
            <small>{{ draft.enabled ? uiText.skills.enabled : uiText.skills.disabled }}</small>
          </span>
        </div>

        <label v-if="isNew" class="settings-row">
          <span>{{ uiText.skills.id }}</span>
          <input v-model="draft.id" type="text" spellcheck="false" />
        </label>
        <label class="settings-row">
          <span>{{ uiText.skills.name }}</span>
          <input v-model="draft.name" type="text" spellcheck="false" />
        </label>
        <label class="settings-row skill-description-row">
          <span>{{ uiText.skills.description }}</span>
          <textarea v-model="draft.description" rows="3" spellcheck="false"></textarea>
        </label>

        <label class="skill-instructions-field">
          <span>{{ uiText.skills.instructions }}</span>
          <textarea v-model="draft.content" spellcheck="false"></textarea>
        </label>

        <div class="settings-actions skill-actions">
          <button type="button" class="settings-secondary skill-delete" :disabled="deleting" @click="deleteSkill">
            <Trash2 :size="14" />
            {{ uiText.settings.delete }}
          </button>
          <button type="button" class="settings-secondary" :disabled="validating || busy" @click="validateSkill()">
            <CircleCheck :size="14" />
            {{ validating ? uiText.skills.validating : uiText.skills.validate }}
          </button>
          <button type="button" class="settings-primary" :disabled="saving || validating || !dirty" @click="saveSkill">
            <Save :size="14" />
            {{ saving ? uiText.skills.saving : uiText.settings.save }}
          </button>
        </div>
      </div>

      <div v-else class="settings-note skill-empty">
        {{ loading ? uiText.settings.loading : uiText.skills.empty }}
      </div>
    </div>
  </div>
</template>
