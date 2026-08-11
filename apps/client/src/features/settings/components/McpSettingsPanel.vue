<script setup lang="ts">
import { Plus, RotateCw, Save, Server, ShieldCheck, Trash2, Undo2 } from 'lucide-vue-next'
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { uiText } from '../../../text/uiText'
import { apiFetch } from '../../../services/apiAccess'
import SettingsConfirmSheet from './SettingsConfirmSheet.vue'

type McpServerSummary = {
  id: string
  enabled: boolean
  command: string
  args: string[]
  timeout_ms: number
  trusted: boolean
}

const props = defineProps<{
  apiBase: string
}>()
const emit = defineEmits<{
  dirtyChange: [dirty: boolean]
}>()

type PendingNavigation =
  | { kind: 'add' }
  | { kind: 'server'; id: string }

const configPath = ref('')
const rawConfig = ref('')
const savedRawConfig = ref('')
const servers = ref<McpServerSummary[]>([])
const valid = ref(false)
const exists = ref(false)
const loading = ref(false)
const saving = ref(false)
const trustUpdatingServerId = ref('')
const message = ref('')
const error = ref('')
const restartRequired = ref(false)
const loaded = ref(false)
const hasUnsavedConfig = computed(() => rawConfig.value !== savedRawConfig.value)
const selectedServerId = ref('')
const addingServer = ref(false)
const detailView = ref<'form' | 'json'>('form')
const serverSaving = ref(false)
const serverDeleteTarget = ref<McpServerSummary | null>(null)
const serverDeleting = ref(false)
const serverDraft = reactive({ id: '', command: '', args: '', timeoutMs: '30000' })
const savedServerDraft = ref('')
const returnServerId = ref('')
const pendingNavigation = ref<PendingNavigation | null>(null)
savedServerDraft.value = draftSnapshot()

const selectedServer = computed(() => servers.value.find((server) => server.id === selectedServerId.value) || null)
const serverDraftDirty = computed(() => draftSnapshot() !== savedServerDraft.value)
const hasUnsavedChanges = computed(() => loaded.value && (hasUnsavedConfig.value || serverDraftDirty.value))
const serverDraftValid = computed(() => {
  const timeoutMs = Number(serverDraft.timeoutMs)
  return Boolean(serverDraft.command.trim())
    && Boolean(addingServer.value ? serverDraft.id.trim() : selectedServerId.value)
    && Number.isInteger(timeoutMs)
    && timeoutMs > 0
})
const serverDraftCanSave = computed(() => serverDraftValid.value && (addingServer.value || serverDraftDirty.value))

const statusText = computed(() => {
  if (loading.value) return uiText.settings.loading
  if (!exists.value) return uiText.mcp.noConfig
  return valid.value ? uiText.mcp.serverCount(servers.value.length) : uiText.mcp.invalidConfig
})

function toRecord(value: unknown) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function readApiError(data: unknown, status: number) {
  const errorValue = toRecord(toRecord(data).error).message
  return typeof errorValue === 'string' ? errorValue : `HTTP ${status}`
}

function isServerSummary(value: unknown): value is McpServerSummary {
  const server = toRecord(value)
  return typeof server.id === 'string'
    && typeof server.enabled === 'boolean'
    && typeof server.command === 'string'
    && Array.isArray(server.args)
    && server.args.every((item) => typeof item === 'string')
    && typeof server.timeout_ms === 'number'
    && typeof server.trusted === 'boolean'
}

function serverStatus(server: McpServerSummary) {
  if (!server.trusted) return uiText.mcp.needsApproval
  return server.enabled ? uiText.mcp.ready : uiText.mcp.paused
}

function draftSnapshot() {
  return JSON.stringify({
    id: serverDraft.id,
    command: serverDraft.command,
    args: serverDraft.args,
    timeoutMs: serverDraft.timeoutMs,
  })
}

function hydrateDraft(server: McpServerSummary | null) {
  serverDraft.id = server?.id || ''
  serverDraft.command = server?.command || ''
  serverDraft.args = server?.args.join('\n') || ''
  serverDraft.timeoutMs = String(server?.timeout_ms || 30_000)
  savedServerDraft.value = draftSnapshot()
}

