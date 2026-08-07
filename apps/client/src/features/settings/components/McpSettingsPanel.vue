<script setup lang="ts">
import { Pencil, Plus, RotateCw, Save, Server, ShieldCheck, Trash2, X } from 'lucide-vue-next'
import { computed, onMounted, reactive, ref } from 'vue'
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
const hasUnsavedConfig = computed(() => rawConfig.value !== savedRawConfig.value)
const serverEditorOpen = ref(false)
const editingServerId = ref<string | null>(null)
const serverSaving = ref(false)
const serverDeleteTarget = ref<McpServerSummary | null>(null)
const serverDeleting = ref(false)
const serverDraft = reactive({ id: '', command: '', args: '' })

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
  } catch (err) {
    error.value = err instanceof Error ? err.message : uiText.mcp.loadFailed
  } finally {
    loading.value = false
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
    message.value = uiText.mcp.savedRestart
  } catch (err) {
    error.value = err instanceof Error ? err.message : uiText.mcp.saveFailed
  } finally {
    saving.value = false
  }
}

async function setServerTrust(server: McpServerSummary) {
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
    message.value = uiText.mcp.trustGranted
  } catch (err) {
    error.value = err instanceof Error ? err.message : uiText.mcp.trustFailed
  } finally {
    trustUpdatingServerId.value = ''
  }
}

function openAddServer() {
  editingServerId.value = null
  serverDraft.id = ''
  serverDraft.command = ''
  serverDraft.args = ''
  serverEditorOpen.value = true
  error.value = ''
}

function openEditServer(server: McpServerSummary) {
  editingServerId.value = server.id
  serverDraft.id = server.id
  serverDraft.command = server.command
  serverDraft.args = server.args.join('\n')
  serverEditorOpen.value = true
  error.value = ''
}

function closeServerEditor() {
  if (serverSaving.value) return
  serverEditorOpen.value = false
}

function serverArgs() {
  return serverDraft.args.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)
}

async function saveServer() {
  if (serverSaving.value || !serverDraft.command.trim() || (!editingServerId.value && !serverDraft.id.trim())) return
  serverSaving.value = true
  error.value = ''
  message.value = ''
  try {
    const isEditing = Boolean(editingServerId.value)
    const response = await apiFetch(`${props.apiBase}/api/settings/mcp/servers${isEditing ? `/${encodeURIComponent(editingServerId.value!)}` : ''}`, {
      method: isEditing ? 'PATCH' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(isEditing
        ? { command: serverDraft.command.trim(), args: serverArgs() }
        : { id: serverDraft.id.trim(), command: serverDraft.command.trim(), args: serverArgs() }),
    })
    const data = await response.json() as unknown
    if (!response.ok) throw new Error(readApiError(data, response.status))
    applySavedResult(data)
    serverEditorOpen.value = false
    message.value = uiText.mcp.savedRestart
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : uiText.mcp.saveFailed
  } finally {
    serverSaving.value = false
  }
}

