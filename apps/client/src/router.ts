import { createRouter, createWebHashHistory, type RouteLocationNormalized } from 'vue-router'
import ChatWorkspace from './features/chat/components/ChatWorkspace.vue'
import SettingsWorkspace from './features/settings/components/SettingsWorkspace.vue'
import { settingsNavigationItems, type SettingsTab } from './features/settings/model/settingsNavigation'
import { routeFromLegacyHash } from './routing/legacyRoute'

const validSettingsTabs = new Set<SettingsTab>(settingsNavigationItems.map((item) => item.id))

normalizeLegacyHash()

export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', redirect: { name: 'chat' } },
    { name: 'chat', path: '/chat/:sessionId?', component: ChatWorkspace },
    { name: 'tasks', path: '/tasks', component: ChatWorkspace },
    { name: 'settings', path: '/settings/:tab?', component: SettingsWorkspace },
    { path: '/:pathMatch(.*)*', redirect: { name: 'chat' } },
  ],
})

router.beforeEach((to) => {
  if (to.name === 'settings' && (!to.params.tab || !validSettingsTabs.has(to.params.tab as SettingsTab))) {
    return { name: 'settings', params: { tab: 'model' } }
  }
  if (to.name === 'chat' && typeof to.params.sessionId === 'string' && !to.params.sessionId.trim()) {
    return { name: 'chat' }
  }
  return true
})

function normalizeLegacyHash() {
  const hash = window.location.hash
  const route = routeFromLegacyHash(hash)
  if (route) window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}#${route}`)
}

export function isChatRoute(route: RouteLocationNormalized) {
  return route.name === 'chat' || route.name === 'tasks'
}
