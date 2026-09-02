<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { uiText } from '../../../text/uiText'
import { requestSettingsJson } from '../api/settingsApi'
import { useSettingsDiscardFlow } from '../composables/useSettingsDiscardFlow'
import MessagingConnectionDetail from './MessagingConnectionDetail.vue'
import MessagingConnectionList from './MessagingConnectionList.vue'
import MessagingSetupPanel from './MessagingSetupPanel.vue'
import SettingsConfirmSheet from './SettingsConfirmSheet.vue'
import type { MessagingConnection, RegistrationLogin, RegistrationPlatform, SetupField, SetupPanelState, WeixinLogin } from './messagingTypes'
import { loginStatusLabel, platformLabel, registrationLoginStatusLabel } from './messagingPresentation'

const props = defineProps<{ apiBase: string }>()
const emit = defineEmits<{
  dirtyChange: [dirty: boolean]
}>()

const connections = ref<MessagingConnection[]>([])
const setupChannel = ref<'weixin' | 'dingtalk' | 'feishu' | null>(null)
const channelPickerOpen = ref(false)
const selectedConnectionId = ref('')
const loginConnectionId = ref<string>()
const dingtalkClientId = ref('')
const dingtalkClientSecret = ref('')
const dingtalkAllowedUsers = ref('')
const dingtalkCardTemplateId = ref('')
const editingDingTalkId = ref('')
const dingtalkSetupMode = ref<'quick' | 'manual'>('quick')
const savingDingTalk = ref(false)
const feishuAppId = ref('')
const feishuAppSecret = ref('')
const feishuDomain = ref<'feishu' | 'lark'>('feishu')
const feishuSetupMode = ref<'quick' | 'manual'>('quick')
const savingFeishu = ref(false)
const registrationLogin = ref<RegistrationLogin | null>(null)
const registrationLoginPlatform = ref<RegistrationPlatform | null>(null)
const creatingRegistrationLogin = ref(false)
const login = ref<WeixinLogin | null>(null)
const verifyCode = ref('')
const loading = ref(false)
const creatingLogin = ref(false)
const busyConnectionId = ref('')
const error = ref('')
const deleteConfirmationOpen = ref(false)
const deleteTarget = ref<MessagingConnection | null>(null)
const savedDingTalkDraft = ref('')
const savedFeishuDraft = ref('')
let pollTimer: number | undefined
let registrationPollTimer: number | undefined
let loginRequest = 0
let registrationLoginRequest = 0

const loginStatusText = computed(() => login.value ? loginStatusLabel(login.value.status) : '')
const hasActiveLogin = computed(() => login.value && !isTerminalLogin(login.value.status))
const registrationLoginStatusText = computed(() => registrationLogin.value && registrationLoginPlatform.value
  ? registrationLoginStatusLabel(registrationLogin.value.status, registrationLoginPlatform.value, feishuDomain.value)
  : '')
