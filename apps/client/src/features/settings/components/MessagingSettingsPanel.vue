<script setup lang="ts">
import { apiFetch } from '../../../services/apiAccess'
import {
  CircleAlert,
  Link2,
  LoaderCircle,
  Plus,
  RefreshCw,
  Settings2,
  Square,
  Trash2,
  X,
} from 'lucide-vue-next'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import dingTalkIcon from '../../../assets/dingtalk.svg'
import feishuIcon from '../../../assets/feishu.svg'
import weChatIcon from '../../../assets/wechat.svg'
import { uiText } from '../../../text/uiText'

type ConnectionState = 'stopped' | 'starting' | 'connected' | 'reconnecting' | 'reauth_required' | 'error'

type MessagingConnection = {
  id: string
  platform: 'weixin' | 'dingtalk' | 'feishu'
  name: string
  enabled: boolean
  state: ConnectionState
  last_connected_at?: string
  bot_name?: string
  bot_avatar_url?: string
  last_inbound_at?: string
  last_outbound_at?: string
  last_error?: { code: string; message: string; at: string }
  allowed_user_ids?: string[]
  card_template_id?: string
}

type WeixinLogin = {
  id: string
  status: 'waiting_scan' | 'scanned' | 'verify_required' | 'expired' | 'confirmed' | 'already_connected' | 'failed' | 'cancelled'
  qr_image?: string
  expires_at: string
  error?: { code: string; message: string }
}

type FeishuLogin = {
  id: string
  status: 'waiting_scan' | 'expired' | 'denied' | 'confirmed' | 'failed' | 'cancelled'
  qr_image?: string
  expires_at: string
  next_poll_after_ms: number
  error?: { code: string; message: string }
}

const channelIcons: Record<MessagingConnection['platform'], string> = {
  weixin: weChatIcon,
  dingtalk: dingTalkIcon,
  feishu: feishuIcon,
}

const props = defineProps<{ apiBase: string }>()

const connections = ref<MessagingConnection[]>([])
const setupChannel = ref<'weixin' | 'dingtalk' | 'feishu' | null>(null)
const loginConnectionId = ref<string>()
const dingtalkClientId = ref('')
const dingtalkClientSecret = ref('')
const dingtalkAllowedUsers = ref('')
const dingtalkCardTemplateId = ref('')
const editingDingTalkId = ref('')
const savingDingTalk = ref(false)
const feishuAppId = ref('')
const feishuAppSecret = ref('')
const feishuDomain = ref<'feishu' | 'lark'>('feishu')
const feishuSetupMode = ref<'quick' | 'manual'>('quick')
const savingFeishu = ref(false)
const feishuLogin = ref<FeishuLogin | null>(null)
const creatingFeishuLogin = ref(false)
const login = ref<WeixinLogin | null>(null)
const verifyCode = ref('')
const loading = ref(false)
const creatingLogin = ref(false)
const busyConnectionId = ref('')
const error = ref('')
let pollTimer: number | undefined
let feishuPollTimer: number | undefined
let loginRequest = 0
let feishuLoginRequest = 0

const loginStatusText = computed(() => login.value ? loginStatusLabel(login.value.status) : '')
const hasActiveLogin = computed(() => login.value && !isTerminalLogin(login.value.status))
const feishuLoginStatusText = computed(() => feishuLogin.value ? feishuLoginStatusLabel(feishuLogin.value.status) : '')
const hasActiveFeishuLogin = computed(() => feishuLogin.value && !isTerminalFeishuLogin(feishuLogin.value.status))

function requestJson<T>(path: string, init?: RequestInit) {
  return apiFetch(`${props.apiBase}${path}`, init).then(async (response) => {
    const body = await response.json().catch(() => ({})) as { error?: { message?: string } }
    if (!response.ok) throw new Error(body.error?.message || `HTTP ${response.status}`)
    return body as T
  })
}

async function loadConnections() {
  loading.value = true
  error.value = ''
  try {
    const data = await requestJson<{ connections?: MessagingConnection[] }>('/api/messaging/connections')
    connections.value = Array.isArray(data.connections) ? data.connections : []
  } catch (reason) {
    error.value = messageFrom(reason, uiText.messaging.loadFailed)
  } finally {
    loading.value = false
  }
}

async function saveDingTalkConnection() {
  savingDingTalk.value = true
  error.value = ''
  try {
    const options = {
      allowedUserIds: dingtalkAllowedUsers.value.split(',').map((value) => value.trim()).filter(Boolean),
      cardTemplateId: dingtalkCardTemplateId.value.trim(),
    }
    if (editingDingTalkId.value) {
      await requestJson(`/api/messaging/connections/${encodeURIComponent(editingDingTalkId.value)}`, json('PATCH', options))
    } else {
      await requestJson('/api/messaging/connections', json('POST', {
        platform: 'dingtalk',
        credentials: {
          clientId: dingtalkClientId.value.trim(),
          clientSecret: dingtalkClientSecret.value.trim(),
          ...options,
        },
      }))
    }
    dingtalkClientId.value = ''
    dingtalkClientSecret.value = ''
    dingtalkAllowedUsers.value = ''
    dingtalkCardTemplateId.value = ''
    editingDingTalkId.value = ''
    await loadConnections()
    setupChannel.value = null
  } catch (reason) {
    error.value = messageFrom(reason, uiText.messaging.addDingTalkFailed)
  } finally {
    savingDingTalk.value = false
  }
}

