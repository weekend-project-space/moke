<script setup lang="ts">
import { ChevronRight, Eye, EyeOff, Plus, RotateCw, Save, Trash2, Undo2 } from 'lucide-vue-next'
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'

import { uiText } from '../../../text/uiText'
import { apiFetch } from '../../../services/apiAccess'
import SettingsConfirmSheet from './SettingsConfirmSheet.vue'

type ModelProviderProfile = {
  id: string
  name: string
  type: 'openai-compatible' | 'openai-responses'
  model: string
  apiBaseUrl: string
  apiKey: string
  maxRetries: number
  timeoutMs: number
  reasoningEffort: 'off' | 'low' | 'medium' | 'high' | 'max'
  reasoningProvider: 'none' | 'llama.cpp'
  showRawReasoning: boolean
}

const props = defineProps<{ apiBase: string }>()
const emit = defineEmits<{
  dirtyChange: [dirty: boolean]
}>()

const MODEL_PROVIDER_MAX_RETRIES_MAX = 6
const MODEL_PROVIDER_TIMEOUT_MAX_MS = 60 * 60 * 1000
const activeProviderId = ref('')
const selectedProviderId = ref('')
const providers = ref<ModelProviderProfile[]>([])
const editingProvider = reactive<ModelProviderProfile>(createProvider())
const modelOptions = ref<string[]>([])
const loadingModels = ref(false)
const modelError = ref('')
const loaded = ref(false)
const modelTest = ref<'idle' | 'checking' | 'ok' | 'error'>('idle')
const modelTestMessage = ref('')
const modelListMessage = ref('')
const saving = ref(false)
const deleteConfirmationOpen = ref(false)
const pendingProviderAction = ref<(() => void) | null>(null)
const newProviderId = ref('')
const apiKeyVisible = ref(false)
const requestBehaviorExpanded = ref(false)
let modelTestRequest = 0
let modelListRequest = 0
const selectedProvider = computed(() => providers.value.find((provider) => provider.id === selectedProviderId.value) || null)
const isDirty = computed(() => loaded.value && (newProviderId.value === editingProvider.id || !selectedProvider.value || !providerEquals(editingProvider, selectedProvider.value)))
const isOpenAIResponsesProvider = computed(() => editingProvider.type === 'openai-responses')
const isLlamaCppReasoning = computed(() => editingProvider.reasoningProvider === 'llama.cpp')
const showsReasoningEffort = computed(() => isOpenAIResponsesProvider.value || isLlamaCppReasoning.value)
const editingTimeoutSeconds = computed({
  get: () => Math.round(editingProvider.timeoutMs / 1000),
  set: (value: number) => {
    editingProvider.timeoutMs = Math.max(1, Math.min(Math.trunc(Number(value) || 1), 3600)) * 1000
  },
})
const advancedPreview = computed(() =>
  showsReasoningEffort.value
    ? uiText.settings.retriesPreview(editingTimeoutSeconds.value, editingProvider.maxRetries, editingProvider.reasoningEffort)
    : uiText.settings.standardPreview(editingTimeoutSeconds.value, editingProvider.maxRetries),
)
const modelTestStatusText = computed(() => {
  if (modelTest.value === 'checking') return uiText.settings.testing
  return modelTestMessage.value || uiText.settings.notTested
})

function createProvider(): ModelProviderProfile {
  return {
    id: `provider_${Date.now()}_${Math.random().toString(16).slice(2, 6)}`,
    name: 'Local Qwen',
    type: 'openai-compatible',
    apiKey: '',
    apiBaseUrl: 'http://localhost:8080/v1',
    maxRetries: 3,
    model: 'qwen3.6-35BA3B',
    reasoningEffort: 'medium',
    reasoningProvider: 'none',
    showRawReasoning: false,
    timeoutMs: 30 * 60 * 1000,
  }
}

function normalizeReasoningEffort(input: unknown): ModelProviderProfile['reasoningEffort'] {
  if (input === 'ultra') return 'max'
  return input === 'off' || input === 'low' || input === 'medium' || input === 'high' || input === 'max' ? input : 'medium'
}

function normalizeProvider(provider: ModelProviderProfile): ModelProviderProfile {
  return {
    ...provider,
    maxRetries: Number.isFinite(Number(provider.maxRetries)) ? Number(provider.maxRetries) : 3,
    timeoutMs: Number.isFinite(Number(provider.timeoutMs)) ? Number(provider.timeoutMs) : 30 * 60 * 1000,
    reasoningEffort: normalizeReasoningEffort(provider.reasoningEffort),
    reasoningProvider: provider.reasoningProvider === 'llama.cpp' ? 'llama.cpp' : 'none',
    showRawReasoning: Boolean(provider.showRawReasoning),
  }
}

