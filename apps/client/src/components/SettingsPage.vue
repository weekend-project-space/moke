<script setup lang="ts">
import { FolderX, RotateCw, Save, SendHorizontal } from 'lucide-vue-next'
import { onMounted, reactive, ref } from 'vue'

type WorkspaceRootPermission = {
  path: string
  added_at: string
}

type ModelSettings = {
  model: string
  apiBaseUrl: string
  apiKey: string
  timeoutMs: number
}

type BrowserSettings = {
  browserHomeUrl: string
  linkOpenMode: 'current' | 'new-tab'
}

const props = defineProps<{
  apiBase: string
}>()

const emit = defineEmits<{
  close: []
  openBrowserUrl: [url: string]
}>()

const BROWSER_SETTINGS_KEY = 'moke.browser-settings.v1'
const modelSettings = reactive<ModelSettings>({
  model: 'gpt-4.1-mini',
  apiBaseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  timeoutMs: 15000,
})
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

function loadBrowserSettings() {
  try {
    const stored = JSON.parse(window.localStorage.getItem(BROWSER_SETTINGS_KEY) || '{}') as Partial<BrowserSettings>
    Object.assign(browserSettings, {
      ...browserSettings,
      ...stored,
      linkOpenMode: stored.linkOpenMode === 'new-tab' ? 'new-tab' : 'current',
    })
  } catch {
    // Ignore broken local settings and keep defaults.
  }
}

function saveBrowserSettings() {
  window.localStorage.setItem(BROWSER_SETTINGS_KEY, JSON.stringify(browserSettings))
  saved.value = true
  window.setTimeout(() => {
    saved.value = false
  }, 1500)
}

async function loadModelSettings() {
  modelError.value = ''
  try {
    const response = await fetch(`${props.apiBase}/api/settings`)
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const data = await response.json()
    Object.assign(modelSettings, {
      apiKey: data.model?.apiKey || '',
      apiBaseUrl: data.model?.apiBaseUrl || 'https://api.openai.com/v1',
      model: data.model?.model || 'gpt-4.1-mini',
      timeoutMs: data.model?.timeoutMs || 15000,
    })
  } catch {
    modelError.value = '模型设置加载失败'
  }
}

async function saveModelSettings() {
  modelError.value = ''
  try {
    const response = await fetch(`${props.apiBase}/api/settings/model`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(modelSettings),
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const data = await response.json()
    Object.assign(modelSettings, data.model || {})
    saved.value = true
    window.setTimeout(() => {
      saved.value = false
    }, 1500)
  } catch {
    modelError.value = '模型设置保存失败'
  }
}

async function testModel() {
  modelTest.value = 'checking'
  modelTestMessage.value = ''
  try {
    const response = await fetch(`${props.apiBase}/api/settings/model/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(modelSettings),
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
      body: JSON.stringify(modelSettings),
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
  void loadModelSettings()
  void loadPermissions()
})
</script>

<template>
  <section class="settings-page">
    <header class="settings-header">
      <div>
        <h2>设置</h2>
        <p>模型、权限和浏览器</p>
      </div>
      <button type="button" class="settings-secondary" @click="emit('close')">返回对话</button>
    </header>

    <div class="settings-section">
      <div class="settings-section-heading">
        <h3>模型</h3>
        <span>{{ modelTestMessage || modelListMessage }}</span>
      </div>
      <div v-if="modelError" class="settings-note error">{{ modelError }}</div>
      <label class="settings-row">
        <span>API Base URL</span>
        <input v-model="modelSettings.apiBaseUrl" type="url" spellcheck="false" />
      </label>
      <label class="settings-row">
        <span>API Key</span>
        <input v-model="modelSettings.apiKey" type="password" spellcheck="false" autocomplete="off" />
      </label>
      <label class="settings-row">
        <span>Model</span>
        <div class="settings-inline-control">
          <input v-model="modelSettings.model" list="model-options" type="text" spellcheck="false" />
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
        <input v-model.number="modelSettings.timeoutMs" type="number" min="1000" step="1000" />
      </label>
      <div class="settings-actions">
        <button type="button" class="settings-secondary" @click="testModel">
          <RotateCw :size="14" />
          {{ modelTest === 'checking' ? '测试中' : '测试模型' }}
        </button>
        <button type="button" class="settings-primary" @click="saveModelSettings">
          <Save :size="14" />
          {{ saved ? '已保存' : '保存' }}
        </button>
      </div>
    </div>

    <div class="settings-section">
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

    <div class="settings-section">
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
