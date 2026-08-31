<script setup lang="ts">
import { CircleAlert, Link2, Plus, RefreshCw, Settings2, Square, Trash2 } from 'lucide-vue-next'
import { uiText } from '../../../text/uiText'
import dingTalkIcon from '../../../assets/dingtalk.svg'
import feishuIcon from '../../../assets/feishu.svg'
import weChatIcon from '../../../assets/wechat.svg'
import type { MessagingConnection } from './messagingTypes'
import { connectionStateLabel, connectionTime, platformLabel } from './messagingPresentation'

const props = defineProps<{
  connection: MessagingConnection | null
  busyConnectionId: string
  hasActiveLogin: boolean
  hasActiveRegistrationLogin: boolean
}>()

const emit = defineEmits<{
  add: []
  delete: [connection: MessagingConnection]
  configure: [connection: MessagingConnection]
  action: [connection: MessagingConnection, action: 'start' | 'stop' | 'reauthorize']
}>()

const channelIcons: Record<MessagingConnection['platform'], string> = {
  weixin: weChatIcon,
  dingtalk: dingTalkIcon,
  feishu: feishuIcon,
}
</script>

<template>
  <div v-if="props.connection" class="settings-record-detail-view">
    <section class="messaging-detail-panel" aria-labelledby="messaging-connection-title">
      <div class="settings-record-heading">
        <div class="settings-record-heading-copy">
          <div class="settings-record-icon messaging-panel-icon" aria-hidden="true"><img class="messaging-brand-icon" :src="channelIcons[props.connection.platform]" alt="" /></div>
          <div class="settings-record-heading-text">
            <h3 id="messaging-connection-title">{{ props.connection.bot_name || platformLabel(props.connection.platform) }}</h3>
            <span>{{ props.connection.name }}</span>
          </div>
        </div>
        <span class="messaging-state" :class="`is-${props.connection.state}`">{{ connectionStateLabel(props.connection.state) }}</span>
      </div>

      <div class="settings-record-detail-scroll messaging-connection-detail">
        <div class="messaging-detail-fact"><span>{{ uiText.messaging.platform }}</span><strong>{{ platformLabel(props.connection.platform) }}</strong></div>
        <div class="messaging-detail-fact"><span>{{ uiText.messaging.status }}</span><strong>{{ connectionStateLabel(props.connection.state) }}</strong></div>
        <div class="messaging-detail-fact"><span>{{ uiText.messaging.lastActivity }}</span><strong>{{ connectionTime(props.connection) }}</strong></div>
        <div v-if="props.connection.platform === 'dingtalk' && props.connection.allowed_user_ids?.length" class="messaging-detail-fact"><span>{{ uiText.messaging.allowedUsers }}</span><strong>{{ props.connection.allowed_user_ids.join(', ') }}</strong></div>
        <div v-if="props.connection.platform === 'dingtalk' && props.connection.card_template_id" class="messaging-detail-fact"><span>{{ uiText.messaging.cardTemplateId }}</span><strong>{{ props.connection.card_template_id }}</strong></div>
        <div v-if="props.connection.last_error" class="messaging-detail-error" role="alert"><CircleAlert :size="15" /><span>{{ props.connection.last_error.message }}</span></div>
      </div>

      <div class="settings-record-detail-actions messaging-panel-actions messaging-detail-actions">
        <button type="button" class="settings-danger-ghost" :disabled="busyConnectionId === props.connection.id" @click="emit('delete', props.connection)"><Trash2 :size="14" />{{ uiText.messaging.removeChannel }}</button>
        <div class="settings-record-actions-right">
          <button v-if="props.connection.platform === 'dingtalk'" type="button" class="settings-secondary" :disabled="busyConnectionId === props.connection.id" @click="emit('configure', props.connection)"><Settings2 :size="14" />{{ uiText.messaging.configureChannel }}</button>
          <button v-if="props.connection.state === 'connected' || props.connection.state === 'starting' || props.connection.state === 'reconnecting'" type="button" class="settings-secondary" :disabled="busyConnectionId === props.connection.id" @click="emit('action', props.connection, 'stop')"><Square :size="13" fill="currentColor" />{{ uiText.messaging.stopChannel }}</button>
          <button v-else type="button" class="settings-secondary" :disabled="busyConnectionId === props.connection.id" @click="emit('action', props.connection, 'start')"><RefreshCw :size="14" :class="{ spinning: busyConnectionId === props.connection.id }" />{{ uiText.messaging.startChannel }}</button>
          <button v-if="props.connection.platform === 'weixin'" type="button" class="settings-secondary" :disabled="busyConnectionId === props.connection.id || hasActiveLogin" @click="emit('action', props.connection, 'reauthorize')"><Link2 :size="14" />{{ uiText.messaging.reauthorizeWeChat }}</button>
        </div>
      </div>
    </section>
  </div>

  <div v-else class="settings-record-empty messaging-detail-empty">
    <Link2 :size="20" stroke-width="1.7" />
    <strong>{{ uiText.messaging.noChannels }}</strong>
    <span>{{ uiText.messaging.empty }}</span>
    <button type="button" class="settings-primary" :disabled="hasActiveLogin || hasActiveRegistrationLogin" @click="emit('add')"><Plus :size="14" />{{ uiText.messaging.addChannel }}</button>
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

.messaging-panel-actions {
  justify-content: flex-end;
}

.messaging-detail-actions {
  justify-content: space-between;
  flex-wrap: wrap;
}
</style>