function providerEquals(left: ModelProviderProfile, right: ModelProviderProfile) {
  return left.id === right.id
    && left.name === right.name
    && left.type === right.type
    && left.model === right.model
    && left.apiBaseUrl === right.apiBaseUrl
    && left.apiKey === right.apiKey
    && left.maxRetries === right.maxRetries
    && left.timeoutMs === right.timeoutMs
    && left.reasoningEffort === right.reasoningEffort
    && left.reasoningProvider === right.reasoningProvider
    && left.showRawReasoning === right.showRawReasoning
}

function copyProvider(provider: ModelProviderProfile) {
  Object.assign(editingProvider, normalizeProvider(provider))
}

function syncEditingProvider() {
  const provider = selectedProvider.value || providers.value[0]
  if (!provider) return
  selectedProviderId.value = provider.id
  copyProvider(provider)
}

async function loadSettings() {
  modelError.value = ''
  try {
    const response = await apiFetch(`${props.apiBase}/api/settings`)
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const data = await response.json()
    const hasProviders = Array.isArray(data.providers) && data.providers.length > 0
    providers.value = hasProviders ? data.providers.map(normalizeProvider) : [createProvider()]
    newProviderId.value = hasProviders ? '' : providers.value[0].id
    activeProviderId.value = hasProviders ? data.activeProviderId || providers.value[0].id : ''
    selectedProviderId.value = activeProviderId.value || providers.value[0].id
    syncEditingProvider()
  } catch {
    modelError.value = uiText.settings.loadFailed
    providers.value = [createProvider()]
    newProviderId.value = providers.value[0].id
    activeProviderId.value = ''
    selectedProviderId.value = providers.value[0].id
    syncEditingProvider()
  } finally {
    loaded.value = true
  }
}

async function persistModelProviders(
  nextProviders: ModelProviderProfile[],
  nextActiveProviderId: string,
  nextSelectedProviderId: string,
) {
  modelError.value = ''
  saving.value = true
  try {
    const response = await apiFetch(`${props.apiBase}/api/settings/model-providers`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ activeProviderId: nextActiveProviderId, providers: nextProviders }),
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const data = await response.json()
    const persistedProviders = Array.isArray(data.providers) && data.providers.length > 0 ? data.providers : nextProviders
    providers.value = persistedProviders.map(normalizeProvider)
    activeProviderId.value = data.activeProviderId || nextActiveProviderId
    newProviderId.value = ''
    selectedProviderId.value = providers.value.some((provider) => provider.id === nextSelectedProviderId)
      ? nextSelectedProviderId
      : activeProviderId.value
    syncEditingProvider()
    return true
  } catch {
    modelError.value = uiText.settings.modelSaveFailed
    return false
  } finally {
    saving.value = false
  }
}

async function saveModelProviders() {
  const nextProviders = providers.value.map((provider) =>
    provider.id === editingProvider.id ? { ...editingProvider } : provider,
  )
  await persistModelProviders(nextProviders, activeProviderId.value || editingProvider.id, editingProvider.id)
}

async function activateProvider() {
  if (isDirty.value || editingProvider.id === activeProviderId.value) return
  await persistModelProviders(providers.value, editingProvider.id, editingProvider.id)
}

function selectProvider(provider: ModelProviderProfile) {
  selectedProviderId.value = provider.id
  copyProvider(provider)
  modelOptions.value = []
  modelListMessage.value = ''
  modelTestMessage.value = ''
  apiKeyVisible.value = false
}

function selectProviderFromList(provider: ModelProviderProfile) {
  if (provider.id === selectedProviderId.value) return
  runAfterDiscard(() => selectProvider(provider))
}

function addProvider() {
  runAfterDiscard(() => {
    const provider = createProvider()
    provider.name = `Provider ${providers.value.length + 1}`
    newProviderId.value = provider.id
    providers.value = [...providers.value, provider]
    selectProvider(provider)
  })
}

function runAfterDiscard(action: () => void) {
  if (isDirty.value) pendingProviderAction.value = action
  else action()
}

function cancelDiscardChanges() {
  pendingProviderAction.value = null
}

function confirmDiscardChanges() {
  const action = pendingProviderAction.value
  if (!action) return
  discardEditingProvider()
  pendingProviderAction.value = null
  action()
}