async function saveFeishuConnection() {
  savingFeishu.value = true
  error.value = ''
  try {
    await requestJson('/api/messaging/connections', json('POST', {
      platform: 'feishu',
      credentials: {
        appId: feishuAppId.value.trim(),
        appSecret: feishuAppSecret.value.trim(),
        domain: feishuDomain.value,
      },
    }))
    feishuAppId.value = ''
    feishuAppSecret.value = ''
    feishuDomain.value = 'feishu'
    await loadConnections()
    setupChannel.value = null
  } catch (reason) {
    error.value = messageFrom(reason, uiText.messaging.addFeishuFailed)
  } finally {
    savingFeishu.value = false
  }
}

async function beginFeishuLogin() {
  const request = ++feishuLoginRequest
  creatingFeishuLogin.value = true
  feishuLogin.value = null
  error.value = ''
  try {
    const data = await requestJson<{ login?: FeishuLogin }>('/api/messaging/feishu/logins', json('POST', {
      domain: feishuDomain.value,
    }))
    if (!data.login) throw new Error(uiText.messaging.invalidLoginResponse)
    if (request !== feishuLoginRequest || setupChannel.value !== 'feishu' || feishuSetupMode.value !== 'quick') {
      if (!isTerminalFeishuLogin(data.login.status)) {
        void requestJson(`/api/messaging/feishu/logins/${encodeURIComponent(data.login.id)}`, { method: 'DELETE' }).catch(() => undefined)
      }
      return
    }
    feishuLogin.value = data.login
    startFeishuPolling()
  } catch (reason) {
    if (request === feishuLoginRequest) error.value = messageFrom(reason, uiText.messaging.startFeishuAuthorizationFailed)
  } finally {
    if (request === feishuLoginRequest) creatingFeishuLogin.value = false
  }
}

async function pollFeishuLogin() {
  const current = feishuLogin.value
  if (!current || isTerminalFeishuLogin(current.status)) {
    stopFeishuPolling()
    return
  }
  try {
    const data = await requestJson<{ login?: FeishuLogin }>(`/api/messaging/feishu/logins/${encodeURIComponent(current.id)}`)
    if (!data.login) throw new Error(uiText.messaging.invalidLoginResponse)
    if (setupChannel.value !== 'feishu' || feishuSetupMode.value !== 'quick' || feishuLogin.value?.id !== current.id) return
    feishuLogin.value = { ...data.login, qr_image: data.login.qr_image || current.qr_image }
    if (isTerminalFeishuLogin(data.login.status)) {
      stopFeishuPolling()
      if (data.login.status === 'confirmed') {
        await loadConnections()
        setupChannel.value = null
        feishuLogin.value = null
      }
    }
  } catch (reason) {
    stopFeishuPolling()
    error.value = messageFrom(reason, uiText.messaging.checkFeishuAuthorizationFailed)
  }
}

async function beginLogin(connectionId?: string) {
  const request = ++loginRequest
  creatingLogin.value = true
  login.value = null
  verifyCode.value = ''
  error.value = ''
  try {
    const data = await requestJson<{ login?: WeixinLogin }>('/api/messaging/weixin/logins', json('POST', {
      ...(connectionId ? { connectionId } : {}),
    }))
    if (!data.login) throw new Error(uiText.messaging.invalidLoginResponse)
    if (request !== loginRequest || setupChannel.value !== 'weixin') {
      if (!isTerminalLogin(data.login.status)) {
        void requestJson(`/api/messaging/weixin/logins/${encodeURIComponent(data.login.id)}`, { method: 'DELETE' }).catch(() => undefined)
      }
      return
    }
    login.value = data.login
    startPolling()
  } catch (reason) {
    if (request === loginRequest) error.value = messageFrom(reason, uiText.messaging.startAuthorizationFailed)
  } finally {
    if (request === loginRequest) creatingLogin.value = false
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
    if (!data.login) throw new Error(uiText.messaging.invalidLoginResponse)
    if (setupChannel.value !== 'weixin' || login.value?.id !== current.id) return
    login.value = data.login
    if (isTerminalLogin(data.login.status)) {
      stopPolling()
      if (data.login.status === 'confirmed') {
        await loadConnections()
        setupChannel.value = null
        login.value = null
        loginConnectionId.value = undefined
      }
    }
  } catch (reason) {
    stopPolling()
    error.value = messageFrom(reason, uiText.messaging.checkAuthorizationFailed)
  }
}

