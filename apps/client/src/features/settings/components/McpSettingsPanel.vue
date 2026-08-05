<script setup lang="ts">
import { RotateCw, Save, ShieldCheck, ShieldOff } from 'lucide-vue-next'
import { computed, onMounted, ref } from 'vue'
import { uiText } from '../../../text/uiText'
import { apiFetch } from '../../../services/apiAccess'

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
const validating = ref(false)
const trustUpdatingServerId = ref('')
const message = ref('')
const error = ref('')
const restartRequired = ref(false)
const hasUnsavedConfig = computed(() => rawConfig.value !== savedRawConfig.value)

const statusText = computed(() => {
  if (error.value) return error.value
  if (message.value) return message.value
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

function serverCommand(server: McpServerSummary) {
  return [server.command, ...server.args.map((argument) => JSON.stringify(argument))].join(' ')
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

async function validateMcpSettings() {
  validating.value = true
  error.value = ''
  message.value = ''
  try {
    const response = await apiFetch(`${props.apiBase}/api/settings/mcp/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw: rawConfig.value }),
    })
    const data = await response.json() as unknown
    if (!response.ok) throw new Error(readApiError(data, response.status))
    const result = applyResult(data)
    message.value = result.valid ? uiText.mcp.validConfig : ''
  } catch (err) {
    error.value = err instanceof Error ? err.message : uiText.mcp.validateFailed
  } finally {
    validating.value = false
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
    applyResult(data)
    message.value = server.trusted ? uiText.mcp.trustRevoked : uiText.mcp.trustGranted
  } catch (err) {
    error.value = err instanceof Error ? err.message : uiText.mcp.trustFailed
  } finally {
    trustUpdatingServerId.value = ''
  }
}

onMounted(() => {
  void loadMcpSettings()
})
</script>

<template>
  <div class="settings-section">
    <div class="settings-section-heading">
      <span>{{ statusText }}</span>
    </div>

    <div class="mcp-settings">
      <div class="mcp-config-meta">
        <span>{{ configPath }}</span>
        <button type="button" class="settings-icon-button" :title="uiText.mcp.reload" :aria-label="uiText.mcp.reload" :disabled="loading" @click="loadMcpSettings">
          <RotateCw :size="14" />
        </button>
      </div>

      <textarea
        v-model="rawConfig"
        class="mcp-config-editor"
        spellcheck="false"
        :disabled="loading || saving"
      ></textarea>

      <div v-if="error" class="settings-note error">{{ error }}</div>
      <div v-else-if="restartRequired" class="settings-note">{{ uiText.mcp.restartRequired }}</div>
      <div v-else-if="servers.length === 0" class="settings-note">{{ uiText.mcp.noServers }}</div>

      <details class="mcp-config-tip">
        <summary>{{ uiText.mcp.simpleExample }}</summary>
        <pre>{
  "mcpServers": {
    "moke_local": {
      "command": "node",
      "args": ["packages/mcp-client/examples/local-mcp-server.mjs"]
    }
  }
}</pre>
      </details>

      <div v-if="servers.length > 0" class="mcp-server-list">
        <div v-for="server in servers" :key="server.id" class="mcp-server-row">
          <strong>{{ server.id }}</strong>
          <span>
            {{ server.enabled ? uiText.mcp.enabled : uiText.mcp.disabled }} /
            {{ server.trusted ? uiText.mcp.trusted : uiText.mcp.untrusted }}
          </span>
          <code>{{ serverCommand(server) }}</code>
          <button
            type="button"
            class="mcp-trust-button"
            :title="hasUnsavedConfig
              ? uiText.mcp.saveBeforeTrust
              : server.trusted ? uiText.mcp.revokeTrust : `${uiText.mcp.trust}: ${serverCommand(server)}`"
            :disabled="hasUnsavedConfig || trustUpdatingServerId === server.id"
            @click="setServerTrust(server)"
          >
            <ShieldOff v-if="server.trusted" :size="13" />
            <ShieldCheck v-else :size="13" />
            {{ server.trusted ? uiText.mcp.revokeTrust : uiText.mcp.trust }}
          </button>
        </div>
      </div>

      <div class="settings-actions">
        <button type="button" class="settings-secondary" :disabled="validating || loading" @click="validateMcpSettings">
          <RotateCw :size="14" />
          {{ validating ? uiText.mcp.validating : uiText.mcp.validate }}
        </button>
        <button type="button" class="settings-primary" :disabled="saving || loading" @click="saveMcpSettings">
          <Save :size="14" />
          {{ saving ? uiText.mcp.saving : uiText.mcp.save }}
        </button>
      </div>
    </div>
  </div>
</template>
