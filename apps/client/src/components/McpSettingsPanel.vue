<script setup lang="ts">
import { RotateCw, Save } from 'lucide-vue-next'
import { computed, onMounted, ref } from 'vue'
import { uiText } from '../text/uiText'

type McpServerSummary = {
  id: string
  enabled: boolean
  command: string
  args: string[]
  timeout_ms: number
}

const props = defineProps<{
  apiBase: string
}>()

const configPath = ref('')
const rawConfig = ref('')
const servers = ref<McpServerSummary[]>([])
const valid = ref(false)
const exists = ref(false)
const loading = ref(false)
const saving = ref(false)
const validating = ref(false)
const message = ref('')
const error = ref('')
const restartRequired = ref(false)

const statusText = computed(() => {
  if (error.value) return error.value
  if (message.value) return message.value
  if (!exists.value) return uiText.mcp.noConfig
  return valid.value ? uiText.mcp.serverCount(servers.value.length) : uiText.mcp.invalidConfig
})

function applyResult(data: any) {
  configPath.value = typeof data.path === 'string' ? data.path : configPath.value
  rawConfig.value = typeof data.raw === 'string' ? data.raw : rawConfig.value
  exists.value = Boolean(data.exists)
  valid.value = Boolean(data.valid)
  servers.value = Array.isArray(data.servers) ? data.servers : []
  restartRequired.value = Boolean(data.restart_required)
  error.value = typeof data.error === 'string' ? data.error : ''
}

async function loadMcpSettings() {
  loading.value = true
  error.value = ''
  message.value = ''
  try {
    const response = await fetch(`${props.apiBase}/api/settings/mcp`)
    const data = await response.json()
    if (!response.ok) throw new Error(data.error?.message || `HTTP ${response.status}`)
    applyResult(data)
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
    const response = await fetch(`${props.apiBase}/api/settings/mcp/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw: rawConfig.value }),
    })
    const data = await response.json()
    if (!response.ok) throw new Error(data.error?.message || `HTTP ${response.status}`)
    applyResult(data)
    message.value = data.valid ? uiText.mcp.validConfig : ''
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
    const response = await fetch(`${props.apiBase}/api/settings/mcp`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw: rawConfig.value }),
    })
    const data = await response.json()
    if (!response.ok) throw new Error(data.error?.message || `HTTP ${response.status}`)
    applyResult(data)
    if (!data.valid) return
    message.value = uiText.mcp.savedRestart
  } catch (err) {
    error.value = err instanceof Error ? err.message : uiText.mcp.saveFailed
  } finally {
    saving.value = false
  }
}

onMounted(() => {
  void loadMcpSettings()
})
</script>

<template>
  <div class="settings-section">
    <div class="settings-section-heading">
      <h3>MCP</h3>
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
          <span>{{ server.enabled ? uiText.mcp.enabled : uiText.mcp.disabled }}</span>
          <code>{{ server.command }} {{ server.args.join(' ') }}</code>
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