async function submitVerifyCode() {
  const current = login.value
  const code = verifyCode.value.trim()
  if (!current || !/^\d{1,12}$/.test(code)) return
  try {
    const data = await requestJson<{ login?: WeixinLogin }>(
      `/api/messaging/weixin/logins/${encodeURIComponent(current.id)}`,
      json('PATCH', { code }),
    )
    if (!data.login) throw new Error(uiText.messaging.invalidLoginResponse)
    login.value = data.login
    verifyCode.value = ''
    if (isTerminalLogin(data.login.status)) {
      stopPolling()
      if (data.login.status === 'confirmed') {
        await loadConnections()
        setupChannel.value = null
        login.value = null
        loginConnectionId.value = undefined
      }
    }
  } catch (reason) {
    error.value = messageFrom(reason, uiText.messaging.verificationFailed)
  }
}

function openWeixinSetup(connectionId?: string) {
  setupChannel.value = 'weixin'
  loginConnectionId.value = connectionId
  login.value = null
  verifyCode.value = ''
  error.value = ''
  void beginLogin(connectionId)
}

function openDingTalkSetup() {
  setupChannel.value = 'dingtalk'
  error.value = ''
}

function editDingTalk(connection: MessagingConnection) {
  editingDingTalkId.value = connection.id
  dingtalkAllowedUsers.value = connection.allowed_user_ids?.join(', ') || ''
  dingtalkCardTemplateId.value = connection.card_template_id || ''
  setupChannel.value = 'dingtalk'
  error.value = ''
}

function openFeishuSetup() {
  setupChannel.value = 'feishu'
  feishuSetupMode.value = 'quick'
  error.value = ''
  void beginFeishuLogin()
}

async function setFeishuSetupMode(mode: 'quick' | 'manual') {
  if (mode === feishuSetupMode.value) return
  await cancelFeishuLogin()
  feishuSetupMode.value = mode
  error.value = ''
  if (mode === 'quick') void beginFeishuLogin()
}

async function setFeishuDomain(domain: 'feishu' | 'lark') {
  if (domain === feishuDomain.value) return
  await cancelFeishuLogin()
  feishuDomain.value = domain
  error.value = ''
  if (setupChannel.value === 'feishu' && feishuSetupMode.value === 'quick') void beginFeishuLogin()
}

async function closeSetup() {
  if (savingDingTalk.value || savingFeishu.value) return
  loginRequest += 1
  feishuLoginRequest += 1
  creatingLogin.value = false
  creatingFeishuLogin.value = false
  const current = login.value
  const shouldCancelLogin = setupChannel.value === 'weixin' && current && !isTerminalLogin(current.status)
  const currentFeishuLogin = feishuLogin.value
  const shouldCancelFeishuLogin = setupChannel.value === 'feishu' && currentFeishuLogin && !isTerminalFeishuLogin(currentFeishuLogin.status)
  stopPolling()
  stopFeishuPolling()
  login.value = null
  loginConnectionId.value = undefined
  verifyCode.value = ''
  dingtalkClientId.value = ''
  dingtalkClientSecret.value = ''
  dingtalkAllowedUsers.value = ''
  dingtalkCardTemplateId.value = ''
  editingDingTalkId.value = ''
  feishuAppId.value = ''
  feishuAppSecret.value = ''
  feishuDomain.value = 'feishu'
  feishuSetupMode.value = 'quick'
  feishuLogin.value = null
  error.value = ''
  setupChannel.value = null

  if (shouldCancelLogin) {
    try {
      await requestJson(`/api/messaging/weixin/logins/${encodeURIComponent(current.id)}`, { method: 'DELETE' })
    } catch {
      // The local dialog can close after the server has expired the authorization.
    }
  }
  if (shouldCancelFeishuLogin) {
    try {
      await requestJson(`/api/messaging/feishu/logins/${encodeURIComponent(currentFeishuLogin.id)}`, { method: 'DELETE' })
    } catch {
      // The local dialog can close after the server has expired the authorization.
    }
  }
}

