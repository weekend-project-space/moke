import { uiText } from '../../../text/uiText'
import type { ConnectionState, MessagingPlatform, RegistrationLogin, RegistrationPlatform, SetupChannel, WeixinLogin } from './messagingTypes'

export function platformLabel(platform: MessagingPlatform) {
  if (platform === 'weixin') return uiText.messaging.weChat
  return platform === 'dingtalk' ? uiText.messaging.dingTalk : uiText.messaging.feishu
}

export function connectionStateLabel(state: ConnectionState) {
  return {
    stopped: uiText.messaging.stopped,
    starting: uiText.messaging.connecting,
    connected: uiText.messaging.connected,
    reconnecting: uiText.messaging.reconnecting,
    reauth_required: uiText.messaging.authorizationRequired,
    error: uiText.messaging.connectionError,
  }[state]
}

export function connectionTime(connection: { last_inbound_at?: string; last_outbound_at?: string; last_connected_at?: string }) {
  const value = connection.last_inbound_at || connection.last_outbound_at || connection.last_connected_at
  if (!value) return uiText.messaging.noActivity
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? uiText.messaging.noActivity : uiText.messaging.lastActive(date.toLocaleString())
}

export function setupTitle(channel: Exclude<SetupChannel, null>, editingDingTalkId: string) {
  if (channel === 'weixin') return uiText.messaging.addWeChat
  return channel === 'dingtalk'
    ? (editingDingTalkId ? uiText.messaging.configureDingTalk : uiText.messaging.addDingTalk)
    : uiText.messaging.addFeishu
}

export function setupDescription(channel: Exclude<SetupChannel, null>) {
  return channel === 'weixin' ? uiText.messaging.connectWeChatDescription : channel === 'dingtalk' ? uiText.messaging.connectDingTalkDescription : uiText.messaging.connectFeishuDescription
}

export function loginStatusLabel(status: WeixinLogin['status']) {
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

export function registrationLoginStatusLabel(status: RegistrationLogin['status'], channel: RegistrationPlatform, domain: 'feishu' | 'lark') {
  return {
    waiting_scan: channel === 'dingtalk'
      ? uiText.messaging.scanWithDingTalk
      : domain === 'lark' ? uiText.messaging.scanWithLark : uiText.messaging.scanWithFeishu,
    expired: uiText.messaging.qrExpired,
    denied: uiText.messaging.authorizationDenied,
    confirmed: uiText.messaging.authorizationSucceeded,
    failed: uiText.messaging.authorizationFailed,
    cancelled: uiText.messaging.authorizationCancelled,
  }[status]
}
