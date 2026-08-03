import { createApp } from 'vue'
import './style.scss'
import App from './App.vue'
import { initializeApiAccess } from './services/apiAccess'

void initializeApiAccess().catch((error) => {
  console.error('Agent API initialization failed', error)
})
createApp(App).mount('#app')
