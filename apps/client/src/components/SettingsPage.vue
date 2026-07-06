<script setup lang="ts">
import { FolderX, Plus, RotateCw, Save, SendHorizontal, Trash2 } from 'lucide-vue-next'
import { computed, onMounted, reactive, ref } from 'vue'
import McpSettingsPanel from './McpSettingsPanel.vue'

type WorkspaceRootPermission = {
  path: string
  added_at: string
}

type ModelProviderProfile = {
  id: string
  name: string
  type: 'openai-compatible'
  model: string
  apiBaseUrl: string
  apiKey: string
  timeoutMs: number
}

type BrowserSettings = {
  browserHomeUrl: string
  linkOpenMode: 'current' | 'new-tab'
}

type SettingsTab = 'model' | 'mcp' | 'permissions' | 'browser'

const props = defineProps<{
  apiBase: string
}>()

const emit = defineEmits<{
  close: []
  openBrowserUrl: [url: string]
}>()

const BROWSER_SETTINGS_KEY = 'moke.browser-settings.v1'
const MODEL_PROVIDER_TIMEOUT_MAX_MS = 60 * 60 * 1000
const settingsTabs: Array<{ id: SettingsTab; label: string }> = [
  { id: 'model', label: 'Model' },
  { id: 'mcp', label: 'MCP' },
  { id: 'permissions', label: 'Permissions' },
  { id: 'browser', label: 'Browser' },
]
const activeSettingsTab = ref<SettingsTab>('model')
const activeProviderId = ref('')
const selectedProviderId = ref('')
const providers = ref<ModelProviderProfile[]>([])
const editingProvider = reactive<ModelProviderProfile>(createProvider())
const browserSettings = reactive<BrowserSettings>({
  browserHomeUrl: 'https://www.baidu.com/',
  linkOpenMode: 'current',
})
const permissions = ref<WorkspaceRootPermission[]>([])
const modelOptions = ref<string[]>([])
const loadingPermissions = ref(false)
const loadingModels = ref(false)
const permissionError = ref('')
const modelError = ref('')
const saved = ref(false)
const modelTest = ref<'idle' | 'checking' | 'ok' | 'error'>('idle')
const modelTestMessage = ref('')
const modelListMessage = ref('')
const selectedProvider = computed(() => providers.value.find((provider) => provider.id === selectedProviderId.value) || null)

function createProvider(): ModelProviderProfile {
  return {
    id: `provider_${Date.now()}_${Math.random().toString(16).slice(2, 6)}`,
    name: 'Local Qwen',
    type: 'openai-compatible',
    apiKey: 'test',
    apiBaseUrl: 'http://localhost:8080/v1',
    model: 'qwen3.6-35BA3B',
    timeoutMs: 30 * 60 * 1000,
  }
}

function copyProvider(provider: ModelProviderProfile) {
  Object.assign(editingProvider, { ...provider })
}

function syncEditingProvider() {
  const provider = selectedProvider.value || providers.value[0]
  if (!provider) return
  selectedProviderId.value = provider.id
  copyProvider(provider)
}

function loadBrowserSettings() {
  try {
    const stored = JSON.parse(window.localStorage.getItem(BROWSER_SETTINGS_KEY) || '{}') as Partial<BrowserSettings>
    Object.assign(browserSettings, {
      ...browserSettings,
      ...stored,
      linkOpenMode: stored.linkOpenMode === 'new-tab' ? 'new-tab' : 'current',
    })
  } catch {
    // Keep defaults.
  }
}

function saveBrowserSettings() {
  window.localStorage.setItem(BROWSER_SETTINGS_KEY, JSON.stringify(browserSettings))
  markSaved()
}

function markSaved() {
  saved.value = true
  window.setTimeout(() => {
    saved.value = false
  }, 1500)
}

