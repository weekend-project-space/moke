import { BookOpenText, Bot, Boxes, Compass, MessageCircleMore, ShieldCheck } from 'lucide-vue-next'
import type { Component } from 'vue'

export type SettingsTab = 'model' | 'mcp' | 'skills' | 'messaging' | 'permissions' | 'browser'

export type SettingsNavigationItem = {
  id: SettingsTab
  label: string
  icon: Component
}

export const settingsNavigationItems: SettingsNavigationItem[] = [
  { id: 'model', label: 'Model', icon: Bot },
  { id: 'mcp', label: 'MCP', icon: Boxes },
  { id: 'skills', label: 'Skills', icon: BookOpenText },
  { id: 'messaging', label: 'Messaging', icon: MessageCircleMore },
  { id: 'permissions', label: 'Permissions', icon: ShieldCheck },
  { id: 'browser', label: 'Browser', icon: Compass },
]