function discardEditingProvider() {
  if (newProviderId.value === editingProvider.id) {
    providers.value = providers.value.filter((provider) => provider.id !== editingProvider.id)
    newProviderId.value = ''
    const fallback = providers.value.find((provider) => provider.id === activeProviderId.value) || providers.value[0]
    if (fallback) selectProvider(fallback)
    return
  }
  if (selectedProvider.value) copyProvider(selectedProvider.value)
  modelOptions.value = []
  modelListMessage.value = ''
  modelTestMessage.value = ''
}

function revertProvider() {
  if (isDirty.value) discardEditingProvider()
}

function requestDeleteProvider() {
  if (providers.value.length <= 1 || saving.value) return
  if (newProviderId.value === editingProvider.id) {
    discardEditingProvider()
    return
  }
  deleteConfirmationOpen.value = true
}

function cancelDeleteProvider() {
  if (saving.value) return
  deleteConfirmationOpen.value = false
}

async function confirmDeleteProvider() {
  if (providers.value.length <= 1) return
  const nextProviders = providers.value.filter((provider) => provider.id !== editingProvider.id)
  const nextActiveProviderId = activeProviderId.value === editingProvider.id ? nextProviders[0].id : activeProviderId.value
  const nextSelectedProviderId = nextProviders.some((provider) => provider.id === nextActiveProviderId)
    ? nextActiveProviderId
    : nextProviders[0].id
  const deleted = await persistModelProviders(nextProviders, nextActiveProviderId, nextSelectedProviderId)
  if (deleted) deleteConfirmationOpen.value = false
}

