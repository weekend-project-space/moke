import { computed, ref, watch, type Ref } from 'vue'
import { activeModelFromSettings, type ActiveModelInfo } from '../model/activeModel'
import type { ReasoningEffort } from '../model/conversation'

type ComposerReasoningEffort = 'default' | ReasoningEffort

type ReasoningCapability = {
  efforts: ReasoningEffort[]
  supported: boolean
}

type UseComposerReasoningOptions = {
  apiBase: string
  serverStatus: Readonly<Ref<'checking' | 'online' | 'offline'>>
}

const COMPOSER_REASONING_KEY = 'moke.composer.reasoning-effort.v1'

function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return value === 'off' || value === 'low' || value === 'medium' || value === 'high' || value === 'max'
}

export function useComposerReasoning(options: UseComposerReasoningOptions) {
  const activeModel = ref<ActiveModelInfo | null>(null)
  const composerReasoningEffort = ref<ComposerReasoningEffort>('default')
  const reasoningCapability = ref<ReasoningCapability>({ efforts: [], supported: false })
  const composerReasoningOptions = computed(() =>
    reasoningCapability.value.supported ? reasoningCapability.value.efforts : [],
  )

  function normalizeSelection() {
    if (composerReasoningEffort.value === 'default') return
    if (
      !reasoningCapability.value.supported ||
      !reasoningCapability.value.efforts.includes(composerReasoningEffort.value)
    ) {
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
      const response = await fetch(`${options.apiBase}/api/settings`)
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
      activeModel.value = activeModelFromSettings(settings)
      reasoningCapability.value = {
        efforts,
        supported: capability.supported === true && efforts.length > 0,
      }
      normalizeSelection()
    } catch {
      activeModel.value = null
      reasoningCapability.value = { efforts: [], supported: false }
      composerReasoningEffort.value = 'default'
    }
  }

  function currentRunOptions() {
    return composerReasoningEffort.value === 'default'
      ? undefined
      : { reasoningEffort: composerReasoningEffort.value }
  }

  watch(composerReasoningEffort, (value) => {
    try {
      window.localStorage.setItem(COMPOSER_REASONING_KEY, value)
    } catch {
      // Keep the in-memory choice when localStorage is unavailable.
    }
  })

  return {
    activeModel,
    composerReasoningEffort,
    composerReasoningOptions,
    currentRunOptions,
    loadCapability,
    loadStoredSelection,
  }
}