function applyResult(data: unknown) {
  const result = toRecord(data)
  configPath.value = typeof result.path === 'string' ? result.path : configPath.value
  rawConfig.value = typeof result.raw === 'string' ? result.raw : rawConfig.value
  exists.value = Boolean(result.exists)
  valid.value = Boolean(result.valid)
  servers.value = Array.isArray(result.servers) ? result.servers.filter(isServerSummary) : []
  restartRequired.value = Boolean(result.restart_required)
  error.value = typeof result.error === 'string' ? result.error : ''
  return result
}

function applySavedResult(data: unknown) {
  applyResult(data)
  savedRawConfig.value = rawConfig.value
}

async function loadMcpSettings() {
  loading.value = true
  error.value = ''
  message.value = ''
  try {
    const response = await apiFetch(`${props.apiBase}/api/settings/mcp`)
    const data = await response.json() as unknown
    if (!response.ok) throw new Error(readApiError(data, response.status))
    applyResult(data)
    savedRawConfig.value = rawConfig.value
    if (!addingServer.value) syncSelectedServer()
  } catch (err) {
    error.value = err instanceof Error ? err.message : uiText.mcp.loadFailed
  } finally {
    loading.value = false
    loaded.value = true
  }
}

async function saveMcpSettings() {
  saving.value = true
  error.value = ''
  message.value = ''
  try {
    const response = await apiFetch(`${props.apiBase}/api/settings/mcp`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw: rawConfig.value }),
    })
    const data = await response.json() as unknown
    if (!response.ok) throw new Error(readApiError(data, response.status))
    const result = applyResult(data)
    if (!result.valid) return
    savedRawConfig.value = rawConfig.value
    if (addingServer.value) {
      addingServer.value = false
      pendingNavigation.value = null
      selectedServerId.value = servers.value[0]?.id || ''
    }
    syncSelectedServer()
    message.value = uiText.mcp.restartRequired
  } catch (err) {
    error.value = err instanceof Error ? err.message : uiText.mcp.saveFailed
  } finally {
    saving.value = false
  }
}

async function setServerTrust(server: McpServerSummary) {
  if (hasUnsavedChanges.value) return
  trustUpdatingServerId.value = server.id
  error.value = ''
  message.value = ''
  try {
    const response = await apiFetch(`${props.apiBase}/api/settings/mcp/${encodeURIComponent(server.id)}/trust`, {
      method: server.trusted ? 'DELETE' : 'POST',
    })
    const data = await response.json() as unknown
    if (!response.ok) throw new Error(readApiError(data, response.status))
    applySavedResult(data)
    syncSelectedServer()
    message.value = uiText.mcp.trustGranted
  } catch (err) {
    error.value = err instanceof Error ? err.message : uiText.mcp.trustFailed
  } finally {
    trustUpdatingServerId.value = ''
  }
}

function beginAddServer() {
  returnServerId.value = selectedServerId.value
  selectedServerId.value = ''
  addingServer.value = true
  detailView.value = 'form'
  hydrateDraft(null)
  error.value = ''
}

function beginSelectServer(server: McpServerSummary) {
  selectedServerId.value = server.id
  addingServer.value = false
  detailView.value = 'form'
  hydrateDraft(server)
  error.value = ''
}

function syncSelectedServer() {
  if (addingServer.value) return
  const server = selectedServer.value || servers.value[0]
  if (server) beginSelectServer(server)
  else {
    selectedServerId.value = ''
    hydrateDraft(null)
  }
}

function requestNavigation(next: PendingNavigation) {
  if (hasUnsavedChanges.value) {
    pendingNavigation.value = next
    return
  }
  commitNavigation(next)
}

function commitNavigation(next: PendingNavigation) {
  pendingNavigation.value = null
  if (next.kind === 'add') {
    beginAddServer()
    return
  }
  const server = servers.value.find((candidate) => candidate.id === next.id)
  if (server) beginSelectServer(server)
}

async function discardPendingNavigation() {
  const next = pendingNavigation.value
  pendingNavigation.value = null
  if (hasUnsavedConfig.value) await loadMcpSettings()
  if (next) commitNavigation(next)
}

function cancelPendingNavigation() {
  pendingNavigation.value = null
}

function openAddServer() {
  requestNavigation({ kind: 'add' })
}

function selectServer(server: McpServerSummary) {
  requestNavigation({ kind: 'server', id: server.id })
}

function cancelServerDraft() {
  if (serverSaving.value) return
  pendingNavigation.value = null
  if (addingServer.value) {
    const server = servers.value.find((candidate) => candidate.id === returnServerId.value)
    if (server) beginSelectServer(server)
    else {
      addingServer.value = false
      selectedServerId.value = ''
      hydrateDraft(null)
    }
    return
  }
  if (selectedServer.value) hydrateDraft(selectedServer.value)
}

