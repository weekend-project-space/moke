<script setup lang="ts">
import { CircleAlert, ChevronRight, LoaderCircle, Save, Undo2, X } from 'lucide-vue-next'
import { uiText } from '../../../text/uiText'
import dingTalkIcon from '../../../assets/dingtalk.svg'
import feishuIcon from '../../../assets/feishu.svg'
import weChatIcon from '../../../assets/wechat.svg'
import type { MessagingPlatform, SetupChannel, SetupField, SetupPanelState } from './messagingTypes'
import { setupDescription, setupTitle } from './messagingPresentation'

const props = defineProps<{ state: SetupPanelState }>()
const emit = defineEmits<{
  'field-change': [field: SetupField, value: string]
  'close-picker': []
  'open-weixin': [connectionId?: string]
  'open-dingtalk': []
  'open-feishu': []
  'request-close': []
  'close-setup': []
  'retry-weixin': [connectionId?: string]
  'verify': []
  'set-registration-mode': [platform: Exclude<SetupChannel, 'weixin' | null>, mode: 'quick' | 'manual']
  'retry-registration': [platform: Exclude<SetupChannel, 'weixin' | null>]
  'set-feishu-domain': [domain: 'feishu' | 'lark']
  'save-dingtalk': []
  'revert-dingtalk': []
  'save-feishu': []
}>()

const channelIcons: Record<MessagingPlatform, string> = {
  weixin: weChatIcon,
  dingtalk: dingTalkIcon,
  feishu: feishuIcon,
}

function updateField(field: SetupField, event: Event) {
  emit('field-change', field, (event.target as HTMLInputElement | HTMLSelectElement).value)
}
</script>

