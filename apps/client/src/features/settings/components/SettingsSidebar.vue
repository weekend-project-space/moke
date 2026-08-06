<script setup lang="ts">
import { ArrowLeft } from 'lucide-vue-next'
import { uiText } from '../../../text/uiText'
import { settingsNavigationItems, type SettingsTab } from '../model/settingsNavigation'

defineProps<{
  activeTab: SettingsTab
}>()

const emit = defineEmits<{
  close: []
  select: [tab: SettingsTab]
}>()
</script>

<template>
  <aside class="settings-navigation" @contextmenu.prevent>
    <nav aria-label="Settings sections">
      <button
        v-for="item in settingsNavigationItems"
        :key="item.id"
        type="button"
        class="settings-navigation-button"
        :class="{ active: activeTab === item.id }"
        :aria-current="activeTab === item.id ? 'page' : undefined"
        @click="emit('select', item.id)"
      >
        <component :is="item.icon" :size="15" stroke-width="1.9" aria-hidden="true" />
        <span>{{ item.label }}</span>
      </button>
    </nav>
    <footer class="settings-navigation-footer">
      <button
        type="button"
        class="settings-return-button"
        @click="emit('close')"
      >
        <ArrowLeft :size="15" stroke-width="1.9" aria-hidden="true" />
        <span>{{ uiText.settings.returnToChat }}</span>
      </button>
    </footer>
  </aside>
</template>
