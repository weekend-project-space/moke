import { createApp } from 'vue'
import './style.scss'
import App from './App.vue'
import { initializeApiAccess } from './services/apiAccess'
import { router } from './router'
import { useTheme } from './composables/useTheme'

useTheme().initializeTheme()

void initializeApiAccess().catch((error) => {
  console.error('Agent API initialization failed', error)
})
createApp(App).use(router).mount('#app')