async function toggleServer(server: McpServerSummary) {
  if (serverSaving.value || !server.trusted) return
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
    message.value = uiText.mcp.savedRestart
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
</script>

<template>
  <div class="settings-section mcp-settings">
    <section class="settings-group mcp-servers-group">
      <header class="settings-group-heading">
        <div>
          <h3>{{ uiText.mcp.servers }}</h3>
          <span>{{ servers.length ? uiText.mcp.serverCount(servers.length) : uiText.mcp.serversDescription }}</span>
        </div>
        <div class="mcp-heading-actions">
          <button type="button" class="settings-icon-button" :title="uiText.mcp.reload" :aria-label="uiText.mcp.reload" :disabled="loading" @click="loadMcpSettings"><RotateCw :size="14" :class="{ spinning: loading }" /></button>
          <button type="button" class="settings-secondary" :disabled="loading" @click="openAddServer"><Plus :size="14" />{{ uiText.mcp.add }}</button>
        </div>
      </header>

      <div v-if="servers.length === 0" class="settings-empty-state">
        <Server :size="18" stroke-width="1.7" />
        <span>{{ uiText.mcp.noServers }}</span>
        <button type="button" class="settings-secondary" @click="openAddServer">{{ uiText.mcp.add }}</button>
      </div>
      <div v-else class="mcp-server-list">
        <div v-for="server in servers" :key="server.id" class="settings-list-row mcp-server-row">
          <div class="settings-list-main">
            <span class="settings-row-icon" aria-hidden="true"><Server :size="16" /></span>
            <div class="settings-list-copy">
              <strong>{{ server.id }}</strong>
              <span>{{ uiText.mcp.localTool }}</span>
            </div>
          </div>
          <span class="mcp-server-status" :class="{ ready: server.enabled && server.trusted, warning: !server.trusted }">{{ serverStatus(server) }}</span>
          <div class="mcp-server-actions">
            <button v-if="!server.trusted" type="button" class="settings-secondary" :disabled="hasUnsavedConfig || trustUpdatingServerId === server.id" @click="setServerTrust(server)"><ShieldCheck :size="14" />{{ uiText.mcp.allow }}</button>
            <label v-else class="mcp-server-toggle" :title="server.enabled ? uiText.mcp.pause : uiText.mcp.enable">
              <input class="settings-switch" type="checkbox" role="switch" :checked="server.enabled" :disabled="serverSaving" :aria-label="uiText.mcp.toggleLabel(server.id)" @change="toggleServer(server)" />
            </label>
            <button type="button" class="settings-icon-button" :title="uiText.mcp.edit" :aria-label="uiText.mcp.editLabel(server.id)" :disabled="serverSaving" @click="openEditServer(server)"><Pencil :size="14" /></button>
            <button type="button" class="settings-icon-button mcp-remove-button" :title="uiText.mcp.remove" :aria-label="uiText.mcp.removeLabel(server.id)" :disabled="serverSaving" @click="requestDeleteServer(server)"><Trash2 :size="14" /></button>
          </div>
        </div>
      </div>
      <div class="mcp-feedback-slot" :class="{ error: Boolean(error) }" role="status" aria-live="polite">
        {{ error || message || (restartRequired ? uiText.mcp.restartRequired : '') }}
      </div>
    </section>

    <details class="settings-group mcp-advanced-config">
      <summary>
        <span>{{ uiText.mcp.configuration }}</span>
        <small>{{ statusText }}</small>
      </summary>
      <div class="mcp-advanced-config-body">
        <div class="mcp-config-path">
          <span>{{ uiText.mcp.configFile }}</span>
          <code :title="configPath">{{ configPath }}</code>
        </div>
        <label class="mcp-editor-field">
          <span>{{ uiText.mcp.configurationJson }}</span>
          <textarea v-model="rawConfig" class="mcp-config-editor" spellcheck="false" :disabled="loading || saving"></textarea>
        </label>
        <div class="settings-actions">
          <button type="button" class="settings-primary" :disabled="saving || loading || !hasUnsavedConfig" @click="saveMcpSettings">
            <Save :size="14" />
            {{ saving ? uiText.mcp.saving : uiText.mcp.save }}
          </button>
        </div>
      </div>
    </details>
  </div>

  <Teleport to="body">
    <div v-if="serverEditorOpen" class="mcp-editor-backdrop" @click.self="closeServerEditor" @keydown.esc="closeServerEditor">
      <form class="mcp-server-editor" role="dialog" aria-modal="true" aria-labelledby="mcp-server-editor-title" @submit.prevent="saveServer">
        <header class="mcp-server-editor-heading">
          <div><h3 id="mcp-server-editor-title">{{ editingServerId ? uiText.mcp.editServer : uiText.mcp.addServer }}</h3><span>{{ uiText.mcp.editorDescription }}</span></div>
          <button type="button" class="settings-icon-button" :title="uiText.mcp.close" :aria-label="uiText.mcp.close" :disabled="serverSaving" @click="closeServerEditor"><X :size="14" /></button>
        </header>
        <div class="mcp-server-editor-fields">
          <label><span>{{ uiText.mcp.name }}</span><input v-model="serverDraft.id" :disabled="Boolean(editingServerId)" required pattern="[A-Za-z0-9_-]+" maxlength="200" autocomplete="off" /><small>{{ uiText.mcp.nameHint }}</small></label>
          <label><span>{{ uiText.mcp.command }}</span><input v-model="serverDraft.command" required maxlength="2000" spellcheck="false" autocomplete="off" :placeholder="uiText.mcp.commandPlaceholder" /></label>
          <label><span>{{ uiText.mcp.arguments }}</span><textarea v-model="serverDraft.args" spellcheck="false" :placeholder="uiText.mcp.argumentsPlaceholder"></textarea><small>{{ uiText.mcp.argumentsHint }}</small></label>
        </div>
        <footer class="mcp-server-editor-actions">
          <button type="button" class="settings-secondary" :disabled="serverSaving" @click="closeServerEditor">{{ uiText.mcp.cancel }}</button>
          <button type="submit" class="settings-primary" :disabled="serverSaving || !serverDraft.command.trim() || (!editingServerId && !serverDraft.id.trim())">{{ serverSaving ? uiText.mcp.saving : uiText.mcp.saveServer }}</button>
        </footer>
      </form>
    </div>
  </Teleport>

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
