<script setup lang="ts">
import { RefreshCw, Link2, Plus } from 'lucide-vue-next'
import { uiText } from '../../../text/uiText'
import dingTalkIcon from '../../../assets/dingtalk.svg'
import feishuIcon from '../../../assets/feishu.svg'
import weChatIcon from '../../../assets/wechat.svg'
import type { MessagingConnection } from './messagingTypes'
import { connectionStateLabel, connectionTime, platformLabel } from './messagingPresentation'

defineProps<{
  connections: MessagingConnection[]
  selectedConnectionId: string
  loading: boolean
  hasActiveLogin: boolean
  hasActiveRegistrationLogin: boolean
}>()

const emit = defineEmits<{
  refresh: []
  select: [connection: MessagingConnection]
  add: []
}>()

const channelIcons: Record<MessagingConnection['platform'], string> = {
  weixin: weChatIcon,
  dingtalk: dingTalkIcon,
  feishu: feishuIcon,
}
</script>

<template>
  <aside class="settings-record-source" :aria-label="uiText.messaging.yourChannels">
    <header class="settings-record-heading">
      <div class="settings-record-heading-text">
        <h3>{{ uiText.messaging.yourChannels }}</h3>
        <span>{{ connections.length ? uiText.messaging.channelCount(connections.length) : uiText.messaging.noChannels }}</span>
      </div>
      <div class="settings-record-heading-actions">
        <button type="button" class="settings-icon-button" :title="uiText.messaging.refreshChannels" :aria-label="uiText.messaging.refreshChannels" :disabled="loading" @click="emit('refresh')">
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
        @click="emit('select', connection)"
        @keydown.enter.prevent="emit('select', connection)"
        @keydown.space.prevent="emit('select', connection)"
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
      <button type="button" class="settings-secondary settings-record-add" :disabled="hasActiveLogin || hasActiveRegistrationLogin" @click="emit('add')">
        <Plus :size="14" />{{ uiText.messaging.addChannel }}
      </button>
    </footer>
  </aside>
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
</style>
