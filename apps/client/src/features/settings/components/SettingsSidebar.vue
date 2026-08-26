<script setup lang="ts">
import { ArrowLeft, Monitor, Moon, Sun } from 'lucide-vue-next'
import { useTheme, type ThemeMode } from '../../../composables/useTheme'
import { uiText } from '../../../text/uiText'
import { settingsNavigationItems, type SettingsTab } from '../model/settingsNavigation'

defineProps<{
  activeTab: SettingsTab
}>()

const emit = defineEmits<{
  close: []
  select: [tab: SettingsTab]
}>()

const { mode, setTheme } = useTheme()
const themeOptions: Array<{ value: ThemeMode; label: string }> = [
  { value: 'system', label: uiText.settings.themeSystem },
  { value: 'light', label: uiText.settings.themeLight },
  { value: 'dark', label: uiText.settings.themeDark },
]

function themeIcon(theme: ThemeMode) {
  return theme === 'dark' ? Moon : theme === 'light' ? Sun : Monitor
}

function onThemeChange(event: Event) {
  setTheme((event.target as HTMLSelectElement).value as ThemeMode)
}
</script>

<template>
  <aside class="settings-navigation" @contextmenu.prevent>
    <nav aria-label="Settings sections">
      <button
        v-for="item in settingsNavigationItems"
        :key="item.id"
        type="button"
        class="settings-navigation-button sidebar-navigation-item"
        :class="{ active: activeTab === item.id }"
        :aria-current="activeTab === item.id ? 'page' : undefined"
        @click="emit('select', item.id)"
      >
        <component :is="item.icon" :size="15" stroke-width="1.9" aria-hidden="true" />
        <span>{{ item.label }}</span>
      </button>
    </nav>
    <footer class="settings-navigation-footer">
      <label class="settings-theme-control">
        <span>{{ uiText.settings.theme }}</span>
        <span class="settings-theme-select-wrap">
          <component :is="themeIcon(mode)" :size="14" aria-hidden="true" />
          <select :value="mode" :aria-label="uiText.settings.theme" @change="onThemeChange">
            <option v-for="option in themeOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
          </select>
        </span>
      </label>
      <button
        type="button"
        class="settings-return-button sidebar-navigation-item"
        @click="emit('close')"
      >
        <ArrowLeft :size="15" stroke-width="1.9" aria-hidden="true" />
        <span>{{ uiText.settings.returnToChat }}</span>
      </button>
    </footer>
  </aside>
</template>
