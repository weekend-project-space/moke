<script setup lang="ts">
import { ArrowLeft, FolderX, RotateCw, Save, SendHorizontal } from 'lucide-vue-next'
import { computed, onMounted, reactive, ref } from 'vue'
import WorkspaceLayout from '../../../components/layout/WorkspaceLayout.vue'
import McpSettingsPanel from './McpSettingsPanel.vue'
import ModelSettingsPanel from './ModelSettingsPanel.vue'
import SettingsSidebar from './SettingsSidebar.vue'
import SkillSettingsPanel from './SkillSettingsPanel.vue'
import MessagingSettingsPanel from './MessagingSettingsPanel.vue'
import {
  DEFAULT_BROWSER_PREFERENCES,
  loadBrowserPreferences,
  saveBrowserPreferences as persistBrowserPreferences,
  type BrowserLinkOpenMode,
  type BrowserPreferences,
} from '../../browser'
import { uiText } from '../../../text/uiText'
import { settingsNavigationItems, type SettingsTab } from '../model/settingsNavigation'

type WorkspaceRootPermission = {
  path: string
  added_at: string
}

const props = defineProps<{
  apiBase: string
}>()

const emit = defineEmits<{
  close: []
  dirtyChange: [dirty: boolean]
  openBrowserUrl: [request: { url: string; mode: BrowserLinkOpenMode }]
}>()

const activeSettingsTab = ref<SettingsTab>('model')
const activeSettingsItem = computed(() => settingsNavigationItems.find((item) => item.id === activeSettingsTab.value) || settingsNavigationItems[0])
const skillSettingsDirty = ref(false)
const browserSettings = reactive<BrowserPreferences>({ ...DEFAULT_BROWSER_PREFERENCES })
const permissions = ref<WorkspaceRootPermission[]>([])
const loadingPermissions = ref(false)
const permissionError = ref('')
const saved = ref(false)
function loadBrowserSettings() {
  Object.assign(browserSettings, loadBrowserPreferences())
}

function saveBrowserSettings() {
  persistBrowserPreferences(browserSettings)
  markSaved()
}

function markSaved() {
  saved.value = true
  window.setTimeout(() => {
    saved.value = false
  }, 1500)
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
    permissionError.value = uiText.settings.permissionsLoadFailed
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
    permissionError.value = uiText.settings.removePermissionFailed
  }
}

function openHomeUrl() {
  const url = browserSettings.browserHomeUrl.trim()
  if (url) emit('openBrowserUrl', { url, mode: browserSettings.linkOpenMode })
}

function selectSettingsTab(tab: SettingsTab) {
  if (tab === activeSettingsTab.value) return
  if (activeSettingsTab.value === 'skills' && skillSettingsDirty.value && !window.confirm(uiText.skills.discardChanges)) return
  activeSettingsTab.value = tab
}

function closeSettings() {
  emit('close')
}

function updateSkillSettingsDirty(dirty: boolean) {
  skillSettingsDirty.value = dirty
  emit('dirtyChange', dirty)
}

onMounted(() => {
  loadBrowserSettings()
  void loadPermissions()
})
</script>

<template>
  <WorkspaceLayout class="settings-workspace-layout" sidebar-label="Resize settings navigation">
    <template #sidebar>
      <SettingsSidebar
        :active-tab="activeSettingsTab"
        @close="closeSettings"
        @select="selectSettingsTab"
      />
    </template>

      <section class="settings-content">
        <header class="settings-content-header">
          <div class="settings-content-frame settings-content-header-inner">
            <button
              type="button"
              class="settings-back-button"
              :title="uiText.settings.returnToChat"
              :aria-label="uiText.settings.returnToChat"
              @click="closeSettings"
            >
              <ArrowLeft :size="16" stroke-width="2" />
            </button>
            <h2>{{ activeSettingsItem.label }}</h2>
          </div>
        </header>

        <div class="settings-content-scroll">
          <div class="settings-content-frame">
          <ModelSettingsPanel v-if="activeSettingsTab === 'model'" :api-base="apiBase" />

    <McpSettingsPanel v-else-if="activeSettingsTab === 'mcp'" :api-base="apiBase" />

    <SkillSettingsPanel
      v-else-if="activeSettingsTab === 'skills'"
      :api-base="apiBase"
      @dirty-change="updateSkillSettingsDirty"
    />

    <MessagingSettingsPanel v-else-if="activeSettingsTab === 'messaging'" :api-base="apiBase" />

    <div v-else-if="activeSettingsTab === 'permissions'" class="settings-section">
      <div class="settings-section-heading">
        <button type="button" class="settings-icon-button" :title="uiText.settings.refresh" :aria-label="uiText.settings.refresh" @click="loadPermissions">
          <RotateCw :size="14" />
        </button>
      </div>
      <div v-if="permissionError" class="settings-note error">{{ permissionError }}</div>
      <div v-else-if="loadingPermissions" class="settings-note">{{ uiText.settings.loading }}</div>
      <div v-else-if="permissions.length === 0" class="settings-note">{{ uiText.settings.noPermissions }}</div>
      <div v-else class="permission-list">
        <div v-for="permission in permissions" :key="permission.path" class="permission-row">
          <span>{{ permission.path }}</span>
          <button type="button" :title="uiText.settings.remove" :aria-label="uiText.settings.remove" @click="revokePermission(permission.path)">
            <FolderX :size="14" />
          </button>
        </div>
      </div>
    </div>

    <div v-else-if="activeSettingsTab === 'browser'" class="settings-section">
      <label class="settings-row">
        <span>{{ uiText.settings.defaultHome }}</span>
        <input v-model="browserSettings.browserHomeUrl" type="url" spellcheck="false" />
      </label>
      <label class="settings-row">
        <span>{{ uiText.settings.homeOpenMode }}</span>
        <select v-model="browserSettings.linkOpenMode">
          <option value="current">{{ uiText.settings.currentTab }}</option>
          <option value="new-tab">{{ uiText.settings.newTab }}</option>
        </select>
      </label>
      <label class="settings-row">
        <span>{{ uiText.settings.searchEngine }}</span>
        <select v-model="browserSettings.searchEngine">
          <option value="bing">{{ uiText.settings.searchEngineBing }}</option>
          <option value="google">{{ uiText.settings.searchEngineGoogle }}</option>
          <option value="baidu">{{ uiText.settings.searchEngineBaidu }}</option>
        </select>
      </label>
      <div class="settings-actions">
        <button type="button" class="settings-secondary" @click="openHomeUrl">
          <SendHorizontal :size="14" />
          {{ uiText.settings.openHome }}
        </button>
        <button type="button" class="settings-primary" @click="saveBrowserSettings">
          <Save :size="14" />
          {{ saved ? uiText.settings.saved : uiText.settings.save }}
        </button>
      </div>
    </div>
          </div>
        </div>
      </section>
  </WorkspaceLayout>
</template>