function revertRawConfig() {
  if (saving.value) return
  rawConfig.value = savedRawConfig.value
  error.value = ''
}

function serverArgs() {
  return serverDraft.args.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)
}

async function saveServer() {
  const timeoutMs = Number(serverDraft.timeoutMs)
  if (serverSaving.value || !serverDraft.command.trim() || (!addingServer.value && !selectedServerId.value) || (addingServer.value && !serverDraft.id.trim()) || !Number.isInteger(timeoutMs) || timeoutMs <= 0) return
  serverSaving.value = true
  error.value = ''
  message.value = ''
  try {
    const response = await apiFetch(`${props.apiBase}/api/settings/mcp/servers${addingServer.value ? '' : `/${encodeURIComponent(selectedServerId.value)}`}`, {
      method: addingServer.value ? 'POST' : 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...(addingServer.value ? { id: serverDraft.id.trim() } : {}),
        command: serverDraft.command.trim(),
        args: serverArgs(),
        timeout_ms: timeoutMs,
      }),
    })
    const data = await response.json() as unknown
    if (!response.ok) throw new Error(readApiError(data, response.status))
    applySavedResult(data)
    addingServer.value = false
    selectedServerId.value = serverDraft.id.trim()
    syncSelectedServer()
    message.value = uiText.mcp.restartRequired
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : uiText.mcp.saveFailed
  } finally {
    serverSaving.value = false
  }
}

