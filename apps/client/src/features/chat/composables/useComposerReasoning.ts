import { computed, ref, watch, type Ref } from 'vue'
import { activeModelFromSettings, type ActiveModelInfo } from '../model/activeModel'
import type { ReasoningEffort } from '../model/conversation'
import { apiFetch } from '../../../services/apiAccess'
import { createAgentApi } from '../api/agentApi'
import type { ModelProviderModels, ModelSelection, ModelSummary } from '@moke/agent-sdk'

type ComposerReasoningEffort = 'default' | ReasoningEffort

type ReasoningCapability = {
  efforts: ReasoningEffort[]
  supported: boolean
}

type UseComposerReasoningOptions = {
  apiBase: string
  serverStatus: Readonly<Ref<'checking' | 'online' | 'offline'>>
  selectedModel: Readonly<Ref<ModelSelection | undefined>>
  backendReasoningEffort: Readonly<Ref<ReasoningEffort | null | undefined>>
  setModel: (model: ModelSelection) => Promise<boolean>
}

const COMPOSER_REASONING_KEY = 'moke.composer.reasoning-effort.v1'
const DEFAULT_REASONING_EFFORTS: ReasoningEffort[] = ['off', 'low', 'medium', 'high', 'max']

function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return value === 'off' || value === 'low' || value === 'medium' || value === 'high' || value === 'max'
}

export function useComposerReasoning(options: UseComposerReasoningOptions) {
  const api = createAgentApi(options.apiBase)
  const defaultModel = ref<ActiveModelInfo | null>(null)
  const modelProviders = ref<ModelProviderModels[]>([])
  const composerReasoningEffort = ref<ComposerReasoningEffort>('default')
  const defaultReasoningCapability = ref<ReasoningCapability>({ efforts: [], supported: false })
  const composerModelOptions = computed(() => modelProviders.value.flatMap((group) =>
    group.models.map((model) => ({ provider: group.provider, providerName: group.providerName, ...model })),
  ))
  const selectedProvider = computed(() => {
    const selected = options.selectedModel.value
    return selected && modelProviders.value.find((item) => item.provider === selected.provider_id)
  })
  const selectedModelOption = computed<ModelSummary | undefined>(() => {
    const selected = options.selectedModel.value
    const provider = selectedProvider.value
    return provider?.models.find((model) => model.name === selected?.name) || provider?.models[0]
  })
  const activeModel = computed<ActiveModelInfo | null>(() => {
    const selected = options.selectedModel.value
    if (!selected) return defaultModel.value
    const provider = selectedProvider.value
    const model = selected.name || provider?.models[0]?.name
    if (!model) return defaultModel.value
    return {
      model,
      providerId: selected.provider_id,
      providerName: provider?.providerName || provider?.provider || selected.provider_id,
    }
  })
  const composerReasoningOptions = computed(() => {
    const selected = options.selectedModel.value
    const supported = selected
      ? selectedModelOption.value?.supportsReasoning
      : defaultReasoningCapability.value.supported
    if (supported !== true) return []
    return defaultReasoningCapability.value.efforts.length
      ? defaultReasoningCapability.value.efforts
      : DEFAULT_REASONING_EFFORTS
  })

  function normalizeSelection() {
    if (composerReasoningEffort.value === 'default') return
    if (!composerReasoningOptions.value.includes(composerReasoningEffort.value)) {
      composerReasoningEffort.value = 'default'
    }
  }

  function loadStoredSelection() {
    try {
      const stored = window.localStorage.getItem(COMPOSER_REASONING_KEY)
      if (stored === 'default' || isReasoningEffort(stored)) composerReasoningEffort.value = stored
    } catch {
      composerReasoningEffort.value = 'default'
    }
  }

  async function loadCapability() {
    if (options.serverStatus.value !== 'online') return

    try {
      const response = await apiFetch(`${options.apiBase}/api/settings`)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const data: unknown = await response.json()
      const settings = data !== null && typeof data === 'object' && !Array.isArray(data)
        ? data as Record<string, unknown>
        : {}
      const capability = settings.reasoningCapability !== null
        && typeof settings.reasoningCapability === 'object'
        && !Array.isArray(settings.reasoningCapability)
        ? settings.reasoningCapability as Record<string, unknown>
        : {}
      const efforts = Array.isArray(capability.efforts)
        ? capability.efforts.filter(isReasoningEffort)
        : []
      defaultModel.value = activeModelFromSettings(settings)
      modelProviders.value = await api.models.list()
      defaultReasoningCapability.value = {
        efforts,
        supported: capability.supported === true && efforts.length > 0,
      }
      normalizeSelection()
    } catch {
      defaultModel.value = null
      modelProviders.value = []
      defaultReasoningCapability.value = { efforts: [], supported: false }
      composerReasoningEffort.value = 'default'
    }
  }

  async function selectModel(model: { provider: string; providerName?: string; name: string; supportsReasoning?: boolean }) {
    return options.setModel({ provider_id: model.provider, name: model.name })
  }

  function currentRunEnvironment() {
    return composerReasoningEffort.value === 'default'
      ? { reasoningEffort: null }
      : { reasoningEffort: composerReasoningEffort.value }
  }

  watch(composerReasoningEffort, (value) => {
    try {
      window.localStorage.setItem(COMPOSER_REASONING_KEY, value)
    } catch {
      // Keep the in-memory choice when localStorage is unavailable.
    }
  })

  watch(composerReasoningOptions, normalizeSelection)

  watch(options.backendReasoningEffort, (effort) => {
    if (effort === undefined) return
    composerReasoningEffort.value = effort && isReasoningEffort(effort) ? effort : 'default'
  }, { immediate: true })

  return {
    activeModel,
    composerReasoningEffort,
    composerReasoningOptions,
    composerModelOptions,
    currentRunEnvironment,
    loadCapability,
    loadStoredSelection,
    selectModel,
  }
}