async function loadSettings() {
  modelError.value = ''
  try {
    const response = await fetch(`${props.apiBase}/api/settings`)
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const data = await response.json()
    providers.value = Array.isArray(data.providers) && data.providers.length > 0 ? data.providers : [createProvider()]
    activeProviderId.value = data.activeProviderId || providers.value[0].id
    selectedProviderId.value = activeProviderId.value
    syncEditingProvider()
  } catch {
    modelError.value = '模型设置加载失败'
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
    const response = await fetch(`${props.apiBase}/api/settings/model-providers`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        activeProviderId: nextActiveProviderId,
        providers: nextProviders,
      }),
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const data = await response.json()
    providers.value = data.providers || nextProviders
    activeProviderId.value = data.activeProviderId || nextActiveProviderId
    selectedProviderId.value = editingProvider.id
    syncEditingProvider()
    markSaved()
  } catch {
    modelError.value = '模型设置保存失败'
  }
}

function selectProvider(provider: ModelProviderProfile) {
  selectedProviderId.value = provider.id
  copyProvider(provider)
  modelOptions.value = []
  modelListMessage.value = ''
  modelTestMessage.value = ''
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

async function activateProvider() {
  await saveModelProviders(editingProvider.id)
}

async function testModel() {
  modelTest.value = 'checking'
  modelTestMessage.value = ''
  try {
    const response = await fetch(`${props.apiBase}/api/settings/model/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(editingProvider),
    })
    const data = await response.json()
    modelTest.value = response.ok && data.ok ? 'ok' : 'error'
    modelTestMessage.value = data.message || (data.ok ? '模型可用' : '模型测试失败')
    if (Array.isArray(data.models)) modelOptions.value = data.models
  } catch {
    modelTest.value = 'error'
    modelTestMessage.value = '模型测试失败'
  }
}

async function loadModelOptions() {
  loadingModels.value = true
  modelListMessage.value = ''
  try {
    const response = await fetch(`${props.apiBase}/api/settings/model/list`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(editingProvider),
    })
    const data = await response.json()
    if (!response.ok || !data.ok) throw new Error(data.message || `HTTP ${response.status}`)
    modelOptions.value = data.models || []
    modelListMessage.value = modelOptions.value.length > 0 ? `已加载 ${modelOptions.value.length} 个模型` : '没有可用模型'
  } catch (error) {
    modelOptions.value = []
    modelListMessage.value = error instanceof Error ? error.message : '模型加载失败'
  } finally {
    loadingModels.value = false
  }
}

async function loadPermissions() {
  loadingPermissions.value = true
  permissionError.value = ''
  try {
    const response = await fetch(`${props.apiBase}/api/settings/permissions`)
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const data = await response.json()
    permissions.value = data.workspace_roots || []
  } catch {
    permissionError.value = '授权目录加载失败'
  } finally {
    loadingPermissions.value = false
  }
}

async function revokePermission(path: string) {
  permissionError.value = ''
  try {
    const response = await fetch(`${props.apiBase}/api/settings/permissions/revoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const data = await response.json()
    permissions.value = data.workspace_roots || []
  } catch {
    permissionError.value = '移除授权失败'
  }
}

function openHomeUrl() {
  const url = browserSettings.browserHomeUrl.trim()
  if (url) emit('openBrowserUrl', url)
}

onMounted(() => {
  loadBrowserSettings()
  void loadSettings()
  void loadPermissions()
})
</script>

<template>
  <section class="settings-page">
    <header class="settings-header">
      <button type="button" class="settings-secondary" @click="emit('close')">返回对话</button>
    </header>

    <nav class="settings-tabs" aria-label="Settings sections">
      <button
        v-for="tab in settingsTabs"
        :key="tab.id"
        type="button"
        :class="{ active: activeSettingsTab === tab.id }"
        @click="activeSettingsTab = tab.id"
      >
        {{ tab.label }}
      </button>
    </nav>

    <div v-if="activeSettingsTab === 'model'" class="settings-section">
      <div class="settings-section-heading">
        <h3>模型</h3>
        <span>{{ modelTestMessage || modelListMessage }}</span>
      </div>
      <div v-if="modelError" class="settings-note error">{{ modelError }}</div>

      <div class="provider-settings">
        <aside class="provider-list">
          <button
            v-for="provider in providers"
            :key="provider.id"
            type="button"
            :class="{ active: provider.id === selectedProviderId }"
            @click="selectProvider(provider)"
          >
            <strong>{{ provider.name }}</strong>
            <small>{{ provider.model }}<span v-if="provider.id === activeProviderId"> · 当前</span></small>
          </button>
          <button type="button" class="provider-add" @click="addProvider">
            <Plus :size="14" />
            新增 Provider
          </button>
        </aside>

        <div class="provider-form">
          <label class="settings-row">
            <span>名称</span>
            <input v-model="editingProvider.name" type="text" spellcheck="false" />
          </label>
          <label class="settings-row">
            <span>类型</span>
            <select v-model="editingProvider.type">
              <option value="openai-compatible">OpenAI Compatible</option>
            </select>
          </label>
          <label class="settings-row">
            <span>API Base URL</span>
            <input v-model="editingProvider.apiBaseUrl" type="url" spellcheck="false" />
          </label>
          <label class="settings-row">
            <span>API Key</span>
            <input v-model="editingProvider.apiKey" type="password" spellcheck="false" autocomplete="off" />
          </label>
          <label class="settings-row">
            <span>Model</span>
            <div class="settings-inline-control">
              <input v-model="editingProvider.model" list="model-options" type="text" spellcheck="false" />
              <button type="button" class="settings-secondary" :disabled="loadingModels" @click="loadModelOptions">
                {{ loadingModels ? '加载中' : '加载模型' }}
              </button>
              <datalist id="model-options">
                <option v-for="model in modelOptions" :key="model" :value="model" />
              </datalist>
            </div>
          </label>
          <label class="settings-row">
            <span>Timeout</span>
            <input v-model.number="editingProvider.timeoutMs" type="number" min="1000" :max="MODEL_PROVIDER_TIMEOUT_MAX_MS" step="1000" />
          </label>

          <div class="settings-actions">
            <button type="button" class="settings-secondary" @click="testModel">
              <RotateCw :size="14" />
              {{ modelTest === 'checking' ? '测试中' : '测试模型' }}
            </button>
            <button type="button" class="settings-secondary" :disabled="editingProvider.id === activeProviderId" @click="activateProvider">
              设为当前
            </button>
            <button type="button" class="settings-secondary" :disabled="providers.length <= 1" @click="deleteProvider">
              <Trash2 :size="14" />
              删除
            </button>
            <button type="button" class="settings-primary" @click="saveModelProviders()">
              <Save :size="14" />
              {{ saved ? '已保存' : '保存' }}
            </button>
          </div>
        </div>
      </div>
    </div>

    <McpSettingsPanel v-else-if="activeSettingsTab === 'mcp'" :api-base="apiBase" />

    <div v-else-if="activeSettingsTab === 'permissions'" class="settings-section">
      <div class="settings-section-heading">
        <h3>权限</h3>
        <button type="button" class="settings-icon-button" title="刷新" aria-label="刷新" @click="loadPermissions">
          <RotateCw :size="14" />
        </button>
      </div>
      <div v-if="permissionError" class="settings-note error">{{ permissionError }}</div>
      <div v-else-if="loadingPermissions" class="settings-note">正在加载</div>
      <div v-else-if="permissions.length === 0" class="settings-note">暂无授权目录</div>
      <div v-else class="permission-list">
        <div v-for="permission in permissions" :key="permission.path" class="permission-row">
          <span>{{ permission.path }}</span>
          <button type="button" title="移除" aria-label="移除" @click="revokePermission(permission.path)">
            <FolderX :size="14" />
          </button>
        </div>
      </div>
    </div>

    <div v-else-if="activeSettingsTab === 'browser'" class="settings-section">
      <div class="settings-section-heading">
        <h3>浏览器</h3>
      </div>
      <label class="settings-row">
        <span>默认首页</span>
        <input v-model="browserSettings.browserHomeUrl" type="url" spellcheck="false" />
      </label>
      <label class="settings-row">
        <span>链接打开方式</span>
        <select v-model="browserSettings.linkOpenMode">
          <option value="current">当前标签</option>
          <option value="new-tab">新标签</option>
        </select>
      </label>
      <div class="settings-actions">
        <button type="button" class="settings-secondary" @click="openHomeUrl">
          <SendHorizontal :size="14" />
          打开首页
        </button>
        <button type="button" class="settings-primary" @click="saveBrowserSettings">
          <Save :size="14" />
          {{ saved ? '已保存' : '保存' }}
        </button>
      </div>
    </div>
  </section>
</template>