async function testModel() {
  const request = ++modelTestRequest
  const providerId = editingProvider.id
  modelTest.value = 'checking'
  modelTestMessage.value = ''
  try {
    const response = await apiFetch(`${props.apiBase}/api/settings/model/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(editingProvider),
    })
    const data = await response.json()
    if (request !== modelTestRequest || providerId !== editingProvider.id) return
    modelTest.value = response.ok && data.ok ? 'ok' : 'error'
    modelTestMessage.value = data.message || (data.ok ? uiText.settings.modelAvailable : uiText.settings.modelTestFailed)
    if (Array.isArray(data.models)) modelOptions.value = data.models
  } catch {
    if (request !== modelTestRequest || providerId !== editingProvider.id) return
    modelTest.value = 'error'
    modelTestMessage.value = uiText.settings.modelTestFailed
  }
}

async function loadModelOptions() {
  const request = ++modelListRequest
  const providerId = editingProvider.id
  loadingModels.value = true
  modelListMessage.value = ''
  try {
    const response = await apiFetch(`${props.apiBase}/api/settings/model/list`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(editingProvider),
    })
    const data = await response.json()
    if (request !== modelListRequest || providerId !== editingProvider.id) return
    if (!response.ok || !data.ok) throw new Error(data.message || `HTTP ${response.status}`)
    modelOptions.value = data.models || []
    modelListMessage.value = modelOptions.value.length > 0 ? uiText.settings.modelsLoaded(modelOptions.value.length) : uiText.settings.noModels
  } catch (error) {
    if (request !== modelListRequest || providerId !== editingProvider.id) return
    modelOptions.value = []
    modelListMessage.value = error instanceof Error ? error.message : uiText.settings.modelLoadFailed
  } finally {
    if (request === modelListRequest) loadingModels.value = false
  }
}

watch(editingProvider, () => {
  modelTestRequest += 1
  modelListRequest += 1
  loadingModels.value = false
  modelTest.value = 'idle'
  modelTestMessage.value = ''
}, { deep: true })
watch(isDirty, (dirty) => {
  emit('dirtyChange', dirty)
}, { immediate: true })

onMounted(() => { void loadSettings() })
onBeforeUnmount(() => emit('dirtyChange', false))
</script>

<template>
  <div class="settings-section model-settings">
    <div class="model-provider-layout">
      <aside class="model-provider-source" :aria-label="uiText.settings.providers">
        <header class="model-source-heading">
          <div>
            <h3>{{ uiText.settings.providers }}</h3>
            <span>{{ uiText.settings.providerCount(providers.length) }}</span>
          </div>
        </header>
        <div class="model-source-list" role="listbox" :aria-label="uiText.settings.providers">
          <button
            v-for="provider in providers"
            :key="provider.id"
            type="button"
            role="option"
            :aria-selected="provider.id === selectedProviderId"
            :class="{ active: provider.id === selectedProviderId }"
            @click="selectProviderFromList(provider)"
          >
            <span class="model-source-title">
              <strong>{{ provider.name }}</strong>
              <span v-if="provider.id === activeProviderId" class="model-provider-status">{{ uiText.settings.defaultProvider }}</span>
            </span>
            <small>{{ provider.model || provider.type }}</small>
          </button>
        </div>
        <footer class="model-source-actions">
          <button type="button" class="settings-icon-button" :title="uiText.settings.addProvider" :aria-label="uiText.settings.addProvider" :disabled="saving" @click="addProvider"><Plus :size="14" /></button>
          <button type="button" class="settings-icon-button" :title="uiText.settings.confirmDeleteProviderAction" :aria-label="uiText.settings.confirmDeleteProviderAction" :disabled="providers.length <= 1 || saving" @click="requestDeleteProvider"><Trash2 :size="14" /></button>
        </footer>
      </aside>

      <div class="model-provider-detail">
        <header class="model-detail-heading">
          <div>
            <h3>{{ editingProvider.name }}</h3>
            <span>{{ editingProvider.type === 'openai-responses' ? 'OpenAI Responses' : 'OpenAI Compatible' }}</span>
          </div>
          <div class="model-provider-states">
            <span v-if="isDirty" class="model-dirty-status">{{ uiText.settings.unsaved }}</span>
            <button
              v-else
              type="button"
              class="settings-secondary"
              :disabled="saving || isDirty"
              :title="isDirty ? uiText.settings.saveBeforeActivating : uiText.settings.makeDefault"
              @click="activateProvider"
            >
              {{ uiText.settings.makeDefault }}
            </button>
          </div>
        </header>

        <div class="model-detail-scroll">
          <div v-if="modelError" class="settings-note error" role="alert">{{ modelError }}</div>

          <div class="model-detail-form">
          <section class="settings-group model-detail-group">
            <header class="settings-group-heading"><div><h3>{{ uiText.settings.connection }}</h3></div></header>
            <label class="settings-row"><span>{{ uiText.settings.name }}</span><input v-model="editingProvider.name" type="text" spellcheck="false" /></label>
            <label class="settings-row">
              <span>{{ uiText.settings.providerType }}</span>
              <select v-model="editingProvider.type"><option value="openai-compatible">OpenAI Compatible</option><option value="openai-responses">OpenAI Responses</option></select>
            </label>
            <label class="settings-row"><span>{{ uiText.settings.apiBaseUrl }}</span><input v-model="editingProvider.apiBaseUrl" type="url" spellcheck="false" /></label>
            <label class="settings-row">
              <span>{{ uiText.settings.apiKey }}</span>
              <span class="model-secret-control">
                <input v-model="editingProvider.apiKey" :type="apiKeyVisible ? 'text' : 'password'" spellcheck="false" autocomplete="off" />
                <button type="button" class="settings-icon-button" :title="apiKeyVisible ? uiText.settings.hideApiKey : uiText.settings.showApiKey" :aria-label="apiKeyVisible ? uiText.settings.hideApiKey : uiText.settings.showApiKey" @click.prevent="apiKeyVisible = !apiKeyVisible">
                  <EyeOff v-if="apiKeyVisible" :size="14" />
                  <Eye v-else :size="14" />
                </button>
              </span>
            </label>
            <div class="settings-row model-command-row">
              <div class="model-command-copy">
                <span>{{ uiText.settings.connectionStatus }}</span>
                <small :class="{ error: modelTest === 'error', success: modelTest === 'ok' }" role="status" aria-live="polite">{{ modelTestStatusText }}</small>
              </div>
              <button type="button" class="settings-secondary" :disabled="saving || modelTest === 'checking'" @click="testModel"><RotateCw :size="14" :class="{ spinning: modelTest === 'checking' }" />{{ modelTest === 'checking' ? uiText.settings.testing : uiText.settings.testConnection }}</button>
            </div>
          </section>

          <section class="settings-group model-detail-group">
            <header class="settings-group-heading"><div><h3>{{ uiText.settings.model }}</h3></div></header>
            <label class="settings-row">
              <span>{{ uiText.settings.model }}</span>
              <div class="settings-stacked-control">
                <div class="settings-inline-control">
                  <input v-model="editingProvider.model" list="model-options" type="text" spellcheck="false" />
                  <button type="button" class="settings-icon-button" :title="uiText.settings.loadModels" :aria-label="uiText.settings.loadModels" :disabled="loadingModels" @click.prevent="loadModelOptions"><RotateCw :size="14" :class="{ spinning: loadingModels }" /></button>
                </div>
                <small v-if="modelListMessage" aria-live="polite">{{ modelListMessage }}</small>
                <datalist id="model-options"><option v-for="model in modelOptions" :key="model" :value="model" /></datalist>
              </div>
            </label>
          </section>

          <section class="settings-group model-detail-group">
            <button
              type="button"
              class="settings-group-heading model-disclosure-heading"
              :aria-expanded="requestBehaviorExpanded"
              aria-controls="request-behavior-fields"
              @click="requestBehaviorExpanded = !requestBehaviorExpanded"
            >
              <div><h3>{{ uiText.settings.requestBehavior }}</h3><span>{{ advancedPreview }}</span></div>
              <ChevronRight :size="16" :class="{ expanded: requestBehaviorExpanded }" aria-hidden="true" />
            </button>
            <div v-show="requestBehaviorExpanded" id="request-behavior-fields">
              <label class="settings-row"><span>{{ uiText.settings.timeout }}</span><div class="settings-stacked-control"><input v-model.number="editingTimeoutSeconds" type="number" min="1" :max="MODEL_PROVIDER_TIMEOUT_MAX_MS / 1000" step="1" /><small>{{ uiText.settings.timeoutHint }}</small></div></label>
              <label class="settings-row"><span>{{ uiText.settings.retries }}</span><div class="settings-stacked-control"><input v-model.number="editingProvider.maxRetries" type="number" min="0" :max="MODEL_PROVIDER_MAX_RETRIES_MAX" step="1" /><small>{{ uiText.settings.retriesHint }}</small></div></label>
              <label v-if="!isOpenAIResponsesProvider" class="settings-row"><span>{{ uiText.settings.reasoningProvider }}</span><div class="settings-stacked-control"><select v-model="editingProvider.reasoningProvider"><option value="none">{{ uiText.settings.reasoningProviderNone }}</option><option value="llama.cpp">{{ uiText.settings.reasoningProviderLlamaCpp }}</option></select><small>{{ uiText.settings.reasoningProviderHint }}</small></div></label>
              <label v-if="showsReasoningEffort" class="settings-row"><span>{{ uiText.settings.reasoning }}</span><div class="settings-stacked-control"><select v-model="editingProvider.reasoningEffort"><option value="off">{{ uiText.settings.reasoningOff }}</option><option value="low">{{ uiText.settings.reasoningLow }}</option><option value="medium">{{ uiText.settings.reasoningMedium }}</option><option value="high">{{ uiText.settings.reasoningHigh }}</option><option value="max">{{ uiText.settings.reasoningMax }}</option></select><small>{{ isOpenAIResponsesProvider ? uiText.settings.responsesReasoningHint : uiText.settings.reasoningHint }}</small></div></label>
              <label v-if="isLlamaCppReasoning" class="settings-row"><span>{{ uiText.settings.showRawReasoning }}</span><div class="settings-stacked-control"><input v-model="editingProvider.showRawReasoning" class="settings-switch" type="checkbox" role="switch" /><small>{{ uiText.settings.showRawReasoningHint }}</small></div></label>
            </div>
          </section>

          </div>
        </div>

        <footer class="settings-actions model-detail-actions">
          <button type="button" class="settings-secondary" :disabled="saving || !isDirty" @click="revertProvider"><Undo2 :size="14" />{{ uiText.settings.revert }}</button>
          <button type="button" class="settings-primary" :disabled="saving || !isDirty" @click="saveModelProviders"><Save :size="14" />{{ uiText.settings.save }}</button>
        </footer>
      </div>
    </div>
  </div>

  <SettingsConfirmSheet
    :open="Boolean(pendingProviderAction)"
    dialog-id="model-discard-confirm"
    :title="uiText.settings.confirmDiscardChangesTitle"
    :description="uiText.settings.confirmDiscardModelChanges"
    :confirm-label="uiText.settings.confirmDiscardModelChangesAction"
    :cancel-label="uiText.settings.cancel"
    tone="neutral"
    @cancel="cancelDiscardChanges"
    @confirm="confirmDiscardChanges"
  />

  <SettingsConfirmSheet
    :open="deleteConfirmationOpen"
    dialog-id="model-delete-confirm"
    :title="uiText.settings.confirmDeleteProviderTitle"
    :description="uiText.settings.confirmDeleteProvider(editingProvider.name)"
    :confirm-label="uiText.settings.confirmDeleteProviderAction"
    :cancel-label="uiText.settings.cancel"
    :busy="saving"
    @cancel="cancelDeleteProvider"
    @confirm="confirmDeleteProvider"
  />
</template>