const hasActiveRegistrationLogin = computed(() => registrationLogin.value && !isTerminalRegistrationLogin(registrationLogin.value.status))
const currentRegistrationSetupMode = computed(() => setupChannel.value === 'dingtalk' ? dingtalkSetupMode.value : feishuSetupMode.value)
const registrationLoginHasError = computed(() => Boolean(error.value) || ['failed', 'expired', 'denied'].includes(registrationLogin.value?.status ?? ''))
const selectedConnection = computed(() => connections.value.find((connection) => connection.id === selectedConnectionId.value) || null)
const dingtalkDraftDirty = computed(() => dingtalkDraftSnapshot() !== savedDingTalkDraft.value)
const feishuDraftDirty = computed(() => feishuDraftSnapshot() !== savedFeishuDraft.value)
const manualDraftDirty = computed(() => {
  if (currentRegistrationSetupMode.value !== 'manual') return false
  if (setupChannel.value === 'dingtalk') return dingtalkDraftDirty.value
  return setupChannel.value === 'feishu' && feishuDraftDirty.value
})
const setupPanelState = computed<SetupPanelState>(() => ({
  channelPickerOpen: channelPickerOpen.value,
  setupChannel: setupChannel.value,
  editingDingTalkId: editingDingTalkId.value,
  manualDraftDirty: manualDraftDirty.value,
  savingDingTalk: savingDingTalk.value,
  savingFeishu: savingFeishu.value,
  creatingLogin: creatingLogin.value,
  hasActiveLogin: Boolean(hasActiveLogin.value),
  login: login.value,
  loginConnectionId: loginConnectionId.value,
  loginStatusText: loginStatusText.value,
  verifyCode: verifyCode.value,
  creatingRegistrationLogin: creatingRegistrationLogin.value,
  hasActiveRegistrationLogin: Boolean(hasActiveRegistrationLogin.value),
  registrationLogin: registrationLogin.value,
  registrationLoginStatusText: registrationLoginStatusText.value,
  registrationLoginHasError: registrationLoginHasError.value,
  currentRegistrationSetupMode: currentRegistrationSetupMode.value,
  feishuDomain: feishuDomain.value,
  dingtalkClientId: dingtalkClientId.value,
  dingtalkClientSecret: dingtalkClientSecret.value,
  dingtalkAllowedUsers: dingtalkAllowedUsers.value,
  dingtalkCardTemplateId: dingtalkCardTemplateId.value,
  feishuAppId: feishuAppId.value,
  feishuAppSecret: feishuAppSecret.value,
  error: error.value,
}))
const {
  pendingAction: pendingChannelAction,
  runAfterDiscard: runAfterDraftDiscard,
  cancelDiscard: cancelPendingChannelAction,
  confirmDiscard: confirmPendingChannelAction,
} = useSettingsDiscardFlow({
  dirty: manualDraftDirty,
  discard: discardManualDraft,
  onDirtyChange: (dirty) => emit('dirtyChange', dirty),
})

function dingtalkDraftSnapshot() {
  return JSON.stringify({
    clientId: dingtalkClientId.value,
    clientSecret: dingtalkClientSecret.value,
    allowedUsers: dingtalkAllowedUsers.value,
    cardTemplateId: dingtalkCardTemplateId.value,
  })
}

function feishuDraftSnapshot() {
  return JSON.stringify({
    appId: feishuAppId.value,
    appSecret: feishuAppSecret.value,
    domain: feishuDomain.value,
  })
}

function saveDingTalkDraftSnapshot() {
  savedDingTalkDraft.value = dingtalkDraftSnapshot()
}

function saveFeishuDraftSnapshot() {
  savedFeishuDraft.value = feishuDraftSnapshot()
}

function revertDingTalkDraft() {
  if (!editingDingTalkId.value || savingDingTalk.value) return
  restoreDingTalkDraft()
  error.value = ''
}

function restoreDingTalkDraft() {
  const saved = JSON.parse(savedDingTalkDraft.value) as {
    clientId: string
    clientSecret: string
    allowedUsers: string
    cardTemplateId: string
  }
  dingtalkClientId.value = saved.clientId
  dingtalkClientSecret.value = saved.clientSecret
  dingtalkAllowedUsers.value = saved.allowedUsers
  dingtalkCardTemplateId.value = saved.cardTemplateId
}

function restoreFeishuDraft() {
  const saved = JSON.parse(savedFeishuDraft.value) as {
    appId: string
    appSecret: string
    domain: 'feishu' | 'lark'
  }
  feishuAppId.value = saved.appId
  feishuAppSecret.value = saved.appSecret
  feishuDomain.value = saved.domain
}

function discardManualDraft() {
  if (setupChannel.value === 'dingtalk') restoreDingTalkDraft()
  else if (setupChannel.value === 'feishu') restoreFeishuDraft()
}

