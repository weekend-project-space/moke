<script setup lang="ts">
import { Cookie, Database, Folder, FolderX, RotateCw, Trash2 } from 'lucide-vue-next'
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import WorkspaceLayout from '../../../components/layout/WorkspaceLayout.vue'
import { apiFetch } from '../../../services/apiAccess'
import McpSettingsPanel from './McpSettingsPanel.vue'
import ModelSettingsPanel from './ModelSettingsPanel.vue'
import SettingsConfirmSheet from './SettingsConfirmSheet.vue'
import SettingsSidebar from './SettingsSidebar.vue'
import SkillSettingsPanel from './SkillSettingsPanel.vue'
import MessagingSettingsPanel from './MessagingSettingsPanel.vue'
import {
  DEFAULT_BROWSER_PREFERENCES,
  loadBrowserPreferences,
  saveBrowserPreferences as persistBrowserPreferences,
  type BrowserPreferences,
} from '../../browser'
import { browserApi, isNativeBrowserAvailable, type BrowserDataKind } from '../../browser/api/browser'
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
}>()

const route = useRoute()
const router = useRouter()
const activeSettingsTab = computed(() => {
  const tab = route.params.tab
  return typeof tab === 'string' && settingsNavigationItems.some((item) => item.id === tab) ? tab as SettingsTab : 'model'
})
const activeSettingsItem = computed(() => settingsNavigationItems.find((item) => item.id === activeSettingsTab.value) || settingsNavigationItems[0])
const modelSettingsDirty = ref(false)
const settingsDirty = computed(() => modelSettingsDirty.value)
const pendingSettingsTab = ref<SettingsTab | null>(null)
const browserSettings = reactive<BrowserPreferences>({ ...DEFAULT_BROWSER_PREFERENCES })
const browserDataAvailable = isNativeBrowserAvailable()
const clearingBrowserData = ref<BrowserDataKind | null>(null)
const browserDataStatus = ref<{ tone: 'success' | 'error'; text: string } | null>(null)
const browserDataConfirmationOpen = ref(false)
const permissions = ref<WorkspaceRootPermission[]>([])
const loadingPermissions = ref(false)
const permissionError = ref('')
const permissionToRevoke = ref<WorkspaceRootPermission | null>(null)
const revokingPermission = ref(false)
function loadBrowserSettings() {
  Object.assign(browserSettings, loadBrowserPreferences())
}

function updateBrowserSearchEngine() {
  persistBrowserPreferences(browserSettings)
}

async function loadPermissions() {
  loadingPermissions.value = true
  permissionError.value = ''
  try {
    const response = await apiFetch(`${props.apiBase}/api/settings/permissions`)
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const data = await response.json()
    permissions.value = data.workspace_roots || []
  } catch {
    permissionError.value = uiText.settings.permissionsLoadFailed
  } finally {
    loadingPermissions.value = false
  }
}

function requestPermissionRevoke(permission: WorkspaceRootPermission) {
  if (revokingPermission.value) return
  permissionToRevoke.value = permission
}

function cancelPermissionRevoke() {
  if (revokingPermission.value) return
  permissionToRevoke.value = null
}

