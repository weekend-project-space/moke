<script setup lang="ts">
import { CircleAlert, Link2, LoaderCircle, Plus, RefreshCw, Square, Trash2, X } from 'lucide-vue-next'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

type ConnectionState = 'stopped' | 'starting' | 'connected' | 'reconnecting' | 'reauth_required' | 'error'

type WeixinConnection = {
  id: string
  name: string
  enabled: boolean
  ilink_bot_id: string
  state: ConnectionState
  last_connected_at?: string
  last_error?: { code: string; message: string; at: string }
}

type WeixinLogin = {
  id: string
  status: 'waiting_scan' | 'scanned' | 'verify_required' | 'expired' | 'confirmed' | 'already_connected' | 'failed' | 'cancelled'
  qr_image?: string
  expires_at: string
  error?: { code: string; message: string }
}

const props = defineProps<{
  apiBase: string
}>()

const connections = ref<WeixinConnection[]>([])
const login = ref<WeixinLogin | null>(null)
const verifyCode = ref('')
const loading = ref(false)
const creatingLogin = ref(false)
const busyConnectionId = ref('')
const error = ref('')
let pollTimer: number | undefined

const loginStatusText = computed(() => login.value ? loginStatusLabel(login.value.status) : '')
const hasActiveLogin = computed(() => login.value && !isTerminalLogin(login.value.status))

function requestJson<T>(path: string, init?: RequestInit) {
  return fetch(`${props.apiBase}${path}`, init).then(async (response) => {
    const body = await response.json().catch(() => ({})) as { error?: { message?: string } }
    if (!response.ok) throw new Error(body.error?.message || `HTTP ${response.status}`)
    return body as T
  })
}

async function loadConnections() {
  loading.value = true
  error.value = ''
  try {
    const data = await requestJson<{ connections?: WeixinConnection[] }>('/api/messaging/connections')
    connections.value = Array.isArray(data.connections) ? data.connections : []
  } catch (reason) {
    error.value = messageFrom(reason, 'Unable to load messaging connections')
  } finally {
    loading.value = false
  }
}

async function beginLogin(connectionId?: string) {
  creatingLogin.value = true
  error.value = ''
  try {
    const data = await requestJson<{ login?: WeixinLogin }>('/api/messaging/weixin/logins', json('POST', {
      ...(connectionId ? { connectionId } : {}),
    }))
    if (!data.login) throw new Error('Invalid login response')
    login.value = data.login
    verifyCode.value = ''
    startPolling()
  } catch (reason) {
    error.value = messageFrom(reason, 'Unable to start WeChat authorization')
  } finally {
    creatingLogin.value = false
  }
}

async function pollLogin() {
  const current = login.value
  if (!current || isTerminalLogin(current.status)) {
    stopPolling()
    return
  }
  try {
    const data = await requestJson<{ login?: WeixinLogin }>(`/api/messaging/weixin/logins/${encodeURIComponent(current.id)}`)
    if (!data.login) throw new Error('Invalid login response')
    login.value = data.login
    if (isTerminalLogin(data.login.status)) {
      stopPolling()
      if (data.login.status === 'confirmed') await loadConnections()
    }
  } catch (reason) {
    stopPolling()
    error.value = messageFrom(reason, 'Unable to check WeChat authorization')
  }
}

async function submitVerifyCode() {
  const current = login.value
  const code = verifyCode.value.trim()
  if (!current || !/^\d{1,12}$/.test(code)) return
  try {
    const data = await requestJson<{ login?: WeixinLogin }>(
      `/api/messaging/weixin/logins/${encodeURIComponent(current.id)}/verify`,
      json('POST', { code }),
    )
    if (!data.login) throw new Error('Invalid login response')
    login.value = data.login
    verifyCode.value = ''
    if (isTerminalLogin(data.login.status)) {
      stopPolling()
      if (data.login.status === 'confirmed') await loadConnections()
    }
  } catch (reason) {
    error.value = messageFrom(reason, 'Unable to verify the code')
  }
}

async function cancelLogin() {
  const current = login.value
  if (!current) return
  try {
    await requestJson(`/api/messaging/weixin/logins/${encodeURIComponent(current.id)}/cancel`, json('POST', {}))
  } catch {
    // The local flow can be safely dismissed even when the server has already expired it.
  }
  stopPolling()
  login.value = null
}

async function connectionAction(connection: WeixinConnection, action: 'start' | 'stop' | 'reauthorize' | 'delete') {
  busyConnectionId.value = connection.id
  error.value = ''
  try {
    if (action === 'reauthorize') {
      const data = await requestJson<{ login?: WeixinLogin }>(
        `/api/messaging/connections/${encodeURIComponent(connection.id)}/reauthorize`,
        json('POST', {}),
      )
      if (!data.login) throw new Error('Invalid login response')
      login.value = data.login
      verifyCode.value = ''
      startPolling()
    } else {
      await requestJson(`/api/messaging/connections/${encodeURIComponent(connection.id)}/${action}`, json('POST', {}))
      await loadConnections()
    }
  } catch (reason) {
    error.value = messageFrom(reason, 'Unable to update WeChat connection')
  } finally {
    busyConnectionId.value = ''
  }
}

function startPolling() {
  stopPolling()
  pollTimer = window.setInterval(() => { void pollLogin() }, 1500)
  void pollLogin()
}

function stopPolling() {
  if (pollTimer !== undefined) window.clearInterval(pollTimer)
  pollTimer = undefined
}

function json(method: 'POST', body: unknown): RequestInit {
  return {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }
}

function connectionStateLabel(state: ConnectionState) {
  return {
    stopped: 'Stopped',
    starting: 'Connecting',
    connected: 'Connected',
    reconnecting: 'Reconnecting',
    reauth_required: 'Reauthorize',
    error: 'Error',
  }[state]
}