async function connectionAction(connection: MessagingConnection, action: 'start' | 'stop' | 'reauthorize' | 'delete') {
  if (action === 'delete' && !window.confirm(uiText.messaging.confirmRemove(platformLabel(connection.platform)))) return
  busyConnectionId.value = connection.id
  error.value = ''
  try {
    if (action === 'reauthorize') {
      if (connection.platform !== 'weixin') return
      openWeixinSetup(connection.id)
    } else if (action === 'delete') {
      await requestJson(`/api/messaging/connections/${encodeURIComponent(connection.id)}`, { method: 'DELETE' })
      await loadConnections()
    } else {
      await requestJson(`/api/messaging/connections/${encodeURIComponent(connection.id)}`, json('PATCH', {
        enabled: action === 'start',
      }))
      await loadConnections()
    }
  } catch (reason) {
    error.value = messageFrom(reason, uiText.messaging.updateFailed)
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

function startFeishuPolling() {
  stopFeishuPolling()
  feishuPollTimer = window.setInterval(() => { void pollFeishuLogin() }, 1500)
  void pollFeishuLogin()
}

function stopFeishuPolling() {
  if (feishuPollTimer !== undefined) window.clearInterval(feishuPollTimer)
  feishuPollTimer = undefined
}

async function cancelFeishuLogin() {
  feishuLoginRequest += 1
  creatingFeishuLogin.value = false
  const current = feishuLogin.value
  stopFeishuPolling()
  feishuLogin.value = null
  if (!current || isTerminalFeishuLogin(current.status)) return
  try {
    await requestJson(`/api/messaging/feishu/logins/${encodeURIComponent(current.id)}`, { method: 'DELETE' })
  } catch {
    // The authorization may have expired while the mode or region changed.
  }
}

function json(method: 'POST' | 'PATCH', body: unknown): RequestInit {
  return {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }
}

function platformLabel(platform: MessagingConnection['platform']) {
  if (platform === 'weixin') return uiText.messaging.weChat
  return platform === 'dingtalk' ? uiText.messaging.dingTalk : uiText.messaging.feishu
}

function setupTitle(channel: NonNullable<typeof setupChannel.value>) {
  if (channel === 'weixin') return uiText.messaging.addWeChat
  return channel === 'dingtalk' ? (editingDingTalkId.value ? uiText.messaging.configureDingTalk : uiText.messaging.addDingTalk) : uiText.messaging.addFeishu
}

function setupDescription(channel: NonNullable<typeof setupChannel.value>) {
  if (channel === 'weixin') return uiText.messaging.connectWeChatDescription
  return channel === 'dingtalk' ? uiText.messaging.connectDingTalkDescription : uiText.messaging.connectFeishuDescription
}

function connectionStateLabel(state: ConnectionState) {
  return {
    stopped: uiText.messaging.stopped,
    starting: uiText.messaging.connecting,
    connected: uiText.messaging.connected,
    reconnecting: uiText.messaging.reconnecting,
    reauth_required: uiText.messaging.authorizationRequired,
    error: uiText.messaging.connectionError,
  }[state]
}

function loginStatusLabel(status: WeixinLogin['status']) {
  return {
    waiting_scan: uiText.messaging.scanWithWeChat,
    scanned: uiText.messaging.scannedConfirm,
    verify_required: uiText.messaging.verificationRequired,
    expired: uiText.messaging.qrExpired,
    confirmed: uiText.messaging.authorizationSucceeded,
    already_connected: uiText.messaging.alreadyConnected,
    failed: uiText.messaging.authorizationFailed,
    cancelled: uiText.messaging.authorizationCancelled,
  }[status]
}

function isTerminalLogin(status: WeixinLogin['status']) {
  return status === 'expired' || status === 'confirmed' || status === 'already_connected' || status === 'failed' || status === 'cancelled'
}

function feishuLoginStatusLabel(status: FeishuLogin['status']) {
  return {
    waiting_scan: feishuDomain.value === 'lark' ? uiText.messaging.scanWithLark : uiText.messaging.scanWithFeishu,
    expired: uiText.messaging.qrExpired,
    denied: uiText.messaging.authorizationDenied,
    confirmed: uiText.messaging.authorizationSucceeded,
    failed: uiText.messaging.authorizationFailed,
    cancelled: uiText.messaging.authorizationCancelled,
  }[status]
}

function isTerminalFeishuLogin(status: FeishuLogin['status']) {
  return status === 'expired' || status === 'denied' || status === 'confirmed' || status === 'failed' || status === 'cancelled'
}

function connectionTime(connection: MessagingConnection) {
  const value = connection.last_inbound_at || connection.last_outbound_at || connection.last_connected_at
  if (!value) return uiText.messaging.noActivity
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? uiText.messaging.noActivity : uiText.messaging.lastActive(date.toLocaleString())
}

function messageFrom(reason: unknown, fallback: string) {
  return reason instanceof Error && reason.message ? reason.message : fallback
}

onMounted(() => { void loadConnections() })
onBeforeUnmount(() => {
  stopPolling()
  stopFeishuPolling()
  void cancelFeishuLogin()
})
</script>

<template>
  <section class="settings-section messaging-settings">
    <div class="messaging-heading">
      <div>
        <h3>{{ uiText.messaging.yourChannels }}</h3>
        <span>{{ connections.length ? uiText.messaging.channelCount(connections.length) : uiText.messaging.noChannels }}</span>
      </div>
      <button type="button" class="settings-icon-button" :title="uiText.messaging.refreshChannels" :aria-label="uiText.messaging.refreshChannels" :disabled="loading" @click="loadConnections">
        <RefreshCw :size="14" :class="{ spinning: loading }" />
      </button>
    </div>

    <p v-if="error" class="messaging-feedback error" role="alert">{{ error }}</p>

    <div v-if="loading && connections.length === 0" class="settings-note">{{ uiText.messaging.loading }}</div>
    <div v-else-if="connections.length === 0" class="messaging-empty">
      <Link2 :size="18" stroke-width="1.7" />
      <span>{{ uiText.messaging.empty }}</span>
    </div>
    <div v-else class="messaging-connection-list">
      <article v-for="connection in connections" :key="connection.id" class="messaging-connection-row">
        <div class="messaging-connection-main">
          <div class="messaging-connection-icon" aria-hidden="true">
            <img class="messaging-brand-icon" :src="channelIcons[connection.platform]" alt="" />
          </div>
          <div class="messaging-connection-copy">
            <strong>{{ connection.bot_name || platformLabel(connection.platform) }}<template v-if="!connection.bot_name && connection.name !== platformLabel(connection.platform)"> · {{ connection.name }}</template></strong>
            <span>{{ connectionTime(connection) }}</span>
            <small v-if="connection.last_error">{{ connection.last_error.message }}</small>
          </div>
        </div>
        <span class="messaging-state" :class="`is-${connection.state}`">{{ connectionStateLabel(connection.state) }}</span>
        <div class="messaging-connection-actions">
          <button
            v-if="connection.platform === 'dingtalk'"
            type="button"
            class="settings-icon-button"
            :title="uiText.messaging.configureChannel"
            :aria-label="uiText.messaging.configureChannel"
            :disabled="busyConnectionId === connection.id"
            @click="editDingTalk(connection)"
          >
            <Settings2 :size="14" />
          </button>
          <button
            v-if="connection.state === 'connected' || connection.state === 'starting' || connection.state === 'reconnecting'"
            type="button"
            class="settings-icon-button"
            :title="uiText.messaging.stopChannel"
            :aria-label="uiText.messaging.stopChannel"
            :disabled="busyConnectionId === connection.id"
            @click="connectionAction(connection, 'stop')"
          >
            <Square :size="13" fill="currentColor" />
          </button>
          <button
            v-else
            type="button"
            class="settings-icon-button"
            :title="uiText.messaging.startChannel"
            :aria-label="uiText.messaging.startChannel"
            :disabled="busyConnectionId === connection.id"
            @click="connectionAction(connection, 'start')"
          >
            <RefreshCw :size="14" :class="{ spinning: busyConnectionId === connection.id }" />
          </button>
          <button
            v-if="connection.platform === 'weixin'"
            type="button"
            class="settings-icon-button"
            :title="uiText.messaging.reauthorizeWeChat"
            :aria-label="uiText.messaging.reauthorizeWeChat"
            :disabled="busyConnectionId === connection.id || Boolean(hasActiveLogin)"
            @click="connectionAction(connection, 'reauthorize')"
          >
            <Link2 :size="14" />
          </button>
          <button type="button" class="settings-icon-button messaging-delete-button" :title="uiText.messaging.removeChannel" :aria-label="uiText.messaging.removeChannel" :disabled="busyConnectionId === connection.id" @click="connectionAction(connection, 'delete')">
            <Trash2 :size="14" />
          </button>
        </div>
      </article>
    </div>

  </section>

  <section class="settings-section messaging-settings">
    <div class="messaging-heading">
      <div>
        <h3>{{ uiText.messaging.availableChannels }}</h3>
        <span>{{ uiText.messaging.availableChannelsDescription }}</span>
      </div>
    </div>
    <div class="messaging-channel-list">
      <article class="messaging-channel-row">
        <div class="messaging-connection-main">
          <div class="messaging-connection-icon" aria-hidden="true"><img class="messaging-brand-icon" :src="channelIcons.weixin" alt="" /></div>
          <div class="messaging-connection-copy"><strong>{{ uiText.messaging.weChat }}</strong><span>{{ uiText.messaging.personalWeChat }}</span></div>
        </div>
        <button type="button" class="settings-secondary messaging-channel-action" :disabled="creatingLogin || Boolean(hasActiveLogin)" @click="openWeixinSetup()"><Plus :size="14" />{{ uiText.messaging.add }}</button>
      </article>
      <article class="messaging-channel-row">
        <div class="messaging-connection-main">
          <div class="messaging-connection-icon" aria-hidden="true"><img class="messaging-brand-icon" :src="channelIcons.dingtalk" alt="" /></div>
          <div class="messaging-connection-copy"><strong>{{ uiText.messaging.dingTalk }}</strong><span>{{ uiText.messaging.dingTalkDescription }}</span></div>
        </div>
        <button type="button" class="settings-secondary messaging-channel-action" @click="openDingTalkSetup"><Plus :size="14" />{{ uiText.messaging.add }}</button>
      </article>
      <article class="messaging-channel-row">
        <div class="messaging-connection-main">
          <div class="messaging-connection-icon" aria-hidden="true"><img class="messaging-brand-icon" :src="channelIcons.feishu" alt="" /></div>
          <div class="messaging-connection-copy"><strong>{{ uiText.messaging.feishu }}</strong><span>{{ uiText.messaging.feishuDescription }}</span></div>
        </div>
        <button type="button" class="settings-secondary messaging-channel-action" @click="openFeishuSetup"><Plus :size="14" />{{ uiText.messaging.add }}</button>
      </article>
    </div>
  </section>

  <Teleport to="body">
    <div v-if="setupChannel" class="messaging-modal-backdrop" @click.self="closeSetup" @keydown.esc="closeSetup">
      <section
        class="messaging-modal"
        :class="`is-${setupChannel}`"
        role="dialog"
        aria-modal="true"
        aria-labelledby="messaging-setup-title"
      >
        <div class="messaging-modal-heading">
          <div class="messaging-modal-title">
            <div class="messaging-modal-icon" aria-hidden="true">
              <img class="messaging-brand-icon" :src="channelIcons[setupChannel]" alt="" />
            </div>
            <div>
              <h3 id="messaging-setup-title">{{ setupTitle(setupChannel) }}</h3>
              <span>{{ setupDescription(setupChannel) }}</span>
            </div>
          </div>
          <button type="button" class="settings-icon-button" :title="uiText.messaging.close" :aria-label="uiText.messaging.close" :disabled="savingDingTalk || savingFeishu" @click="closeSetup"><X :size="14" /></button>
        </div>

        <template v-if="setupChannel === 'weixin'">
          <div class="weixin-setup-body">
            <div v-if="login?.qr_image && hasActiveLogin" class="weixin-qr-frame">
              <img :src="login.qr_image" :alt="uiText.messaging.weChatQrCode" />
            </div>
            <div v-else class="weixin-setup-placeholder" :class="{ error: Boolean(error) || login?.status === 'failed' || login?.status === 'expired' }">
              <CircleAlert v-if="error || login?.status === 'failed' || login?.status === 'expired'" :size="20" />
              <LoaderCircle v-else :size="20" class="spinning" />
            </div>

            <div class="weixin-login-state" :class="{ error: Boolean(error) || login?.status === 'failed' || login?.status === 'expired' }">
              <span>{{ error || login?.error?.message || loginStatusText || uiText.messaging.preparingAuthorization }}</span>
              <time v-if="login && hasActiveLogin">{{ new Date(login.expires_at).toLocaleTimeString() }}</time>
            </div>

            <form v-if="login?.status === 'verify_required'" class="weixin-verify-form" @submit.prevent="submitVerifyCode">
              <input v-model="verifyCode" inputmode="numeric" pattern="[0-9]*" maxlength="12" autocomplete="one-time-code" :aria-label="uiText.messaging.verificationCode" :placeholder="uiText.messaging.verificationCode" />
              <button type="submit" class="settings-primary" :disabled="!/^\d{1,12}$/.test(verifyCode)">{{ uiText.messaging.confirm }}</button>
            </form>
          </div>
          <div class="messaging-modal-actions">
            <button v-if="error || login?.status === 'failed' || login?.status === 'expired'" type="button" class="settings-secondary" :disabled="creatingLogin" @click="beginLogin(loginConnectionId)">{{ uiText.messaging.tryAgain }}</button>
            <button type="button" class="settings-secondary" @click="closeSetup">{{ uiText.messaging.cancel }}</button>
          </div>
        </template>

        <form v-else-if="setupChannel === 'dingtalk'" class="messaging-credentials-form" @submit.prevent="saveDingTalkConnection">
          <div class="messaging-modal-fields">
            <label v-if="!editingDingTalkId">{{ uiText.messaging.clientId }}<input v-model="dingtalkClientId" required maxlength="200" autocomplete="off" /></label>
            <label v-if="!editingDingTalkId">{{ uiText.messaging.clientSecret }}<input v-model="dingtalkClientSecret" required type="password" maxlength="2000" autocomplete="new-password" /></label>
            <label>{{ uiText.messaging.allowedUsers }}<input v-model="dingtalkAllowedUsers" maxlength="4000" :placeholder="uiText.messaging.allowedUsersPlaceholder" autocomplete="off" /></label>
            <label>{{ uiText.messaging.cardTemplateId }}<input v-model="dingtalkCardTemplateId" maxlength="300" :placeholder="uiText.messaging.optional" autocomplete="off" /></label>
            <p v-if="error" class="messaging-modal-error" role="alert">{{ error }}</p>
          </div>
          <div class="messaging-modal-actions">
            <button type="button" class="settings-secondary" :disabled="savingDingTalk" @click="closeSetup">{{ uiText.messaging.cancel }}</button>
            <button type="submit" class="settings-primary" :disabled="savingDingTalk || (!editingDingTalkId && (!dingtalkClientId.trim() || !dingtalkClientSecret.trim()))">{{ editingDingTalkId ? uiText.messaging.saveChanges : uiText.messaging.saveAndConnect }}</button>
          </div>
        </form>

        <template v-else>
          <div class="messaging-setup-modes" role="tablist" :aria-label="uiText.messaging.setupMethod">
            <button type="button" role="tab" :aria-selected="feishuSetupMode === 'quick'" :class="{ active: feishuSetupMode === 'quick' }" @click="setFeishuSetupMode('quick')">{{ uiText.messaging.quickSetup }}</button>
            <button type="button" role="tab" :aria-selected="feishuSetupMode === 'manual'" :class="{ active: feishuSetupMode === 'manual' }" @click="setFeishuSetupMode('manual')">{{ uiText.messaging.manualSetup }}</button>
          </div>

          <template v-if="feishuSetupMode === 'quick'">
            <div class="feishu-setup-body">
              <div class="feishu-region-choice" role="radiogroup" :aria-label="uiText.messaging.region">
                <button type="button" role="radio" :aria-checked="feishuDomain === 'feishu'" :class="{ active: feishuDomain === 'feishu' }" :disabled="creatingFeishuLogin" @click="setFeishuDomain('feishu')">{{ uiText.messaging.feishuChina }}</button>
                <button type="button" role="radio" :aria-checked="feishuDomain === 'lark'" :class="{ active: feishuDomain === 'lark' }" :disabled="creatingFeishuLogin" @click="setFeishuDomain('lark')">{{ uiText.messaging.larkGlobal }}</button>
              </div>

              <div v-if="feishuLogin?.qr_image && hasActiveFeishuLogin" class="feishu-qr-frame">
                <img :src="feishuLogin.qr_image" :alt="uiText.messaging.feishuQrCode" />
              </div>
              <div v-else class="feishu-setup-placeholder" :class="{ error: Boolean(error) || feishuLogin?.status === 'failed' || feishuLogin?.status === 'expired' || feishuLogin?.status === 'denied' }">
                <CircleAlert v-if="error || feishuLogin?.status === 'failed' || feishuLogin?.status === 'expired' || feishuLogin?.status === 'denied'" :size="20" />
                <LoaderCircle v-else :size="20" class="spinning" />
              </div>

              <div class="feishu-login-state" :class="{ error: Boolean(error) || feishuLogin?.status === 'failed' || feishuLogin?.status === 'expired' || feishuLogin?.status === 'denied' }">
                <span>{{ error || feishuLogin?.error?.message || feishuLoginStatusText || uiText.messaging.preparingAuthorization }}</span>
                <time v-if="feishuLogin && hasActiveFeishuLogin">{{ new Date(feishuLogin.expires_at).toLocaleTimeString() }}</time>
              </div>
            </div>
            <div class="messaging-modal-actions">
              <button v-if="error || feishuLogin?.status === 'failed' || feishuLogin?.status === 'expired' || feishuLogin?.status === 'denied'" type="button" class="settings-secondary" :disabled="creatingFeishuLogin" @click="beginFeishuLogin">{{ uiText.messaging.tryAgain }}</button>
              <button type="button" class="settings-secondary" @click="closeSetup">{{ uiText.messaging.cancel }}</button>
            </div>
          </template>

          <form v-else class="messaging-credentials-form" @submit.prevent="saveFeishuConnection">
            <div class="messaging-modal-fields">
              <label>{{ uiText.messaging.appId }}<input v-model="feishuAppId" required maxlength="200" autocomplete="off" /></label>
              <label>{{ uiText.messaging.appSecret }}<input v-model="feishuAppSecret" required type="password" maxlength="2000" autocomplete="new-password" /></label>
              <label>
                {{ uiText.messaging.region }}
                <select v-model="feishuDomain">
                  <option value="feishu">{{ uiText.messaging.feishuChina }}</option>
                  <option value="lark">{{ uiText.messaging.larkGlobal }}</option>
                </select>
              </label>
              <p v-if="error" class="messaging-modal-error" role="alert">{{ error }}</p>
            </div>
            <div class="messaging-modal-actions">
              <button type="button" class="settings-secondary" :disabled="savingFeishu" @click="closeSetup">{{ uiText.messaging.cancel }}</button>
              <button type="submit" class="settings-primary" :disabled="savingFeishu || !feishuAppId.trim() || !feishuAppSecret.trim()">{{ uiText.messaging.saveAndConnect }}</button>
            </div>
          </form>
        </template>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.messaging-modal-backdrop {
  position: fixed;
  inset: 0;
  z-index: 50;
  display: grid;
  place-items: center;
  padding: 20px;
  background: rgb(31 35 40 / 18%);
  backdrop-filter: blur(2px);
}

.messaging-modal {
  display: grid;
  width: min(400px, 100%);
  overflow: hidden;
  border: 1px solid var(--line-soft);
  border-radius: var(--radius-md);
  color: var(--ink);
  background: var(--tone-surface);
  box-shadow: 0 16px 44px rgb(31 35 40 / 16%), 0 2px 8px rgb(31 35 40 / 8%);
}

.messaging-modal-heading {
  display: flex;
  min-width: 0;
  align-items: flex-start;
  justify-content: space-between;
  gap: 14px;
  padding: 16px 16px 14px;
  border-bottom: 1px solid var(--line-faint);
}

.messaging-modal-title {
  display: flex;
  min-width: 0;
  align-items: flex-start;
  gap: 10px;
}

.messaging-modal-title > div:last-child {
  display: grid;
  min-width: 0;
  gap: 3px;
}

.messaging-modal-icon {
  display: grid;
  width: 30px;
  height: 30px;
  flex: 0 0 auto;
  place-items: center;
  border: 1px solid var(--line-soft);
  border-radius: var(--radius-sm);
  color: var(--ink-soft);
  background: var(--surface-muted-faint);
}

.messaging-modal-icon .messaging-brand-icon {
  width: 18px;
  height: 18px;
}

.messaging-modal-heading h3 {
  margin: 0;
  font-size: var(--font-size-emphasis);
  font-weight: 620;
  letter-spacing: 0;
}

.messaging-modal-heading span {
  color: var(--ink-muted);
  font-size: var(--font-size-meta);
  line-height: 1.4;
}

.messaging-credentials-form {
  display: grid;
}

.messaging-setup-modes {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 2px;
  margin: 12px 16px 0;
  padding: 3px;
  border-radius: var(--radius-sm);
  background: var(--surface-muted-faint);
}

.messaging-setup-modes button,
.feishu-region-choice button {
  min-width: 0;
  border: 0;
  border-radius: calc(var(--radius-sm) - 2px);
  color: var(--ink-muted);
  font: inherit;
  font-size: var(--font-size-meta);
  background: transparent;
  cursor: pointer;
}

.messaging-setup-modes button {
  height: 30px;
}

.messaging-setup-modes button.active,
.feishu-region-choice button.active {
  color: var(--ink);
  background: var(--tone-surface);
  box-shadow: 0 0 0 1px var(--line-soft), 0 1px 2px rgb(31 35 40 / 8%);
}

.messaging-setup-modes button:focus-visible,
.feishu-region-choice button:focus-visible {
  outline: 2px solid var(--focus-control-border);
  outline-offset: 1px;
}

.messaging-modal-fields {
  display: grid;
  gap: 12px;
  padding: 16px;
}

.messaging-modal label {
  display: grid;
  gap: 6px;
  color: var(--ink-soft);
  font-size: var(--font-size-meta);
}

.messaging-modal input,
.messaging-modal select {
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  height: 36px;
  border: 1px solid var(--line-soft);
  border-radius: var(--radius-sm);
  padding: 0 10px;
  color: var(--ink);
  font: inherit;
  background: var(--surface-input);
  outline: none;
}

.messaging-modal input:focus,
.messaging-modal select:focus {
  border-color: var(--focus-control-border);
  box-shadow: 0 0 0 3px var(--focus-control-ring);
}

.messaging-modal-error {
  margin: 0;
  color: var(--text-error);
  font-size: var(--font-size-meta);
}

.messaging-modal-actions {
  display: flex;
  min-height: 54px;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  padding: 10px 16px;
  border-top: 1px solid var(--line-faint);
  background: var(--surface-muted-faint);
}

.weixin-setup-body {
  display: grid;
  min-height: 286px;
  place-items: center;
  align-content: center;
  gap: 10px;
  padding: 16px;
}

.feishu-setup-body {
  display: grid;
  min-height: 304px;
  place-items: center;
  align-content: center;
  gap: 10px;
  padding: 14px 16px 16px;
}

.feishu-region-choice {
  display: grid;
  width: 216px;
  grid-template-columns: 1fr 1fr;
  gap: 2px;
  padding: 3px;
  border: 1px solid var(--line-faint);
  border-radius: var(--radius-sm);
  background: var(--surface-muted-faint);
}

.feishu-region-choice button {
  height: 28px;
}

.feishu-region-choice button:disabled {
  cursor: default;
  opacity: 0.6;
}

.weixin-qr-frame,
.weixin-setup-placeholder,
.feishu-qr-frame,
.feishu-setup-placeholder {
  display: grid;
  width: 216px;
  height: 216px;
  place-items: center;
  border-radius: var(--radius-md);
  background: #fff;
}

.weixin-qr-frame img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: contain;
}

.feishu-qr-frame img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: contain;
}

