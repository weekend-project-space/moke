export type ConnectionState = 'stopped' | 'starting' | 'connected' | 'reconnecting' | 'reauth_required' | 'error'

export type MessagingPlatform = 'weixin' | 'dingtalk' | 'feishu'

export type MessagingConnection = {
  id: string
  platform: MessagingPlatform
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

export type WeixinLogin = {
  id: string
  status: 'waiting_scan' | 'scanned' | 'verify_required' | 'expired' | 'confirmed' | 'already_connected' | 'failed' | 'cancelled'
  qr_image?: string
  expires_at: string
  error?: { code: string; message: string }
}

export type RegistrationPlatform = 'dingtalk' | 'feishu'

export type RegistrationLogin = {
  id: string
  status: 'waiting_scan' | 'expired' | 'denied' | 'confirmed' | 'failed' | 'cancelled'
  qr_image?: string
  expires_at: string
  next_poll_after_ms: number
  error?: { code: string; message: string }
}

export type SetupChannel = MessagingPlatform | null

export type SetupField =
  | 'verifyCode'
  | 'dingtalkClientId'
  | 'dingtalkClientSecret'
  | 'dingtalkAllowedUsers'
  | 'dingtalkCardTemplateId'
  | 'feishuAppId'
  | 'feishuAppSecret'
  | 'feishuDomain'

export type SetupPanelState = {
  channelPickerOpen: boolean
  setupChannel: SetupChannel
  editingDingTalkId: string
  manualDraftDirty: boolean
  savingDingTalk: boolean
  savingFeishu: boolean
  creatingLogin: boolean
  hasActiveLogin: boolean
  login: WeixinLogin | null
  loginConnectionId?: string
  loginStatusText: string
  verifyCode: string
  creatingRegistrationLogin: boolean
  hasActiveRegistrationLogin: boolean
  registrationLogin: RegistrationLogin | null
  registrationLoginStatusText: string
  registrationLoginHasError: boolean
  currentRegistrationSetupMode: 'quick' | 'manual'
  feishuDomain: 'feishu' | 'lark'
  dingtalkClientId: string
  dingtalkClientSecret: string
  dingtalkAllowedUsers: string
  dingtalkCardTemplateId: string
  feishuAppId: string
  feishuAppSecret: string
  error: string
}