function loginStatusLabel(status: WeixinLogin['status']) {
  return {
    waiting_scan: 'Scan with WeChat',
    scanned: 'Confirm on your phone',
    verify_required: 'Enter verification code',
    expired: 'QR code expired',
    confirmed: 'Connected',
    already_connected: 'Already connected',
    failed: 'Authorization failed',
    cancelled: 'Authorization cancelled',
  }[status]
}

function isTerminalLogin(status: WeixinLogin['status']) {
  return status === 'expired' || status === 'confirmed' || status === 'already_connected' || status === 'failed' || status === 'cancelled'
}

function connectionTime(value?: string) {
  if (!value) return 'No successful connection yet'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? 'No successful connection yet' : date.toLocaleString()
}

function messageFrom(reason: unknown, fallback: string) {
  return reason instanceof Error && reason.message ? reason.message : fallback
}

onMounted(() => { void loadConnections() })
onBeforeUnmount(stopPolling)
</script>

<template>
  <section class="settings-section messaging-settings">
    <div class="messaging-heading">
      <div>
        <h3>WeChat</h3>
        <span>{{ connections.length }} connection{{ connections.length === 1 ? '' : 's' }}</span>
      </div>
      <div class="messaging-heading-actions">
        <button type="button" class="settings-icon-button" title="Refresh connections" aria-label="Refresh connections" :disabled="loading" @click="loadConnections">
          <RefreshCw :size="14" :class="{ spinning: loading }" />
        </button>
        <button type="button" class="settings-icon-button messaging-add-button" title="Add WeChat" aria-label="Add WeChat" :disabled="creatingLogin || Boolean(hasActiveLogin)" @click="beginLogin()">
          <Plus :size="15" />
        </button>
      </div>
    </div>

    <p v-if="error" class="messaging-feedback error" role="alert">{{ error }}</p>

    <div v-if="loading && connections.length === 0" class="settings-note">Loading connections...</div>
    <div v-else-if="connections.length === 0" class="messaging-empty">
      <Link2 :size="18" stroke-width="1.7" />
      <span>No WeChat account connected</span>
    </div>
    <div v-else class="messaging-connection-list">
      <article v-for="connection in connections" :key="connection.id" class="messaging-connection-row">
        <div class="messaging-connection-main">
          <div class="messaging-connection-icon" aria-hidden="true"><Link2 :size="15" /></div>
          <div class="messaging-connection-copy">
            <strong>{{ connection.name }}</strong>
            <span>{{ connectionTime(connection.last_connected_at) }}</span>
            <small v-if="connection.last_error">{{ connection.last_error.message }}</small>
          </div>
        </div>
        <span class="messaging-state" :class="`is-${connection.state}`">{{ connectionStateLabel(connection.state) }}</span>
        <div class="messaging-connection-actions">
          <button
            v-if="connection.state === 'connected' || connection.state === 'starting' || connection.state === 'reconnecting'"
            type="button"
            class="settings-icon-button"
            title="Stop connection"
            aria-label="Stop connection"
            :disabled="busyConnectionId === connection.id"
            @click="connectionAction(connection, 'stop')"
          >
            <Square :size="13" fill="currentColor" />
          </button>
          <button
            v-else
            type="button"
            class="settings-icon-button"
            title="Start connection"
            aria-label="Start connection"
            :disabled="busyConnectionId === connection.id"
            @click="connectionAction(connection, 'start')"
          >
            <RefreshCw :size="14" :class="{ spinning: busyConnectionId === connection.id }" />
          </button>
          <button type="button" class="settings-icon-button" title="Reauthorize WeChat" aria-label="Reauthorize WeChat" :disabled="busyConnectionId === connection.id || Boolean(hasActiveLogin)" @click="connectionAction(connection, 'reauthorize')">
            <Link2 :size="14" />
          </button>
          <button type="button" class="settings-icon-button messaging-delete-button" title="Delete connection" aria-label="Delete connection" :disabled="busyConnectionId === connection.id" @click="connectionAction(connection, 'delete')">
            <Trash2 :size="14" />
          </button>
        </div>
      </article>
    </div>

    <section v-if="login" class="weixin-login-flow" :class="{ terminal: !hasActiveLogin }">
      <div class="weixin-login-header">
        <div>
          <h4>{{ loginStatusText }}</h4>
          <span>{{ new Date(login.expires_at).toLocaleTimeString() }}</span>
        </div>
        <button type="button" class="settings-icon-button" title="Close authorization" aria-label="Close authorization" @click="cancelLogin">
          <X :size="14" />
        </button>
      </div>
      <div v-if="login.qr_image && hasActiveLogin" class="weixin-qr-frame">
        <img :src="login.qr_image" alt="WeChat authorization QR code" />
      </div>
      <div v-else class="weixin-login-state" :class="{ error: login.status === 'failed' || login.status === 'expired' }">
        <CircleAlert v-if="login.status === 'failed' || login.status === 'expired'" :size="17" />
        <LoaderCircle v-else :size="17" class="spinning" />
        <span>{{ login.error?.message || loginStatusText }}</span>
      </div>
      <form v-if="login.status === 'verify_required'" class="weixin-verify-form" @submit.prevent="submitVerifyCode">
        <input v-model="verifyCode" inputmode="numeric" pattern="[0-9]*" maxlength="12" autocomplete="one-time-code" aria-label="Verification code" placeholder="Verification code" />
        <button type="submit" class="settings-primary" :disabled="!/^\d{1,12}$/.test(verifyCode)">Confirm</button>
      </form>
    </section>
  </section>
</template>