function updateSetupField(field: SetupField, value: string) {
  if (field === 'verifyCode') verifyCode.value = value
  else if (field === 'dingtalkClientId') dingtalkClientId.value = value
  else if (field === 'dingtalkClientSecret') dingtalkClientSecret.value = value
  else if (field === 'dingtalkAllowedUsers') dingtalkAllowedUsers.value = value
  else if (field === 'dingtalkCardTemplateId') dingtalkCardTemplateId.value = value
  else if (field === 'feishuAppId') feishuAppId.value = value
  else if (field === 'feishuAppSecret') feishuAppSecret.value = value
  else if (field === 'feishuDomain') feishuDomain.value = value === 'lark' ? 'lark' : 'feishu'
}

function requestJson<T>(path: string, init?: RequestInit) {
  return requestSettingsJson<T>(props.apiBase, path, init)
}

async function loadConnections() {
  loading.value = true
  error.value = ''
  try {
    const data = await requestJson<{ connections?: MessagingConnection[] }>('/api/messaging/connections')
    connections.value = Array.isArray(data.connections) ? data.connections : []
    if (!connections.value.some((connection) => connection.id === selectedConnectionId.value)) {
      selectedConnectionId.value = connections.value[0]?.id || ''
    }
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

async function beginRegistrationLogin(platform: RegistrationPlatform) {
  const request = ++registrationLoginRequest
  creatingRegistrationLogin.value = true
  registrationLogin.value = null
  registrationLoginPlatform.value = platform
  error.value = ''
  try {
    const data = await requestJson<{ login?: RegistrationLogin }>(`/api/messaging/${platform}/logins`, json('POST',
      platform === 'feishu' ? { domain: feishuDomain.value } : {},
    ))
    if (!data.login) throw new Error(uiText.messaging.invalidLoginResponse)
    if (request !== registrationLoginRequest || setupChannel.value !== platform || currentRegistrationSetupMode.value !== 'quick') {
      if (!isTerminalRegistrationLogin(data.login.status)) {
        void requestJson(`/api/messaging/${platform}/logins/${encodeURIComponent(data.login.id)}`, { method: 'DELETE' }).catch(() => undefined)
      }
      return
    }
    registrationLogin.value = data.login
    startRegistrationPolling()
  } catch (reason) {
    if (request === registrationLoginRequest) error.value = messageFrom(reason, registrationStartFailure(platform))
  } finally {
    if (request === registrationLoginRequest) creatingRegistrationLogin.value = false
  }
}

async function pollRegistrationLogin() {
  const current = registrationLogin.value
  const platform = registrationLoginPlatform.value
  if (!current || !platform || isTerminalRegistrationLogin(current.status)) {
    stopRegistrationPolling()
    return
  }
  try {
    const data = await requestJson<{ login?: RegistrationLogin }>(`/api/messaging/${platform}/logins/${encodeURIComponent(current.id)}`)
    if (!data.login) throw new Error(uiText.messaging.invalidLoginResponse)
    if (setupChannel.value !== platform || currentRegistrationSetupMode.value !== 'quick' || registrationLogin.value?.id !== current.id) return
    registrationLogin.value = { ...data.login, qr_image: data.login.qr_image || current.qr_image }
    if (isTerminalRegistrationLogin(data.login.status)) {
      stopRegistrationPolling()
      if (data.login.status === 'confirmed') {
        await loadConnections()
        setupChannel.value = null
        registrationLogin.value = null
        registrationLoginPlatform.value = null
      }
    }
  } catch (reason) {
    stopRegistrationPolling()
    error.value = messageFrom(reason, registrationCheckFailure(platform))
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
  channelPickerOpen.value = false
  setupChannel.value = 'weixin'
  selectedConnectionId.value = connectionId || ''
  loginConnectionId.value = connectionId
  login.value = null
  verifyCode.value = ''
  error.value = ''
  void beginLogin(connectionId)
}

function openDingTalkSetup() {
  channelPickerOpen.value = false
  setupChannel.value = 'dingtalk'
  selectedConnectionId.value = ''
  dingtalkSetupMode.value = 'quick'
  dingtalkClientId.value = ''
  dingtalkClientSecret.value = ''
  dingtalkAllowedUsers.value = ''
  dingtalkCardTemplateId.value = ''
  editingDingTalkId.value = ''
  saveDingTalkDraftSnapshot()
  error.value = ''
  void beginRegistrationLogin('dingtalk')
}

function editDingTalk(connection: MessagingConnection) {
  editingDingTalkId.value = connection.id
  dingtalkAllowedUsers.value = connection.allowed_user_ids?.join(', ') || ''
  dingtalkCardTemplateId.value = connection.card_template_id || ''
  setupChannel.value = 'dingtalk'
  channelPickerOpen.value = false
  selectedConnectionId.value = connection.id
  dingtalkSetupMode.value = 'manual'
  saveDingTalkDraftSnapshot()
  error.value = ''
}

function openFeishuSetup() {
  channelPickerOpen.value = false
  setupChannel.value = 'feishu'
  selectedConnectionId.value = ''
  feishuSetupMode.value = 'quick'
  feishuAppId.value = ''
  feishuAppSecret.value = ''
  feishuDomain.value = 'feishu'
  saveFeishuDraftSnapshot()
  error.value = ''
  void beginRegistrationLogin('feishu')
}

function setRegistrationSetupMode(platform: RegistrationPlatform, mode: 'quick' | 'manual') {
  const setupMode = platform === 'dingtalk' ? dingtalkSetupMode : feishuSetupMode
  if (mode === setupMode.value) return
  runAfterDraftDiscard(() => { void commitRegistrationSetupMode(platform, mode) })
}

async function commitRegistrationSetupMode(platform: RegistrationPlatform, mode: 'quick' | 'manual') {
  const setupMode = platform === 'dingtalk' ? dingtalkSetupMode : feishuSetupMode
  await cancelRegistrationLogin()
  setupMode.value = mode
  error.value = ''
  if (mode === 'quick') void beginRegistrationLogin(platform)
}

async function setFeishuDomain(domain: 'feishu' | 'lark') {
  if (domain === feishuDomain.value) return
  await cancelRegistrationLogin()
  feishuDomain.value = domain
  error.value = ''
  if (setupChannel.value === 'feishu' && feishuSetupMode.value === 'quick') void beginRegistrationLogin('feishu')
}

async function closeSetup() {
  if (savingDingTalk.value || savingFeishu.value) return
  loginRequest += 1
  registrationLoginRequest += 1
  creatingLogin.value = false
  creatingRegistrationLogin.value = false
  const current = login.value
  const shouldCancelLogin = setupChannel.value === 'weixin' && current && !isTerminalLogin(current.status)
  const currentRegistrationLogin = registrationLogin.value
  const currentRegistrationPlatform = registrationLoginPlatform.value
  const shouldCancelRegistrationLogin = currentRegistrationLogin && currentRegistrationPlatform && !isTerminalRegistrationLogin(currentRegistrationLogin.status)
  stopPolling()
  stopRegistrationPolling()
  login.value = null
  loginConnectionId.value = undefined
  verifyCode.value = ''
  dingtalkClientId.value = ''
  dingtalkClientSecret.value = ''
  dingtalkAllowedUsers.value = ''
  dingtalkCardTemplateId.value = ''
  editingDingTalkId.value = ''
  dingtalkSetupMode.value = 'quick'
  feishuAppId.value = ''
  feishuAppSecret.value = ''
  feishuDomain.value = 'feishu'
  feishuSetupMode.value = 'quick'
  registrationLogin.value = null
  registrationLoginPlatform.value = null
  saveDingTalkDraftSnapshot()
  saveFeishuDraftSnapshot()
  error.value = ''
  setupChannel.value = null
  channelPickerOpen.value = false
  if (!connections.value.some((connection) => connection.id === selectedConnectionId.value)) {
    selectedConnectionId.value = connections.value[0]?.id || ''
  }

  if (shouldCancelLogin) {
    try {
      await requestJson(`/api/messaging/weixin/logins/${encodeURIComponent(current.id)}`, { method: 'DELETE' })
    } catch {
      // The local setup flow can close after the server has expired the authorization.
    }
  }
  if (shouldCancelRegistrationLogin) {
    try {
      await requestJson(`/api/messaging/${currentRegistrationPlatform}/logins/${encodeURIComponent(currentRegistrationLogin.id)}`, { method: 'DELETE' })
    } catch {
      // The local setup flow can close after the server has expired the authorization.
    }
  }
}

function closeChannelPicker() {
  channelPickerOpen.value = false
  if (!connections.value.some((connection) => connection.id === selectedConnectionId.value)) {
    selectedConnectionId.value = connections.value[0]?.id || ''
  }
}

function commitSelectConnection(connection: MessagingConnection) {
  if (setupChannel.value) {
    void closeSetup().then(() => {
      selectedConnectionId.value = connection.id
    })
    return
  }
  channelPickerOpen.value = false
  selectedConnectionId.value = connection.id
  error.value = ''
}

function selectConnection(connection: MessagingConnection) {
  if (!setupChannel.value && connection.id === selectedConnectionId.value) return
  runAfterDraftDiscard(() => commitSelectConnection(connection))
}

async function beginAddChannel() {
  if (hasActiveLogin.value || hasActiveRegistrationLogin.value || savingDingTalk.value || savingFeishu.value) return
  if (setupChannel.value) await closeSetup()
  channelPickerOpen.value = true
  error.value = ''
}

function startAddChannel() {
  runAfterDraftDiscard(() => { void beginAddChannel() })
}

function requestCloseSetup() {
  runAfterDraftDiscard(() => { void closeSetup() })
}

function requestDeleteConnection(connection: MessagingConnection) {
  if (busyConnectionId.value === connection.id) return
  deleteTarget.value = connection
  deleteConfirmationOpen.value = true
}

function cancelDeleteConnection() {
  if (busyConnectionId.value) return
  deleteConfirmationOpen.value = false
  deleteTarget.value = null
}

async function confirmDeleteConnection() {
  const connection = deleteTarget.value
  if (!connection || busyConnectionId.value) return
  busyConnectionId.value = connection.id
  error.value = ''
  try {
    await requestJson(`/api/messaging/connections/${encodeURIComponent(connection.id)}`, { method: 'DELETE' })
    await loadConnections()
    deleteConfirmationOpen.value = false
    deleteTarget.value = null
  } catch (reason) {
    error.value = messageFrom(reason, uiText.messaging.updateFailed)
  } finally {
    busyConnectionId.value = ''
  }
}

async function connectionAction(connection: MessagingConnection, action: 'start' | 'stop' | 'reauthorize') {
  busyConnectionId.value = connection.id
  error.value = ''
  try {
    if (action === 'reauthorize') {
      if (connection.platform !== 'weixin') return
      openWeixinSetup(connection.id)
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

function startRegistrationPolling() {
  stopRegistrationPolling()
  registrationPollTimer = window.setInterval(() => { void pollRegistrationLogin() }, 1500)
  void pollRegistrationLogin()
}

function stopRegistrationPolling() {
  if (registrationPollTimer !== undefined) window.clearInterval(registrationPollTimer)
  registrationPollTimer = undefined
}

async function cancelRegistrationLogin() {
  registrationLoginRequest += 1
  creatingRegistrationLogin.value = false
  const current = registrationLogin.value
  const platform = registrationLoginPlatform.value
  stopRegistrationPolling()
  registrationLogin.value = null
  registrationLoginPlatform.value = null
  if (!current || !platform || isTerminalRegistrationLogin(current.status)) return
  try {
    await requestJson(`/api/messaging/${platform}/logins/${encodeURIComponent(current.id)}`, { method: 'DELETE' })
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

function isTerminalLogin(status: WeixinLogin['status']) {
  return status === 'expired' || status === 'confirmed' || status === 'already_connected' || status === 'failed' || status === 'cancelled'
}

function isTerminalRegistrationLogin(status: RegistrationLogin['status']) {
  return status === 'expired' || status === 'denied' || status === 'confirmed' || status === 'failed' || status === 'cancelled'
}

function registrationStartFailure(platform: RegistrationPlatform) {
  return platform === 'dingtalk' ? uiText.messaging.startDingTalkAuthorizationFailed : uiText.messaging.startFeishuAuthorizationFailed
}

function registrationCheckFailure(platform: RegistrationPlatform) {
  return platform === 'dingtalk' ? uiText.messaging.checkDingTalkAuthorizationFailed : uiText.messaging.checkFeishuAuthorizationFailed
}

function messageFrom(reason: unknown, fallback: string) {
  return reason instanceof Error && reason.message ? reason.message : fallback
}

onMounted(() => { void loadConnections() })
onBeforeUnmount(() => {
  stopPolling()
  stopRegistrationPolling()
  void cancelRegistrationLogin()
})
</script>

<template>
  <section class="settings-section settings-record-page">
    <div class="settings-record-layout">
      <MessagingConnectionList
        :connections="connections"
        :selected-connection-id="selectedConnectionId"
        :loading="loading"
        :has-active-login="Boolean(hasActiveLogin)"
        :has-active-registration-login="Boolean(hasActiveRegistrationLogin)"
        @refresh="loadConnections"
        @select="selectConnection"
        @add="startAddChannel"
      />

        <section class="settings-record-detail" :aria-label="channelPickerOpen || setupChannel ? uiText.messaging.addChannel : uiText.messaging.yourChannels">
          <p v-if="error && !setupChannel" class="messaging-feedback error" role="alert">{{ error }}</p>
          <MessagingSetupPanel
            :state="setupPanelState"
            @field-change="updateSetupField"
            @close-picker="closeChannelPicker"
            @open-weixin="openWeixinSetup"
            @open-dingtalk="openDingTalkSetup"
            @open-feishu="openFeishuSetup"
            @request-close="requestCloseSetup"
            @close-setup="closeSetup"
            @retry-weixin="beginLogin"
            @verify="submitVerifyCode"
            @set-registration-mode="setRegistrationSetupMode"
            @retry-registration="beginRegistrationLogin"
            @set-feishu-domain="setFeishuDomain"
            @save-dingtalk="saveDingTalkConnection"
            @revert-dingtalk="revertDingTalkDraft"
            @save-feishu="saveFeishuConnection"
          />

          <MessagingConnectionDetail
            v-if="!channelPickerOpen && !setupChannel"
            :connection="selectedConnection"
            :busy-connection-id="busyConnectionId"
            :has-active-login="Boolean(hasActiveLogin)"
            :has-active-registration-login="Boolean(hasActiveRegistrationLogin)"
            @add="startAddChannel"
            @delete="requestDeleteConnection"
            @configure="editDingTalk"
            @action="connectionAction"
          />
        </section>
      </div>
  </section>

  <SettingsConfirmSheet
    :open="Boolean(pendingChannelAction)"
    dialog-id="messaging-discard-confirm"
    :title="uiText.settings.confirmDiscardChangesTitle"
    :description="uiText.settings.confirmDiscardSettingsChanges"
    :confirm-label="uiText.settings.confirmDiscardModelChangesAction"
    :cancel-label="uiText.settings.cancel"
    tone="neutral"
    @cancel="cancelPendingChannelAction"
    @confirm="confirmPendingChannelAction"
  />

  <SettingsConfirmSheet
    :open="deleteConfirmationOpen"
    dialog-id="messaging-delete-confirm"
    :title="uiText.messaging.removeChannel"
    :description="deleteTarget ? uiText.messaging.confirmRemove(platformLabel(deleteTarget.platform)) : ''"
    :confirm-label="uiText.messaging.removeChannel"
    :cancel-label="uiText.messaging.cancel"
    :busy="Boolean(busyConnectionId)"
    @cancel="cancelDeleteConnection"
    @confirm="confirmDeleteConnection"
  />
</template>