<template>
  <div v-if="state.channelPickerOpen" class="settings-record-detail-view">
    <section class="messaging-detail-panel" aria-labelledby="channel-picker-title">
      <div class="settings-record-heading">
        <div class="settings-record-heading-copy">
          <div class="settings-record-heading-text">
            <h3 id="channel-picker-title">{{ uiText.messaging.addChannel }}</h3>
            <span>{{ uiText.messaging.availableChannelsDescription }}</span>
          </div>
        </div>
        <button type="button" class="settings-icon-button" :title="uiText.messaging.close" :aria-label="uiText.messaging.close" @click="emit('close-picker')"><X :size="14" /></button>
      </div>
      <div class="messaging-channel-list">
        <button type="button" class="settings-list-row messaging-channel-row" :disabled="state.creatingLogin || state.hasActiveLogin" @click="emit('open-weixin')">
          <span class="settings-list-main messaging-connection-main"><span class="messaging-connection-icon" aria-hidden="true"><img class="messaging-brand-icon" :src="channelIcons.weixin" alt="" /></span><span class="settings-list-copy messaging-connection-copy"><strong>{{ uiText.messaging.weChat }}</strong><span>{{ uiText.messaging.personalWeChat }}</span></span></span><ChevronRight class="messaging-channel-enter" :size="15" aria-hidden="true" />
        </button>
        <button type="button" class="settings-list-row messaging-channel-row" @click="emit('open-dingtalk')">
          <span class="settings-list-main messaging-connection-main"><span class="messaging-connection-icon" aria-hidden="true"><img class="messaging-brand-icon" :src="channelIcons.dingtalk" alt="" /></span><span class="settings-list-copy messaging-connection-copy"><strong>{{ uiText.messaging.dingTalk }}</strong><span>{{ uiText.messaging.dingTalkDescription }}</span></span></span><ChevronRight class="messaging-channel-enter" :size="15" aria-hidden="true" />
        </button>
        <button type="button" class="settings-list-row messaging-channel-row" @click="emit('open-feishu')">
          <span class="settings-list-main messaging-connection-main"><span class="messaging-connection-icon" aria-hidden="true"><img class="messaging-brand-icon" :src="channelIcons.feishu" alt="" /></span><span class="settings-list-copy messaging-connection-copy"><strong>{{ uiText.messaging.feishu }}</strong><span>{{ uiText.messaging.feishuDescription }}</span></span></span><ChevronRight class="messaging-channel-enter" :size="15" aria-hidden="true" />
        </button>
      </div>
    </section>
  </div>

  <div v-else-if="state.setupChannel" class="settings-record-detail-view">
    <section class="messaging-detail-panel" :class="[`is-${state.setupChannel}`, { 'has-setup-modes': state.setupChannel !== 'weixin' && !state.editingDingTalkId }]" aria-labelledby="messaging-setup-title">
      <div class="settings-record-heading">
        <div class="settings-record-heading-copy">
          <div class="settings-record-icon messaging-panel-icon" aria-hidden="true"><img class="messaging-brand-icon" :src="channelIcons[state.setupChannel]" alt="" /></div>
          <div class="settings-record-heading-text">
            <h3 id="messaging-setup-title">{{ setupTitle(state.setupChannel, state.editingDingTalkId) }}</h3>
            <span>{{ setupDescription(state.setupChannel) }}</span>
          </div>
        </div>
        <div class="settings-record-heading-actions">
          <span v-if="state.manualDraftDirty" class="settings-dirty-status">{{ uiText.settings.unsaved }}</span>
          <button type="button" class="settings-icon-button" :title="uiText.messaging.close" :aria-label="uiText.messaging.close" :disabled="state.savingDingTalk || state.savingFeishu" @click="emit('request-close')"><X :size="14" /></button>
        </div>
      </div>

      <template v-if="state.setupChannel === 'weixin'">
        <div class="weixin-setup-body">
          <div v-if="state.login?.qr_image && state.hasActiveLogin" class="weixin-qr-frame"><img :src="state.login.qr_image" :alt="uiText.messaging.weChatQrCode" /></div>
          <div v-else class="weixin-setup-placeholder" :class="{ error: Boolean(state.error) || state.login?.status === 'failed' || state.login?.status === 'expired' }">
            <CircleAlert v-if="state.error || state.login?.status === 'failed' || state.login?.status === 'expired'" :size="20" />
            <LoaderCircle v-else :size="20" class="spinning" />
          </div>
          <div class="weixin-login-state" :class="{ error: Boolean(state.error) || state.login?.status === 'failed' || state.login?.status === 'expired' }">
            <span>{{ state.error || state.login?.error?.message || state.loginStatusText || uiText.messaging.preparingAuthorization }}</span>
            <time v-if="state.login && state.hasActiveLogin">{{ new Date(state.login.expires_at).toLocaleTimeString() }}</time>
          </div>
          <form v-if="state.login?.status === 'verify_required'" class="weixin-verify-form" @submit.prevent="emit('verify')">
            <input :value="state.verifyCode" inputmode="numeric" pattern="[0-9]*" maxlength="12" autocomplete="one-time-code" :aria-label="uiText.messaging.verificationCode" :placeholder="uiText.messaging.verificationCode" @input="updateField('verifyCode', $event)" />
            <button type="submit" class="settings-primary" :disabled="!/^\d{1,12}$/.test(state.verifyCode)">{{ uiText.messaging.confirm }}</button>
          </form>
        </div>
        <div class="settings-record-detail-actions messaging-panel-actions">
          <button v-if="state.error || state.login?.status === 'failed' || state.login?.status === 'expired'" type="button" class="settings-secondary" :disabled="state.creatingLogin" @click="emit('retry-weixin', state.loginConnectionId)">{{ uiText.messaging.tryAgain }}</button>
          <button type="button" class="settings-secondary" @click="emit('close-setup')">{{ uiText.messaging.cancel }}</button>
        </div>
      </template>

      <template v-else>
        <div v-if="!state.editingDingTalkId" class="settings-segmented messaging-setup-modes" role="tablist" :aria-label="uiText.messaging.setupMethod">
          <button type="button" role="tab" :aria-selected="state.currentRegistrationSetupMode === 'quick'" :class="{ active: state.currentRegistrationSetupMode === 'quick' }" @click="emit('set-registration-mode', state.setupChannel, 'quick')">{{ uiText.messaging.quickSetup }}</button>
          <button type="button" role="tab" :aria-selected="state.currentRegistrationSetupMode === 'manual'" :class="{ active: state.currentRegistrationSetupMode === 'manual' }" @click="emit('set-registration-mode', state.setupChannel, 'manual')">{{ uiText.messaging.manualSetup }}</button>
        </div>

        <template v-if="state.currentRegistrationSetupMode === 'quick'">
          <div class="registration-setup-body" :class="{ compact: state.setupChannel === 'dingtalk' }">
            <div v-if="state.setupChannel === 'feishu'" class="feishu-region-choice" role="radiogroup" :aria-label="uiText.messaging.region">
              <button type="button" role="radio" :aria-checked="state.feishuDomain === 'feishu'" :class="{ active: state.feishuDomain === 'feishu' }" :disabled="state.creatingRegistrationLogin" @click="emit('set-feishu-domain', 'feishu')">{{ uiText.messaging.feishuChina }}</button>
              <button type="button" role="radio" :aria-checked="state.feishuDomain === 'lark'" :class="{ active: state.feishuDomain === 'lark' }" :disabled="state.creatingRegistrationLogin" @click="emit('set-feishu-domain', 'lark')">{{ uiText.messaging.larkGlobal }}</button>
            </div>
            <div v-if="state.registrationLogin?.qr_image && state.hasActiveRegistrationLogin" class="registration-qr-frame"><img :src="state.registrationLogin.qr_image" :alt="state.setupChannel === 'dingtalk' ? uiText.messaging.dingTalkQrCode : uiText.messaging.feishuQrCode" /></div>
            <div v-else class="registration-setup-placeholder" :class="{ error: state.registrationLoginHasError }">
              <CircleAlert v-if="state.registrationLoginHasError" :size="20" />
              <LoaderCircle v-else :size="20" class="spinning" />
            </div>
            <div class="registration-login-state" :class="{ error: state.registrationLoginHasError }">
              <span>{{ state.error || state.registrationLogin?.error?.message || state.registrationLoginStatusText || uiText.messaging.preparingAuthorization }}</span>
              <time v-if="state.registrationLogin && state.hasActiveRegistrationLogin">{{ new Date(state.registrationLogin.expires_at).toLocaleTimeString() }}</time>
            </div>
          </div>
          <div class="settings-record-detail-actions messaging-panel-actions">
            <button v-if="state.registrationLoginHasError" type="button" class="settings-secondary" :disabled="state.creatingRegistrationLogin" @click="emit('retry-registration', state.setupChannel)">{{ uiText.messaging.tryAgain }}</button>
            <button type="button" class="settings-secondary" @click="emit('close-setup')">{{ uiText.messaging.cancel }}</button>
          </div>
        </template>

        <form v-else-if="state.setupChannel === 'dingtalk'" class="messaging-credentials-form" @submit.prevent="emit('save-dingtalk')">
          <div class="settings-record-detail-scroll messaging-panel-fields">
            <label v-if="!state.editingDingTalkId">{{ uiText.messaging.clientId }}<input :value="state.dingtalkClientId" required maxlength="200" autocomplete="off" @input="updateField('dingtalkClientId', $event)" /></label>
            <label v-if="!state.editingDingTalkId">{{ uiText.messaging.clientSecret }}<input :value="state.dingtalkClientSecret" required type="password" maxlength="2000" autocomplete="new-password" @input="updateField('dingtalkClientSecret', $event)" /></label>
            <label>{{ uiText.messaging.allowedUsers }}<input :value="state.dingtalkAllowedUsers" maxlength="4000" :placeholder="uiText.messaging.allowedUsersPlaceholder" autocomplete="off" @input="updateField('dingtalkAllowedUsers', $event)" /></label>
            <label>{{ uiText.messaging.cardTemplateId }}<input :value="state.dingtalkCardTemplateId" maxlength="300" :placeholder="uiText.messaging.optional" autocomplete="off" @input="updateField('dingtalkCardTemplateId', $event)" /></label>
            <p v-if="state.error" class="messaging-panel-error" role="alert">{{ state.error }}</p>
          </div>
          <div class="settings-record-detail-actions messaging-panel-actions">
            <button v-if="state.editingDingTalkId" type="button" class="settings-secondary" :disabled="state.savingDingTalk || !state.manualDraftDirty" @click="emit('revert-dingtalk')"><Undo2 :size="14" />{{ uiText.settings.revert }}</button>
            <button v-else type="button" class="settings-secondary" :disabled="state.savingDingTalk" @click="emit('close-setup')">{{ uiText.settings.cancel }}</button>
            <button type="submit" class="settings-primary" :disabled="state.savingDingTalk || !state.manualDraftDirty || (!state.editingDingTalkId && (!state.dingtalkClientId.trim() || !state.dingtalkClientSecret.trim()))"><Save :size="14" />{{ state.editingDingTalkId ? uiText.settings.save : uiText.messaging.saveAndConnect }}</button>
          </div>
        </form>

        <form v-else class="messaging-credentials-form" @submit.prevent="emit('save-feishu')">
          <div class="settings-record-detail-scroll messaging-panel-fields">
            <label>{{ uiText.messaging.appId }}<input :value="state.feishuAppId" required maxlength="200" autocomplete="off" @input="updateField('feishuAppId', $event)" /></label>
            <label>{{ uiText.messaging.appSecret }}<input :value="state.feishuAppSecret" required type="password" maxlength="2000" autocomplete="new-password" @input="updateField('feishuAppSecret', $event)" /></label>
            <label>{{ uiText.messaging.region }}<select :value="state.feishuDomain" @change="updateField('feishuDomain', $event)"><option value="feishu">{{ uiText.messaging.feishuChina }}</option><option value="lark">{{ uiText.messaging.larkGlobal }}</option></select></label>
            <p v-if="state.error" class="messaging-panel-error" role="alert">{{ state.error }}</p>
          </div>
          <div class="settings-record-detail-actions messaging-panel-actions">
            <button type="button" class="settings-secondary" :disabled="state.savingFeishu" @click="emit('close-setup')">{{ uiText.settings.cancel }}</button>
            <button type="submit" class="settings-primary" :disabled="state.savingFeishu || !state.feishuAppId.trim() || !state.feishuAppSecret.trim() || !state.manualDraftDirty"><Save :size="14" />{{ uiText.messaging.saveAndConnect }}</button>
          </div>
        </form>
      </template>
    </section>
  </div>
</template>

<style scoped>
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
  min-width: 0;
  height: 28px;
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

.feishu-region-choice button:disabled {
  cursor: default;
  opacity: 0.6;
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

.weixin-setup-body,
.registration-setup-body {
  display: grid;
  place-items: center;
  align-content: center;
  gap: 10px;
  padding: 16px;
}

.weixin-setup-body {
  min-height: 286px;
}

.registration-setup-body {
  min-height: 304px;
  padding: 14px 16px 16px;
}

.registration-setup-body.compact {
  min-height: 286px;
  padding-top: 16px;
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

.weixin-qr-frame img,
.registration-qr-frame img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: contain;
}

.weixin-setup-placeholder,
.registration-setup-placeholder {
  color: var(--color-text-muted);
  background: var(--color-zinc-50);
}

.weixin-setup-placeholder.error,
.registration-setup-placeholder.error {
  color: var(--color-danger-text);
}

.weixin-login-state,
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

.weixin-login-state.error,
.registration-login-state.error {
  color: var(--color-danger-text);
}

.weixin-login-state time,
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
