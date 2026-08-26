<script setup lang="ts">
import { apiFetch } from '../../../services/apiAccess'
import {
  ChevronRight,
  CircleAlert,
  Link2,
  LoaderCircle,
  Plus,
  RefreshCw,
  Save,
  Settings2,
  Square,
  Trash2,
  Undo2,
  X,
} from 'lucide-vue-next'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import dingTalkIcon from '../../../assets/dingtalk.svg'
import feishuIcon from '../../../assets/feishu.svg'
import weChatIcon from '../../../assets/wechat.svg'
import { uiText } from '../../../text/uiText'
import SettingsConfirmSheet from './SettingsConfirmSheet.vue'

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

type RegistrationPlatform = 'dingtalk' | 'feishu'

type RegistrationLogin = {
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
const pendingChannelAction = ref<(() => void) | null>(null)
let pollTimer: number | undefined
let registrationPollTimer: number | undefined
let loginRequest = 0
let registrationLoginRequest = 0

const loginStatusText = computed(() => login.value ? loginStatusLabel(login.value.status) : '')
const hasActiveLogin = computed(() => login.value && !isTerminalLogin(login.value.status))
const registrationLoginStatusText = computed(() => registrationLogin.value ? registrationLoginStatusLabel(registrationLogin.value.status) : '')
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

function runAfterDraftDiscard(action: () => void) {
  if (manualDraftDirty.value) pendingChannelAction.value = action
  else action()
}

function cancelPendingChannelAction() {
  pendingChannelAction.value = null
}

function confirmPendingChannelAction() {
  const action = pendingChannelAction.value
  if (!action) return
  pendingChannelAction.value = null
  discardManualDraft()
  action()
}

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
  selectedConnectionId.value = ''
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

function registrationLoginStatusLabel(status: RegistrationLogin['status']) {
  return {
    waiting_scan: setupChannel.value === 'dingtalk'
      ? uiText.messaging.scanWithDingTalk
      : feishuDomain.value === 'lark' ? uiText.messaging.scanWithLark : uiText.messaging.scanWithFeishu,
    expired: uiText.messaging.qrExpired,
    denied: uiText.messaging.authorizationDenied,
    confirmed: uiText.messaging.authorizationSucceeded,
    failed: uiText.messaging.authorizationFailed,
    cancelled: uiText.messaging.authorizationCancelled,
  }[status]
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
watch(manualDraftDirty, (dirty) => emit('dirtyChange', dirty), { immediate: true })
onBeforeUnmount(() => {
  emit('dirtyChange', false)
  stopPolling()
  stopRegistrationPolling()
  void cancelRegistrationLogin()
})
</script>

<template>
  <section class="settings-section settings-record-page">
    <div class="settings-record-layout">
      <aside class="settings-record-source" :aria-label="uiText.messaging.yourChannels">
        <header class="settings-record-heading">
          <div class="settings-record-heading-text">
        <h3>{{ uiText.messaging.yourChannels }}</h3>
        <span>{{ connections.length ? uiText.messaging.channelCount(connections.length) : uiText.messaging.noChannels }}</span>
          </div>
          <div class="settings-record-heading-actions">
        <button type="button" class="settings-icon-button" :title="uiText.messaging.refreshChannels" :aria-label="uiText.messaging.refreshChannels" :disabled="loading" @click="loadConnections">
          <RefreshCw :size="14" :class="{ spinning: loading }" />
        </button>
          </div>
        </header>
    <div v-if="connections.length === 0" class="settings-record-empty messaging-empty">
      <Link2 :size="18" stroke-width="1.7" />
      <span>{{ loading ? uiText.messaging.loading : uiText.messaging.noChannels }}</span>
    </div>
    <div v-else class="settings-record-source-list" role="listbox" :aria-label="uiText.messaging.yourChannels">
      <div
        v-for="connection in connections"
        :key="connection.id"
        class="settings-record-source-row settings-list-row messaging-connection-row"
        role="option"
        tabindex="0"
        :aria-selected="connection.id === selectedConnectionId"
        :class="{ active: connection.id === selectedConnectionId }"
        @click="selectConnection(connection)"
        @keydown.enter.prevent="selectConnection(connection)"
        @keydown.space.prevent="selectConnection(connection)"
      >
        <div class="settings-list-main messaging-connection-main">
          <div class="messaging-connection-icon" aria-hidden="true">
            <img class="messaging-brand-icon" :src="channelIcons[connection.platform]" alt="" />
          </div>
          <div class="settings-list-copy messaging-connection-copy">
            <strong>{{ connection.bot_name || platformLabel(connection.platform) }}<template v-if="!connection.bot_name && connection.name !== platformLabel(connection.platform)"> · {{ connection.name }}</template></strong>
            <span>{{ connectionTime(connection) }}</span>
            <small v-if="connection.last_error">{{ connection.last_error.message }}</small>
          </div>
        </div>
        <span class="messaging-state" :class="`is-${connection.state}`">{{ connectionStateLabel(connection.state) }}</span>
      </div>
    </div>
          <footer class="settings-record-source-footer">
            <button type="button" class="settings-secondary settings-record-add" :disabled="Boolean(hasActiveLogin) || Boolean(hasActiveRegistrationLogin)" @click="startAddChannel">
              <Plus :size="14" />{{ uiText.messaging.addChannel }}
            </button>
          </footer>
        </aside>

        <section class="settings-record-detail" :aria-label="uiText.messaging.availableChannels">
    <p v-if="error && !setupChannel" class="messaging-feedback error" role="alert">{{ error }}</p>
    <div v-if="channelPickerOpen" class="settings-record-detail-view">
      <section class="messaging-detail-panel" aria-labelledby="channel-picker-title">
        <div class="settings-record-heading">
          <div class="settings-record-heading-copy"><div class="settings-record-heading-text"><h3 id="channel-picker-title">{{ uiText.messaging.addChannel }}</h3><span>{{ uiText.messaging.availableChannelsDescription }}</span></div></div>
          <button type="button" class="settings-icon-button" :title="uiText.messaging.close" :aria-label="uiText.messaging.close" @click="closeChannelPicker"><X :size="14" /></button>
        </div>
        <div class="messaging-channel-list">
          <button type="button" class="settings-list-row messaging-channel-row" :disabled="creatingLogin || Boolean(hasActiveLogin)" @click="openWeixinSetup()"><span class="settings-list-main messaging-connection-main"><span class="messaging-connection-icon" aria-hidden="true"><img class="messaging-brand-icon" :src="channelIcons.weixin" alt="" /></span><span class="settings-list-copy messaging-connection-copy"><strong>{{ uiText.messaging.weChat }}</strong><span>{{ uiText.messaging.personalWeChat }}</span></span></span><ChevronRight class="messaging-channel-enter" :size="15" aria-hidden="true" /></button>
          <button type="button" class="settings-list-row messaging-channel-row" @click="openDingTalkSetup"><span class="settings-list-main messaging-connection-main"><span class="messaging-connection-icon" aria-hidden="true"><img class="messaging-brand-icon" :src="channelIcons.dingtalk" alt="" /></span><span class="settings-list-copy messaging-connection-copy"><strong>{{ uiText.messaging.dingTalk }}</strong><span>{{ uiText.messaging.dingTalkDescription }}</span></span></span><ChevronRight class="messaging-channel-enter" :size="15" aria-hidden="true" /></button>
          <button type="button" class="settings-list-row messaging-channel-row" @click="openFeishuSetup"><span class="settings-list-main messaging-connection-main"><span class="messaging-connection-icon" aria-hidden="true"><img class="messaging-brand-icon" :src="channelIcons.feishu" alt="" /></span><span class="settings-list-copy messaging-connection-copy"><strong>{{ uiText.messaging.feishu }}</strong><span>{{ uiText.messaging.feishuDescription }}</span></span></span><ChevronRight class="messaging-channel-enter" :size="15" aria-hidden="true" /></button>
        </div>
      </section>
    </div>

    <div v-else-if="setupChannel" class="settings-record-detail-view">
      <section
        class="messaging-detail-panel"
        :class="[
          `is-${setupChannel}`,
          { 'has-setup-modes': setupChannel !== 'weixin' && !editingDingTalkId },
        ]"
        aria-labelledby="messaging-setup-title"
      >
        <div class="settings-record-heading">
          <div class="settings-record-heading-copy">
            <div class="settings-record-icon messaging-panel-icon" aria-hidden="true">
              <img class="messaging-brand-icon" :src="channelIcons[setupChannel]" alt="" />
            </div>
            <div class="settings-record-heading-text">
              <h3 id="messaging-setup-title">{{ setupTitle(setupChannel) }}</h3>
              <span>{{ setupDescription(setupChannel) }}</span>
            </div>
          </div>
          <div class="settings-record-heading-actions">
            <span v-if="manualDraftDirty" class="settings-dirty-status">{{ uiText.settings.unsaved }}</span>
            <button type="button" class="settings-icon-button" :title="uiText.messaging.close" :aria-label="uiText.messaging.close" :disabled="savingDingTalk || savingFeishu" @click="requestCloseSetup"><X :size="14" /></button>
          </div>
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
          <div class="settings-record-detail-actions messaging-panel-actions">
            <button v-if="error || login?.status === 'failed' || login?.status === 'expired'" type="button" class="settings-secondary" :disabled="creatingLogin" @click="beginLogin(loginConnectionId)">{{ uiText.messaging.tryAgain }}</button>
            <button type="button" class="settings-secondary" @click="closeSetup">{{ uiText.messaging.cancel }}</button>
          </div>
        </template>

        <template v-else>
          <div v-if="!editingDingTalkId" class="settings-segmented messaging-setup-modes" role="tablist" :aria-label="uiText.messaging.setupMethod">
            <button type="button" role="tab" :aria-selected="currentRegistrationSetupMode === 'quick'" :class="{ active: currentRegistrationSetupMode === 'quick' }" @click="setRegistrationSetupMode(setupChannel, 'quick')">{{ uiText.messaging.quickSetup }}</button>
            <button type="button" role="tab" :aria-selected="currentRegistrationSetupMode === 'manual'" :class="{ active: currentRegistrationSetupMode === 'manual' }" @click="setRegistrationSetupMode(setupChannel, 'manual')">{{ uiText.messaging.manualSetup }}</button>
          </div>

          <template v-if="currentRegistrationSetupMode === 'quick'">
            <div class="registration-setup-body" :class="{ compact: setupChannel === 'dingtalk' }">
              <div v-if="setupChannel === 'feishu'" class="feishu-region-choice" role="radiogroup" :aria-label="uiText.messaging.region">
                <button type="button" role="radio" :aria-checked="feishuDomain === 'feishu'" :class="{ active: feishuDomain === 'feishu' }" :disabled="creatingRegistrationLogin" @click="setFeishuDomain('feishu')">{{ uiText.messaging.feishuChina }}</button>
                <button type="button" role="radio" :aria-checked="feishuDomain === 'lark'" :class="{ active: feishuDomain === 'lark' }" :disabled="creatingRegistrationLogin" @click="setFeishuDomain('lark')">{{ uiText.messaging.larkGlobal }}</button>
              </div>

              <div v-if="registrationLogin?.qr_image && hasActiveRegistrationLogin" class="registration-qr-frame">
                <img :src="registrationLogin.qr_image" :alt="setupChannel === 'dingtalk' ? uiText.messaging.dingTalkQrCode : uiText.messaging.feishuQrCode" />
              </div>
              <div v-else class="registration-setup-placeholder" :class="{ error: registrationLoginHasError }">
                <CircleAlert v-if="registrationLoginHasError" :size="20" />
                <LoaderCircle v-else :size="20" class="spinning" />
              </div>

              <div class="registration-login-state" :class="{ error: registrationLoginHasError }">
                <span>{{ error || registrationLogin?.error?.message || registrationLoginStatusText || uiText.messaging.preparingAuthorization }}</span>
                <time v-if="registrationLogin && hasActiveRegistrationLogin">{{ new Date(registrationLogin.expires_at).toLocaleTimeString() }}</time>
              </div>
            </div>
            <div class="settings-record-detail-actions messaging-panel-actions">
              <button v-if="registrationLoginHasError" type="button" class="settings-secondary" :disabled="creatingRegistrationLogin" @click="beginRegistrationLogin(setupChannel)">{{ uiText.messaging.tryAgain }}</button>
              <button type="button" class="settings-secondary" @click="closeSetup">{{ uiText.messaging.cancel }}</button>
            </div>
          </template>

          <form v-else-if="setupChannel === 'dingtalk'" class="messaging-credentials-form" @submit.prevent="saveDingTalkConnection">
            <div class="settings-record-detail-scroll messaging-panel-fields">
              <label v-if="!editingDingTalkId">{{ uiText.messaging.clientId }}<input v-model="dingtalkClientId" required maxlength="200" autocomplete="off" /></label>
              <label v-if="!editingDingTalkId">{{ uiText.messaging.clientSecret }}<input v-model="dingtalkClientSecret" required type="password" maxlength="2000" autocomplete="new-password" /></label>
              <label>{{ uiText.messaging.allowedUsers }}<input v-model="dingtalkAllowedUsers" maxlength="4000" :placeholder="uiText.messaging.allowedUsersPlaceholder" autocomplete="off" /></label>
              <label>{{ uiText.messaging.cardTemplateId }}<input v-model="dingtalkCardTemplateId" maxlength="300" :placeholder="uiText.messaging.optional" autocomplete="off" /></label>
              <p v-if="error" class="messaging-panel-error" role="alert">{{ error }}</p>
            </div>
            <div class="settings-record-detail-actions messaging-panel-actions">
              <button v-if="editingDingTalkId" type="button" class="settings-secondary" :disabled="savingDingTalk || !dingtalkDraftDirty" @click="revertDingTalkDraft"><Undo2 :size="14" />{{ uiText.settings.revert }}</button>
              <button v-else type="button" class="settings-secondary" :disabled="savingDingTalk" @click="closeSetup">{{ uiText.settings.cancel }}</button>
              <button type="submit" class="settings-primary" :disabled="savingDingTalk || !dingtalkDraftDirty || (!editingDingTalkId && (!dingtalkClientId.trim() || !dingtalkClientSecret.trim()))"><Save :size="14" />{{ editingDingTalkId ? uiText.settings.save : uiText.messaging.saveAndConnect }}</button>
            </div>
          </form>

          <form v-else class="messaging-credentials-form" @submit.prevent="saveFeishuConnection">
            <div class="settings-record-detail-scroll messaging-panel-fields">
              <label>{{ uiText.messaging.appId }}<input v-model="feishuAppId" required maxlength="200" autocomplete="off" /></label>
              <label>{{ uiText.messaging.appSecret }}<input v-model="feishuAppSecret" required type="password" maxlength="2000" autocomplete="new-password" /></label>
              <label>
                {{ uiText.messaging.region }}
                <select v-model="feishuDomain">
                  <option value="feishu">{{ uiText.messaging.feishuChina }}</option>
                  <option value="lark">{{ uiText.messaging.larkGlobal }}</option>
                </select>
              </label>
              <p v-if="error" class="messaging-panel-error" role="alert">{{ error }}</p>
            </div>
            <div class="settings-record-detail-actions messaging-panel-actions">
              <button type="button" class="settings-secondary" :disabled="savingFeishu" @click="closeSetup">{{ uiText.settings.cancel }}</button>
              <button type="submit" class="settings-primary" :disabled="savingFeishu || !feishuDraftDirty || !feishuAppId.trim() || !feishuAppSecret.trim()"><Save :size="14" />{{ uiText.messaging.saveAndConnect }}</button>
            </div>
          </form>
        </template>
      </section>
    </div>

    <div v-else-if="selectedConnection" class="settings-record-detail-view">
      <section class="messaging-detail-panel" aria-labelledby="messaging-connection-title">
        <div class="settings-record-heading">
          <div class="settings-record-heading-copy">
            <div class="settings-record-icon messaging-panel-icon" aria-hidden="true">
              <img class="messaging-brand-icon" :src="channelIcons[selectedConnection.platform]" alt="" />
            </div>
            <div class="settings-record-heading-text">
              <h3 id="messaging-connection-title">{{ selectedConnection.bot_name || platformLabel(selectedConnection.platform) }}</h3>
              <span>{{ selectedConnection.name }}</span>
            </div>
          </div>
          <span class="messaging-state" :class="`is-${selectedConnection.state}`">{{ connectionStateLabel(selectedConnection.state) }}</span>
        </div>

        <div class="settings-record-detail-scroll messaging-connection-detail">
          <div class="messaging-detail-fact">
            <span>{{ uiText.messaging.platform }}</span>
            <strong>{{ platformLabel(selectedConnection.platform) }}</strong>
          </div>
          <div class="messaging-detail-fact">
            <span>{{ uiText.messaging.status }}</span>
            <strong>{{ connectionStateLabel(selectedConnection.state) }}</strong>
          </div>
          <div class="messaging-detail-fact">
            <span>{{ uiText.messaging.lastActivity }}</span>
            <strong>{{ connectionTime(selectedConnection) }}</strong>
          </div>
          <div v-if="selectedConnection.platform === 'dingtalk' && selectedConnection.allowed_user_ids?.length" class="messaging-detail-fact">
            <span>{{ uiText.messaging.allowedUsers }}</span>
            <strong>{{ selectedConnection.allowed_user_ids.join(', ') }}</strong>
          </div>
          <div v-if="selectedConnection.platform === 'dingtalk' && selectedConnection.card_template_id" class="messaging-detail-fact">
            <span>{{ uiText.messaging.cardTemplateId }}</span>
            <strong>{{ selectedConnection.card_template_id }}</strong>
          </div>
          <div v-if="selectedConnection.last_error" class="messaging-detail-error" role="alert">
            <CircleAlert :size="15" />
            <span>{{ selectedConnection.last_error.message }}</span>
          </div>
        </div>

        <div class="settings-record-detail-actions messaging-panel-actions messaging-detail-actions">
          <button type="button" class="settings-danger-ghost" :disabled="busyConnectionId === selectedConnection.id" @click="requestDeleteConnection(selectedConnection)"><Trash2 :size="14" />{{ uiText.messaging.removeChannel }}</button>
          <div class="settings-record-actions-right">
            <button v-if="selectedConnection.platform === 'dingtalk'" type="button" class="settings-secondary" :disabled="busyConnectionId === selectedConnection.id" @click="editDingTalk(selectedConnection)"><Settings2 :size="14" />{{ uiText.messaging.configureChannel }}</button>
            <button v-if="selectedConnection.state === 'connected' || selectedConnection.state === 'starting' || selectedConnection.state === 'reconnecting'" type="button" class="settings-secondary" :disabled="busyConnectionId === selectedConnection.id" @click="connectionAction(selectedConnection, 'stop')"><Square :size="13" fill="currentColor" />{{ uiText.messaging.stopChannel }}</button>
            <button v-else type="button" class="settings-secondary" :disabled="busyConnectionId === selectedConnection.id" @click="connectionAction(selectedConnection, 'start')"><RefreshCw :size="14" :class="{ spinning: busyConnectionId === selectedConnection.id }" />{{ uiText.messaging.startChannel }}</button>
            <button v-if="selectedConnection.platform === 'weixin'" type="button" class="settings-secondary" :disabled="busyConnectionId === selectedConnection.id || Boolean(hasActiveLogin)" @click="connectionAction(selectedConnection, 'reauthorize')"><Link2 :size="14" />{{ uiText.messaging.reauthorizeWeChat }}</button>
          </div>
        </div>
      </section>
    </div>

    <div v-else class="settings-record-empty messaging-detail-empty">
      <Link2 :size="20" stroke-width="1.7" />
      <strong>{{ uiText.messaging.noChannels }}</strong>
      <span>{{ uiText.messaging.empty }}</span>
      <button type="button" class="settings-primary" :disabled="Boolean(hasActiveLogin) || Boolean(hasActiveRegistrationLogin)" @click="startAddChannel"><Plus :size="14" />{{ uiText.messaging.addChannel }}</button>
    </div>
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

<style scoped>
.messaging-connection-row {
  display: grid;
  min-height: 56px;
  grid-template-columns: minmax(0, 1fr) 8px;
  gap: 8px;
  padding: 7px 8px;
  outline: none;
}

.messaging-connection-row.active .settings-list-copy > :first-child {
  color: var(--color-primary-foreground);
}

.messaging-connection-row.active .settings-list-copy > :last-child {
  color: var(--color-text-on-accent-muted);
}

.messaging-connection-copy span,
.messaging-connection-copy small {
  font-size: var(--font-size-caption);
}

.messaging-connection-row > .messaging-state {
  width: 8px;
  min-width: 8px;
  overflow: hidden;
  color: transparent;
  font-size: 0;
}

.messaging-connection-row > .messaging-state::before {
  margin: 0;
}

.messaging-detail-panel {
  display: grid;
  width: 100%;
  min-width: 0;
  min-height: 0;
  flex: 1 1 auto;
  grid-template-rows: auto minmax(0, 1fr) auto;
}

.messaging-detail-panel.has-setup-modes {
  grid-template-rows: auto auto minmax(0, 1fr) auto;
}

.messaging-detail-empty {
  place-content: center;
}

.messaging-detail-empty strong {
  color: var(--color-text-primary);
  font-size: var(--font-size-ui);
  font-weight: 600;
}

.messaging-detail-empty span {
  margin-bottom: 5px;
  font-size: var(--font-size-meta);
}

.messaging-channel-list .messaging-channel-row:first-child {
  border-top: 0;
}

.messaging-channel-enter {
  flex: 0 0 auto;
  color: var(--color-text-muted);
  opacity: 0.58;
}

.messaging-channel-row:hover:not(:disabled) .messaging-channel-enter {
  color: var(--color-text-secondary);
  opacity: 1;
}

.messaging-panel-icon {
  border: 1px solid var(--color-border-default);
  color: var(--color-text-secondary);
  background: var(--color-zinc-50);
}

.messaging-panel-icon .messaging-brand-icon {
  width: 18px;
  height: 18px;
}

.messaging-connection-detail {
  display: grid;
  align-content: start;
  padding: 6px 8px 16px 0;
}

.messaging-detail-fact {
  display: grid;
  min-width: 0;
  min-height: 52px;
  grid-template-columns: minmax(110px, 160px) minmax(0, 1fr);
  align-items: center;
  gap: 14px;
  border-bottom: 1px solid var(--color-border-subtle);
  font-size: var(--font-size-ui);
}

.messaging-detail-fact span {
  color: var(--color-text-muted);
}

.messaging-detail-fact strong {
  min-width: 0;
  overflow-wrap: anywhere;
  font-weight: 520;
}

.messaging-detail-error {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin-top: 14px;
  padding: 10px 12px;
  color: var(--color-danger-text);
  background: var(--color-bg-danger-soft);
  font-size: var(--font-size-meta);
  line-height: 1.45;
}

.messaging-detail-error svg {
  flex: 0 0 auto;
  margin-top: 1px;
}

.messaging-credentials-form {
  display: grid;
  min-height: 0;
  grid-template-rows: minmax(0, 1fr) auto;
}

.messaging-setup-modes {
  display: grid;
  width: 100%;
  grid-template-columns: 1fr 1fr;
  margin: 12px 0 0;
}

.feishu-region-choice button {
  min-width: 0;
  border: 0;
  border-radius: calc(var(--radius-sm) - 2px);
  color: var(--color-text-muted);
  font: inherit;
  font-size: var(--font-size-meta);
  background: transparent;
  cursor: pointer;
}

.feishu-region-choice button.active {
  color: var(--color-text-primary);
  background: var(--color-bg-content);
  box-shadow: 0 0 0 1px var(--color-border-default), var(--shadow-control);
}

.feishu-region-choice button:focus-visible {
  outline: 2px solid var(--color-focus-border);
  outline-offset: 1px;
}

.messaging-panel-fields {
  display: grid;
  align-content: start;
  gap: 12px;
  padding: 18px 8px 18px 0;
}

.messaging-detail-panel label {
  display: grid;
  gap: 6px;
  color: var(--color-text-secondary);
  font-size: var(--font-size-meta);
}

.messaging-detail-panel input,
.messaging-detail-panel select {
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  height: 32px;
  border: 1px solid var(--color-border-default);
  border-radius: var(--radius-sm);
  padding: 0 9px;
  color: var(--color-text-primary);
  font: inherit;
  background: var(--color-bg-input);
  outline: none;
}

.messaging-detail-panel input:focus,
.messaging-detail-panel select:focus {
  border-color: var(--color-focus-border);
  box-shadow: 0 0 0 3px var(--color-focus-ring-soft);
}

.messaging-panel-error {
  margin: 0;
  color: var(--color-danger-text);
  font-size: var(--font-size-meta);
}

.messaging-panel-actions {
  justify-content: flex-end;
}

.messaging-detail-actions {
  justify-content: space-between;
  flex-wrap: wrap;
}

.weixin-setup-body {
  display: grid;
  min-height: 286px;
  place-items: center;
  align-content: center;
  gap: 10px;
  padding: 16px;
}

.registration-setup-body {
  display: grid;
  min-height: 304px;
  place-items: center;
  align-content: center;
  gap: 10px;
  padding: 14px 16px 16px;
}

.registration-setup-body.compact {
  min-height: 286px;
  padding-top: 16px;
}

.feishu-region-choice {
  display: grid;
  width: 216px;
  grid-template-columns: 1fr 1fr;
  gap: 2px;
  padding: 3px;
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-sm);
  background: var(--color-zinc-50);
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
.registration-qr-frame,
.registration-setup-placeholder {
  display: grid;
  width: 216px;
  height: 216px;
  place-items: center;
  border-radius: var(--radius-md);
  background: var(--color-qr-surface);
}

.weixin-qr-frame img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: contain;
}

.registration-qr-frame img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: contain;
}

.weixin-setup-placeholder {
  color: var(--color-text-muted);
  background: var(--color-zinc-50);
}

.weixin-setup-placeholder.error {
  color: var(--color-danger-text);
}

.registration-setup-placeholder {
  color: var(--color-text-muted);
  background: var(--color-zinc-50);
}

.registration-setup-placeholder.error {
  color: var(--color-danger-text);
}

.weixin-login-state {
  display: flex;
  min-height: 20px;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: var(--color-text-secondary);
  font-size: var(--font-size-meta);
  text-align: center;
}

.weixin-login-state.error {
  color: var(--color-danger-text);
}

.registration-login-state {
  display: flex;
  min-height: 20px;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: var(--color-text-secondary);
  font-size: var(--font-size-meta);
  text-align: center;
}

.registration-login-state.error {
  color: var(--color-danger-text);
}

.weixin-login-state time {
  padding-left: 8px;
  border-left: 1px solid var(--color-border-default);
  color: var(--color-text-muted);
  font-family: var(--font-mono);
  font-size: var(--font-size-caption);
}

.registration-login-state time {
  padding-left: 8px;
  border-left: 1px solid var(--color-border-default);
  color: var(--color-text-muted);
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

</style>