async function confirmPermissionRevoke() {
  const permission = permissionToRevoke.value
  if (!permission || revokingPermission.value) return

  revokingPermission.value = true
  permissionError.value = ''
  try {
    const response = await apiFetch(`${props.apiBase}/api/settings/permissions/revoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: permission.path }),
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const data = await response.json()
    permissions.value = data.workspace_roots || []
    permissionToRevoke.value = null
  } catch {
    permissionError.value = uiText.settings.removePermissionFailed
  } finally {
    revokingPermission.value = false
  }
}

function formatPermissionDate(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return uiText.settings.permissionAuthorized
  return uiText.settings.permissionAdded(date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }))
}

function requestBrowserDataClear(kind: BrowserDataKind) {
  if (!browserDataAvailable || clearingBrowserData.value) return
  if (kind === 'cookies') {
    browserDataConfirmationOpen.value = true
    return
  }

  void clearBrowserData(kind)
}

function cancelBrowserDataClear() {
  if (clearingBrowserData.value) return
  browserDataConfirmationOpen.value = false
}

async function confirmBrowserDataClear() {
  if (clearingBrowserData.value) return
  await clearBrowserData('cookies')
  browserDataConfirmationOpen.value = false
}

async function clearBrowserData(kind: BrowserDataKind) {
  if (!browserDataAvailable || clearingBrowserData.value) return

  clearingBrowserData.value = kind
  browserDataStatus.value = null
  try {
    await browserApi.clearBrowsingData(kind)
    browserDataStatus.value = {
      tone: 'success',
      text: kind === 'cache' ? uiText.settings.cacheCleared : uiText.settings.cookiesCleared,
    }
  } catch {
    browserDataStatus.value = { tone: 'error', text: uiText.settings.clearBrowserDataFailed }
  } finally {
    clearingBrowserData.value = null
  }
}

function selectSettingsTab(tab: SettingsTab) {
  if (tab === activeSettingsTab.value) return
  if (activeSettingsTab.value === 'model' && modelSettingsDirty.value) {
    pendingSettingsTab.value = tab
    return
  }
  void router.push({ name: 'settings', params: { tab } })
}

function cancelSettingsTabChange() {
  pendingSettingsTab.value = null
}

function confirmSettingsTabChange() {
  const tab = pendingSettingsTab.value
  if (!tab) return
  pendingSettingsTab.value = null
  if (activeSettingsTab.value === 'model') modelSettingsDirty.value = false
  void router.push({ name: 'settings', params: { tab } })
}

function closeSettings() {
  emit('close')
}

function updateModelSettingsDirty(dirty: boolean) {
  modelSettingsDirty.value = dirty
}

watch(settingsDirty, (dirty) => emit('dirtyChange', dirty), { immediate: true })

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
            <h2>{{ activeSettingsItem.label }}</h2>
          </div>
        </header>

        <div class="settings-content-scroll" :class="{ 'model-settings-scroll': activeSettingsTab === 'model' }">
          <div class="settings-content-frame">
          <ModelSettingsPanel v-if="activeSettingsTab === 'model'" :api-base="apiBase" @dirty-change="updateModelSettingsDirty" />

    <McpSettingsPanel v-else-if="activeSettingsTab === 'mcp'" :api-base="apiBase" />

    <SkillSettingsPanel v-else-if="activeSettingsTab === 'skills'" :api-base="apiBase" />

    <MessagingSettingsPanel v-else-if="activeSettingsTab === 'messaging'" :api-base="apiBase" />

    <div v-else-if="activeSettingsTab === 'permissions'" class="settings-section permissions-settings">
      <div class="settings-group">
        <header class="settings-group-heading">
          <div>
            <h3>{{ uiText.settings.authorizedFolders }}</h3>
            <span>{{ uiText.settings.authorizedFoldersDescription }}</span>
          </div>
          <button
            type="button"
            class="settings-icon-button"
            :title="uiText.settings.refresh"
            :aria-label="uiText.settings.refresh"
            :disabled="loadingPermissions"
            @click="loadPermissions"
          >
            <RotateCw :size="14" :class="{ spinning: loadingPermissions }" />
          </button>
        </header>
        <div v-if="permissionError" class="settings-note error" role="alert">{{ permissionError }}</div>
        <div v-if="loadingPermissions && permissions.length === 0" class="settings-note">{{ uiText.settings.loading }}</div>
        <div v-else-if="permissions.length === 0 && !permissionError" class="settings-empty-state">
          <Folder :size="18" stroke-width="1.7" />
          <span>{{ uiText.settings.noPermissions }}</span>
        </div>
        <div v-else-if="permissions.length > 0" class="permission-list">
          <div v-for="permission in permissions" :key="permission.path" class="settings-list-row permission-row">
            <div class="settings-list-main">
              <span class="settings-row-icon" aria-hidden="true"><Folder :size="16" /></span>
              <div class="settings-list-copy">
                <code :title="permission.path">{{ permission.path }}</code>
                <time :datetime="permission.added_at">{{ formatPermissionDate(permission.added_at) }}</time>
              </div>
            </div>
            <button
              type="button"
              class="settings-icon-button"
              :title="uiText.settings.remove"
              :aria-label="uiText.settings.removePermissionLabel(permission.path)"
              :disabled="revokingPermission"
              @click="requestPermissionRevoke(permission)"
            >
              <FolderX :size="14" />
            </button>
          </div>
        </div>
      </div>
    </div>

    <div v-else-if="activeSettingsTab === 'browser'" class="settings-section browser-settings">
      <div class="settings-group">
        <header class="settings-group-heading">
          <div><h3>{{ uiText.settings.browserSearch }}</h3></div>
        </header>
        <label class="settings-row browser-search-row">
          <span>{{ uiText.settings.searchEngine }}</span>
          <select v-model="browserSettings.searchEngine" @change="updateBrowserSearchEngine">
            <option value="bing">{{ uiText.settings.searchEngineBing }}</option>
            <option value="google">{{ uiText.settings.searchEngineGoogle }}</option>
            <option value="baidu">{{ uiText.settings.searchEngineBaidu }}</option>
          </select>
        </label>
      </div>

      <div class="settings-group">
        <header class="settings-group-heading">
          <div><h3>{{ uiText.settings.browserData }}</h3></div>
        </header>
        <div class="browser-data-action">
          <div class="browser-data-copy">
            <span class="browser-data-icon" aria-hidden="true">
              <Database :size="16" />
            </span>
            <div>
              <strong>{{ uiText.settings.browserCache }}</strong>
              <small>{{ uiText.settings.clearCacheDescription }}</small>
            </div>
          </div>
          <button
            type="button"
            class="settings-secondary browser-clear-button"
            :disabled="!browserDataAvailable || clearingBrowserData !== null"
            :title="browserDataAvailable ? uiText.settings.clearCache : uiText.settings.desktopOnly"
            @click="requestBrowserDataClear('cache')"
          >
            <Trash2 :size="14" />
            {{ clearingBrowserData === 'cache' ? uiText.settings.clearing : uiText.settings.clearCache }}
          </button>
        </div>
        <div class="browser-data-action browser-data-action-last">
          <div class="browser-data-copy">
            <span class="browser-data-icon" aria-hidden="true">
              <Cookie :size="16" />
            </span>
            <div>
              <strong>{{ uiText.settings.browserCookies }}</strong>
              <small>{{ uiText.settings.clearCookiesDescription }}</small>
            </div>
          </div>
          <button
            type="button"
            class="settings-secondary browser-clear-button"
            :disabled="!browserDataAvailable || clearingBrowserData !== null"
            :title="browserDataAvailable ? uiText.settings.clearCookies : uiText.settings.desktopOnly"
            @click="requestBrowserDataClear('cookies')"
          >
            <Trash2 :size="14" />
            {{ clearingBrowserData === 'cookies' ? uiText.settings.clearing : uiText.settings.clearCookies }}
          </button>
        </div>
        <div v-if="browserDataStatus" class="settings-note" :class="browserDataStatus.tone" role="status" aria-live="polite">
          {{ browserDataStatus.text }}
        </div>
        <div v-else-if="!browserDataAvailable" class="settings-note">
          {{ uiText.settings.desktopOnly }}
        </div>
      </div>
    </div>
          </div>
        </div>
      </section>
  </WorkspaceLayout>

  <SettingsConfirmSheet
    :open="Boolean(pendingSettingsTab)"
    dialog-id="model-tab-discard-confirm"
    :title="uiText.settings.confirmDiscardChangesTitle"
    :description="uiText.settings.confirmDiscardModelChanges"
    :confirm-label="uiText.settings.confirmDiscardModelChangesAction"
    :cancel-label="uiText.settings.cancel"
    tone="neutral"
    @cancel="cancelSettingsTabChange"
    @confirm="confirmSettingsTabChange"
  />

  <SettingsConfirmSheet
    :open="Boolean(permissionToRevoke)"
    dialog-id="permission-revoke-confirm"
    :title="uiText.settings.confirmRevokePermissionTitle"
    :description="uiText.settings.confirmRevokePermission(permissionToRevoke?.path || '')"
    :confirm-label="uiText.settings.confirmRevokePermissionAction"
    :cancel-label="uiText.settings.cancel"
    :busy="revokingPermission"
    @cancel="cancelPermissionRevoke"
    @confirm="confirmPermissionRevoke"
  />

  <SettingsConfirmSheet
    :open="browserDataConfirmationOpen"
    dialog-id="browser-data-confirm"
    :title="uiText.settings.confirmClearCookiesTitle"
    :description="uiText.settings.confirmClearCookies"
    :confirm-label="uiText.settings.confirmClearCookiesAction"
    :cancel-label="uiText.settings.cancel"
    :busy="clearingBrowserData === 'cookies'"
    @cancel="cancelBrowserDataClear"
    @confirm="confirmBrowserDataClear"
  />
</template>