.weixin-setup-placeholder {
  color: var(--ink-muted);
  background: var(--surface-muted-faint);
}

.weixin-setup-placeholder.error {
  color: var(--text-error);
}

.feishu-setup-placeholder {
  color: var(--ink-muted);
  background: var(--surface-muted-faint);
}

.feishu-setup-placeholder.error {
  color: var(--text-error);
}

.weixin-login-state {
  display: flex;
  min-height: 20px;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: var(--ink-soft);
  font-size: var(--font-size-meta);
  text-align: center;
}

.weixin-login-state.error {
  color: var(--text-error);
}

.feishu-login-state {
  display: flex;
  min-height: 20px;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: var(--ink-soft);
  font-size: var(--font-size-meta);
  text-align: center;
}

.feishu-login-state.error {
  color: var(--text-error);
}

.weixin-login-state time {
  padding-left: 8px;
  border-left: 1px solid var(--line-soft);
  color: var(--ink-muted);
  font-family: var(--font-mono);
  font-size: var(--font-size-caption);
}

.feishu-login-state time {
  padding-left: 8px;
  border-left: 1px solid var(--line-soft);
  color: var(--ink-muted);
  font-family: var(--font-mono);
  font-size: var(--font-size-caption);
}

.weixin-verify-form {
  display: flex;
  width: 100%;
  align-items: center;
  gap: 8px;
  padding-top: 2px;
}

.weixin-verify-form input {
  flex: 1 1 auto;
  font-family: var(--font-mono);
}

@media (max-width: 520px) {
  .messaging-modal-backdrop {
    padding: 16px;
  }

  .messaging-modal-heading,
  .messaging-modal-fields,
  .weixin-setup-body,
  .feishu-setup-body {
    padding-right: 14px;
    padding-left: 14px;
  }

  .messaging-modal-actions {
    padding-right: 14px;
    padding-left: 14px;
  }

  .messaging-setup-modes {
    margin-right: 14px;
    margin-left: 14px;
  }
}
</style>
