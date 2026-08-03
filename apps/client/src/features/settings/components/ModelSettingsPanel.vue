<script setup lang="ts">
import { Plus, RotateCw, Save, Trash2 } from 'lucide-vue-next'
import { computed, onMounted, reactive, ref } from 'vue'

import { uiText } from '../../../text/uiText'
import { apiFetch } from '../../../services/apiAccess'

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

const MODEL_PROVIDER_MAX_RETRIES_MAX = 6
const MODEL_PROVIDER_TIMEOUT_MAX_MS = 60 * 60 * 1000
const activeProviderId = ref('')
const selectedProviderId = ref('')
const providers = ref<ModelProviderProfile[]>([])
const editingProvider = reactive<ModelProviderProfile>(createProvider())
const modelOptions = ref<string[]>([])
const loadingModels = ref(false)
const modelError = ref('')
const saved = ref(false)
const modelTest = ref<'idle' | 'checking' | 'ok' | 'error'>('idle')
const modelTestMessage = ref('')
const modelListMessage = ref('')
const selectedProvider = computed(() => providers.value.find((provider) => provider.id === selectedProviderId.value) || null)
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

function createProvider(): ModelProviderProfile {
  return {
    id: `provider_${Date.now()}_${Math.random().toString(16).slice(2, 6)}`,
    name: 'Local Qwen',
    type: 'openai-compatible',
    apiKey: 'test',
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

function copyProvider(provider: ModelProviderProfile) {
  Object.assign(editingProvider, {
    ...provider,
    maxRetries: Number.isFinite(Number(provider.maxRetries)) ? provider.maxRetries : 3,
    reasoningEffort: normalizeReasoningEffort(provider.reasoningEffort),
    reasoningProvider: provider.reasoningProvider === 'llama.cpp' ? 'llama.cpp' : 'none',
    showRawReasoning: Boolean(provider.showRawReasoning),
  })
}

function syncEditingProvider() {
  const provider = selectedProvider.value || providers.value[0]
  if (!provider) return
  selectedProviderId.value = provider.id
  copyProvider(provider)
}

function markSaved() {
  saved.value = true
  window.setTimeout(() => { saved.value = false }, 1500)
}

async function loadSettings() {
  modelError.value = ''
  try {
    const response = await apiFetch(`${props.apiBase}/api/settings`)
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const data = await response.json()
    providers.value = Array.isArray(data.providers) && data.providers.length > 0 ? data.providers : [createProvider()]
    activeProviderId.value = data.activeProviderId || providers.value[0].id
    selectedProviderId.value = activeProviderId.value
    syncEditingProvider()
  } catch {
    modelError.value = uiText.settings.loadFailed
    providers.value = [createProvider()]
    activeProviderId.value = providers.value[0].id
    selectedProviderId.value = providers.value[0].id
    syncEditingProvider()
  }
}

async function saveModelProviders(nextActiveProviderId = activeProviderId.value) {
  modelError.value = ''
  try {
    const nextProviders = providers.value.map((provider) =>
      provider.id === editingProvider.id ? { ...editingProvider } : provider,
    )
    const response = await apiFetch(`${props.apiBase}/api/settings/model-providers`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ activeProviderId: nextActiveProviderId, providers: nextProviders }),
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const data = await response.json()
    providers.value = data.providers || nextProviders
    activeProviderId.value = data.activeProviderId || nextActiveProviderId
    selectedProviderId.value = editingProvider.id
    syncEditingProvider()
    markSaved()
  } catch {
    modelError.value = uiText.settings.modelSaveFailed
  }
}

function selectProvider(provider: ModelProviderProfile) {
  selectedProviderId.value = provider.id
  copyProvider(provider)
  modelOptions.value = []
  modelListMessage.value = ''
  modelTestMessage.value = ''
}

function selectProviderFromEvent(event: Event) {
  const provider = providers.value.find((item) => item.id === (event.target as HTMLSelectElement).value)
  if (provider) selectProvider(provider)
}

function addProvider() {
  const provider = createProvider()
  provider.name = `Provider ${providers.value.length + 1}`
  providers.value = [...providers.value, provider]
  selectProvider(provider)
}

async function deleteProvider() {
  if (providers.value.length <= 1) return
  const nextProviders = providers.value.filter((provider) => provider.id !== editingProvider.id)
  providers.value = nextProviders
  const nextActiveProviderId = activeProviderId.value === editingProvider.id ? nextProviders[0].id : activeProviderId.value
  selectedProviderId.value = nextActiveProviderId
  syncEditingProvider()
  await saveModelProviders(nextActiveProviderId)
}

async function testModel() {
  modelTest.value = 'checking'
  modelTestMessage.value = ''
  try {
    const response = await apiFetch(`${props.apiBase}/api/settings/model/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(editingProvider),
    })
    const data = await response.json()
    modelTest.value = response.ok && data.ok ? 'ok' : 'error'
    modelTestMessage.value = data.message || (data.ok ? uiText.settings.modelAvailable : uiText.settings.modelTestFailed)
    if (Array.isArray(data.models)) modelOptions.value = data.models
  } catch {
    modelTest.value = 'error'
    modelTestMessage.value = uiText.settings.modelTestFailed
  }
}

async function loadModelOptions() {
  loadingModels.value = true
  modelListMessage.value = ''
  try {
    const response = await apiFetch(`${props.apiBase}/api/settings/model/list`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(editingProvider),
    })
    const data = await response.json()
    if (!response.ok || !data.ok) throw new Error(data.message || `HTTP ${response.status}`)
    modelOptions.value = data.models || []
    modelListMessage.value = modelOptions.value.length > 0 ? uiText.settings.modelsLoaded(modelOptions.value.length) : uiText.settings.noModels
  } catch (error) {
    modelOptions.value = []
    modelListMessage.value = error instanceof Error ? error.message : uiText.settings.modelLoadFailed
  } finally {
    loadingModels.value = false
  }
}

onMounted(() => { void loadSettings() })
</script>

<template>
  <div class="settings-section model-settings">
    <div class="provider-settings">
      <section class="model-form-group provider-profile-group">
        <div class="model-group-heading">
          <h3>{{ uiText.settings.providerProfile }}</h3>
          <span v-if="editingProvider.id === activeProviderId" class="model-provider-status">{{ uiText.settings.active }}</span>
        </div>
        <div class="provider-toolbar">
          <div class="provider-selector">
            <select :value="selectedProviderId" :aria-label="uiText.settings.providerProfile" @change="selectProviderFromEvent">
              <option v-for="provider in providers" :key="provider.id" :value="provider.id">{{ provider.name }}</option>
            </select>
            <small>{{ editingProvider.model }}</small>
          </div>
          <button type="button" class="settings-icon-button" :title="uiText.settings.addProvider" :aria-label="uiText.settings.addProvider" @click="addProvider"><Plus :size="14" /></button>
        </div>
      </section>

      <div v-if="modelError" class="settings-note error">{{ modelError }}</div>

      <div class="provider-form">
        <section class="model-form-group">
          <div class="model-group-heading"><h3>{{ uiText.settings.connection }}</h3></div>
          <label class="settings-row"><span>{{ uiText.settings.name }}</span><input v-model="editingProvider.name" type="text" spellcheck="false" /></label>
          <label class="settings-row">
            <span>{{ uiText.settings.providerType }}</span>
            <select v-model="editingProvider.type"><option value="openai-compatible">OpenAI Compatible</option><option value="openai-responses">OpenAI Responses</option></select>
          </label>
          <label class="settings-row"><span>{{ uiText.settings.apiBaseUrl }}</span><input v-model="editingProvider.apiBaseUrl" type="url" spellcheck="false" /></label>
          <label class="settings-row"><span>{{ uiText.settings.apiKey }}</span><input v-model="editingProvider.apiKey" type="password" spellcheck="false" autocomplete="off" /></label>
        </section>

        <section class="model-form-group">
          <div class="model-group-heading"><h3>{{ uiText.settings.model }}</h3></div>
          <label class="settings-row">
            <span>{{ uiText.settings.model }}</span>
            <div class="settings-stacked-control">
              <div class="settings-inline-control">
                <input v-model="editingProvider.model" list="model-options" type="text" spellcheck="false" />
                <button type="button" class="settings-secondary" :disabled="loadingModels" @click="loadModelOptions">{{ loadingModels ? uiText.settings.loading : uiText.settings.loadModels }}</button>
              </div>
              <small v-if="modelListMessage" aria-live="polite">{{ modelListMessage }}</small>
              <datalist id="model-options"><option v-for="model in modelOptions" :key="model" :value="model" /></datalist>
            </div>
          </label>
          <details class="settings-advanced">
            <summary><span>{{ uiText.settings.advanced }}</span><small>{{ advancedPreview }}</small></summary>
            <label class="settings-row"><span>{{ uiText.settings.timeout }}</span><div class="settings-stacked-control"><input v-model.number="editingTimeoutSeconds" type="number" min="1" :max="MODEL_PROVIDER_TIMEOUT_MAX_MS / 1000" step="1" /><small>{{ uiText.settings.timeoutHint }}</small></div></label>
            <label class="settings-row"><span>{{ uiText.settings.retries }}</span><div class="settings-stacked-control"><input v-model.number="editingProvider.maxRetries" type="number" min="0" :max="MODEL_PROVIDER_MAX_RETRIES_MAX" step="1" /><small>{{ uiText.settings.retriesHint }}</small></div></label>
            <label v-if="!isOpenAIResponsesProvider" class="settings-row"><span>{{ uiText.settings.reasoningProvider }}</span><div class="settings-stacked-control"><select v-model="editingProvider.reasoningProvider"><option value="none">{{ uiText.settings.reasoningProviderNone }}</option><option value="llama.cpp">{{ uiText.settings.reasoningProviderLlamaCpp }}</option></select><small>{{ uiText.settings.reasoningProviderHint }}</small></div></label>
            <label v-if="showsReasoningEffort" class="settings-row"><span>{{ uiText.settings.reasoning }}</span><div class="settings-stacked-control"><select v-model="editingProvider.reasoningEffort"><option value="off">{{ uiText.settings.reasoningOff }}</option><option value="low">{{ uiText.settings.reasoningLow }}</option><option value="medium">{{ uiText.settings.reasoningMedium }}</option><option value="high">{{ uiText.settings.reasoningHigh }}</option><option value="max">{{ uiText.settings.reasoningMax }}</option></select><small>{{ isOpenAIResponsesProvider ? uiText.settings.responsesReasoningHint : uiText.settings.reasoningHint }}</small></div></label>
            <label v-if="isLlamaCppReasoning" class="settings-row"><span>{{ uiText.settings.showRawReasoning }}</span><div class="settings-stacked-control"><input v-model="editingProvider.showRawReasoning" type="checkbox" /><small>{{ uiText.settings.showRawReasoningHint }}</small></div></label>
          </details>
        </section>

        <div class="settings-actions model-actions">
          <button type="button" class="settings-secondary model-delete-action" :disabled="providers.length <= 1" @click="deleteProvider"><Trash2 :size="14" />{{ uiText.settings.delete }}</button>
          <span v-if="modelTestMessage" class="model-test-message" aria-live="polite">{{ modelTestMessage }}</span>
          <div class="model-primary-actions">
            <button type="button" class="settings-secondary" @click="testModel"><RotateCw :size="14" />{{ modelTest === 'checking' ? uiText.settings.testing : uiText.settings.testModel }}</button>
            <button type="button" class="settings-secondary" :disabled="editingProvider.id === activeProviderId" @click="saveModelProviders(editingProvider.id)">{{ uiText.settings.setActive }}</button>
            <button type="button" class="settings-primary" @click="saveModelProviders()"><Save :size="14" />{{ saved ? uiText.settings.saved : uiText.settings.save }}</button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