async function toggleServer(server: McpServerSummary) {
  if (serverSaving.value || !server.trusted || hasUnsavedChanges.value) return
  serverSaving.value = true
  error.value = ''
  try {
    const response = await apiFetch(`${props.apiBase}/api/settings/mcp/servers/${encodeURIComponent(server.id)}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: !server.enabled }),
    })
    const data = await response.json() as unknown
    if (!response.ok) throw new Error(readApiError(data, response.status))
    applySavedResult(data)
    syncSelectedServer()
    message.value = uiText.mcp.restartRequired
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : uiText.mcp.saveFailed
  } finally {
    serverSaving.value = false
  }
}

function requestDeleteServer(server: McpServerSummary) {
  if (serverDeleting.value) return
  serverDeleteTarget.value = server
}

function cancelDeleteServer() {
  if (serverDeleting.value) return
  serverDeleteTarget.value = null
}

async function confirmDeleteServer() {
  const target = serverDeleteTarget.value
  if (!target || serverDeleting.value) return
  serverDeleting.value = true
  error.value = ''
  try {
    const response = await apiFetch(`${props.apiBase}/api/settings/mcp/servers/${encodeURIComponent(target.id)}`, { method: 'DELETE' })
    const data = await response.json() as unknown
    if (!response.ok) throw new Error(readApiError(data, response.status))
    applySavedResult(data)
    serverDeleteTarget.value = null
    addingServer.value = false
    selectedServerId.value = ''
    syncSelectedServer()
    message.value = uiText.mcp.removed
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : uiText.mcp.removeFailed
  } finally {
    serverDeleting.value = false
  }
}

onMounted(() => {
  void loadMcpSettings()
})
watch(hasUnsavedChanges, (dirty) => emit('dirtyChange', dirty), { immediate: true })
onBeforeUnmount(() => emit('dirtyChange', false))
</script>

<template>
  <div class="settings-section settings-record-page">
    <div class="settings-record-layout">
        <aside class="settings-record-source" :aria-label="uiText.mcp.servers">
          <header class="settings-record-heading">
            <div class="settings-record-heading-text">
              <h3>{{ uiText.mcp.servers }}</h3>
              <span>{{ servers.length ? uiText.mcp.serverCount(servers.length) : uiText.mcp.serversDescription }}</span>
            </div>
            <button type="button" class="settings-icon-button" :title="uiText.mcp.reload" :aria-label="uiText.mcp.reload" :disabled="loading || hasUnsavedChanges" @click="loadMcpSettings"><RotateCw :size="14" :class="{ spinning: loading }" /></button>
          </header>
          <div v-if="servers.length === 0" class="settings-record-empty mcp-source-empty">
            <Server :size="18" stroke-width="1.7" />
            <span>{{ loading ? uiText.settings.loading : uiText.mcp.noServers }}</span>
          </div>
          <div v-else class="settings-record-source-list" role="listbox" :aria-label="uiText.mcp.servers">
            <button
              v-for="server in servers"
              :key="server.id"
              type="button"
              class="settings-record-source-row mcp-server-row"
              role="option"
              :aria-selected="server.id === selectedServerId"
              :class="{ active: server.id === selectedServerId }"
              @click="selectServer(server)"
            >
              <span class="settings-row-icon" aria-hidden="true"><Server :size="16" /></span>
              <span class="settings-list-copy">
                <strong>{{ server.id }}</strong>
                <span>{{ serverStatus(server) }}</span>
              </span>
            </button>
          </div>

          <footer class="settings-record-source-footer">
            <button type="button" class="settings-secondary settings-record-add" :disabled="loading" @click="openAddServer">
              <Plus :size="14" />{{ uiText.mcp.add }}
            </button>
          </footer>
        </aside>

        <section class="settings-record-detail" :aria-label="uiText.mcp.serverDetails">
          <div v-if="addingServer || selectedServer" class="settings-record-detail-view">
            <header class="settings-record-heading">
              <div class="settings-record-heading-copy">
                <span class="settings-record-icon" aria-hidden="true"><Server :size="17" /></span>
                <div class="settings-record-heading-text">
                  <h3>{{ addingServer ? uiText.mcp.addServer : selectedServer?.id }}</h3>
                  <span>{{ addingServer ? uiText.mcp.editorDescription : uiText.mcp.localTool }}</span>
                </div>
              </div>
              <div class="settings-record-heading-actions">
                <span v-if="hasUnsavedChanges" class="settings-dirty-status">{{ uiText.settings.unsaved }}</span>
                <span v-if="selectedServer" class="mcp-server-status" :class="{ ready: selectedServer.enabled && selectedServer.trusted, warning: !selectedServer.trusted }">{{ serverStatus(selectedServer) }}</span>
                <button v-if="selectedServer && !selectedServer.trusted" type="button" class="settings-secondary" :disabled="hasUnsavedChanges || trustUpdatingServerId === selectedServer.id" @click="setServerTrust(selectedServer)"><ShieldCheck :size="14" />{{ uiText.mcp.allow }}</button>
                <label v-else-if="selectedServer" class="mcp-server-toggle" :title="selectedServer.enabled ? uiText.mcp.pause : uiText.mcp.enable">
                  <input class="settings-switch" type="checkbox" role="switch" :checked="selectedServer.enabled" :disabled="serverSaving || hasUnsavedChanges" :aria-label="uiText.mcp.toggleLabel(selectedServer.id)" @change="toggleServer(selectedServer)" />
                </label>
                <div class="settings-segmented" role="tablist" :aria-label="uiText.mcp.viewMode">
                  <button type="button" role="tab" :aria-selected="detailView === 'form'" :class="{ active: detailView === 'form' }" @click="detailView = 'form'">{{ uiText.mcp.form }}</button>
                  <button type="button" role="tab" :aria-selected="detailView === 'json'" :class="{ active: detailView === 'json' }" @click="detailView = 'json'">{{ uiText.mcp.json }}</button>
                </div>
              </div>
            </header>

            <div class="mcp-feedback-slot" :class="{ error: Boolean(error) }" role="status" aria-live="polite">
              {{ error || message || (restartRequired ? uiText.mcp.restartRequired : '') }}
            </div>

            <form v-if="detailView === 'form'" class="mcp-server-form" @submit.prevent="saveServer">
              <div class="settings-record-detail-scroll mcp-server-editor-fields">
                <div class="mcp-form-row">
                  <label>
                    <span>{{ uiText.mcp.name }}</span>
                    <input v-model="serverDraft.id" :disabled="!addingServer" required pattern="[A-Za-z0-9_-]+" maxlength="200" autocomplete="off" />
                    <small>{{ uiText.mcp.nameHint }}</small>
                  </label>
                  <label>
                    <span>{{ uiText.mcp.transport }}</span>
                    <select disabled aria-readonly="true"><option value="stdio">{{ uiText.mcp.stdio }}</option></select>
                  </label>
                </div>
                <div class="mcp-form-row mcp-form-row-narrow">
                  <label>
                    <span>{{ uiText.mcp.timeoutMs }}</span>
                    <input v-model="serverDraft.timeoutMs" type="number" min="1" max="3600000" step="1000" required />
                    <small>{{ uiText.mcp.timeoutHint }}</small>
                  </label>
                </div>
                <label>
                  <span>{{ uiText.mcp.command }}</span>
                  <input v-model="serverDraft.command" required maxlength="2000" spellcheck="false" autocomplete="off" :placeholder="uiText.mcp.commandPlaceholder" />
                </label>
                <label>
                  <span>{{ uiText.mcp.arguments }}</span>
                  <textarea v-model="serverDraft.args" spellcheck="false" :placeholder="uiText.mcp.argumentsPlaceholder"></textarea>
                  <small>{{ uiText.mcp.argumentsHint }}</small>
                </label>
              </div>
              <footer class="settings-record-detail-actions">
                <button v-if="selectedServer" type="button" class="settings-danger-ghost" :disabled="serverSaving || hasUnsavedChanges" @click="requestDeleteServer(selectedServer)"><Trash2 :size="14" />{{ uiText.mcp.remove }}</button>
                <span v-else></span>
                <div class="settings-record-actions-right">
                  <button type="button" class="settings-secondary" :disabled="serverSaving || (!addingServer && !serverDraftDirty)" @click="cancelServerDraft"><Undo2 v-if="!addingServer" :size="14" />{{ addingServer ? uiText.settings.cancel : uiText.settings.revert }}</button>
                  <button type="submit" class="settings-primary" :disabled="serverSaving || !serverDraftCanSave"><Save :size="14" />{{ serverSaving ? uiText.mcp.saving : uiText.settings.save }}</button>
                </div>
              </footer>
            </form>

            <div v-else class="mcp-json-view">
              <div class="mcp-config-path">
                <span>{{ uiText.mcp.configFile }}</span>
                <code :title="configPath">{{ configPath }}</code>
              </div>
              <label class="mcp-editor-field">
                <span>{{ uiText.mcp.configurationJson }}</span>
                <textarea v-model="rawConfig" class="mcp-config-editor" spellcheck="false" :disabled="loading || saving"></textarea>
              </label>
              <footer class="settings-record-detail-actions">
                <button v-if="selectedServer" type="button" class="settings-danger-ghost" :disabled="saving || hasUnsavedConfig" @click="requestDeleteServer(selectedServer)"><Trash2 :size="14" />{{ uiText.mcp.remove }}</button>
                <span v-else class="mcp-json-status">{{ statusText }}</span>
                <div class="settings-record-actions-right">
                  <button type="button" class="settings-secondary" :disabled="saving || !hasUnsavedConfig" @click="revertRawConfig"><Undo2 :size="14" />{{ uiText.settings.revert }}</button>
                  <button type="button" class="settings-primary" :disabled="saving || loading || !hasUnsavedConfig" @click="saveMcpSettings"><Save :size="14" />{{ saving ? uiText.mcp.saving : uiText.settings.save }}</button>
                </div>
              </footer>
            </div>
          </div>

          <div v-else class="settings-record-empty">
            <Server :size="20" stroke-width="1.7" />
            <strong>{{ uiText.mcp.noServerSelected }}</strong>
            <span>{{ uiText.mcp.empty }}</span>
            <button type="button" class="settings-primary" @click="openAddServer"><Plus :size="14" />{{ uiText.mcp.add }}</button>
          </div>
        </section>
      </div>
  </div>

  <SettingsConfirmSheet
    :open="Boolean(pendingNavigation)"
    dialog-id="mcp-discard-confirm"
    :title="uiText.settings.confirmDiscardChangesTitle"
    :description="uiText.settings.confirmDiscardSettingsChanges"
    :confirm-label="uiText.settings.confirmDiscardModelChangesAction"
    :cancel-label="uiText.settings.cancel"
    tone="neutral"
    @cancel="cancelPendingNavigation"
    @confirm="discardPendingNavigation"
  />

  <SettingsConfirmSheet
    :open="Boolean(serverDeleteTarget)"
    dialog-id="mcp-delete-confirm"
    :title="uiText.mcp.removeServer"
    :description="serverDeleteTarget ? uiText.mcp.confirmRemove(serverDeleteTarget.id) : ''"
    :confirm-label="uiText.mcp.remove"
    :cancel-label="uiText.mcp.cancel"
    :busy="serverDeleting"
    @cancel="cancelDeleteServer"
    @confirm="confirmDeleteServer"
  />
</template>
