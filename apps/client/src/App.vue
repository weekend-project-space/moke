<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

type AgentEvent = {
  id: string
  seq: number
  type: string
  ts: string
  payload: Record<string, any>
}

type Message = {
  role: 'user' | 'assistant'
  content: string
}

const sessionId = ref('')
const runId = ref('')
const input = ref('检查当前项目，并告诉我下一步应该做什么')
const messages = ref<Message[]>([])
const events = ref<AgentEvent[]>([])
const streamingText = ref('')
const pendingApproval = ref<any | null>(null)
const isRunning = ref(false)
const serverStatus = ref<'checking' | 'online' | 'offline'>('checking')
const statusText = computed(() => {
  if (serverStatus.value === 'checking') return 'Connecting'
  if (serverStatus.value === 'offline') return 'Server Offline'
  if (pendingApproval.value) return 'Awaiting Approval'
  if (isRunning.value) return 'Running'
  return 'Ready'
})
const apiBase =
  import.meta.env.VITE_API_BASE_URL ||
  (window.location.hostname === 'tauri.localhost' ? 'http://127.0.0.1:4010' : '')

async function checkServer() {
  serverStatus.value = 'checking'

  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      const response = await fetch(`${apiBase}/api/health`)
      if (response.ok) {
        serverStatus.value = 'online'
        return true
      }
    } catch {
      // Retry while the desktop shell is starting the local server.
    }

    await new Promise((resolve) => window.setTimeout(resolve, 300))
  }

  serverStatus.value = 'offline'
  return false
}

async function createSession() {
  if (serverStatus.value !== 'online' && !(await checkServer())) return

  const response = await fetch(`${apiBase}/api/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Moke Agent' }),
  })
  const data = await response.json()
  sessionId.value = data.session.id
}

async function sendMessage() {
  const content = input.value.trim()
  if (!content || isRunning.value) return

  if (serverStatus.value !== 'online' && !(await checkServer())) return
  if (!sessionId.value) await createSession()
  if (!sessionId.value) return

  messages.value.push({ role: 'user', content })
  input.value = ''
  events.value = []
  streamingText.value = ''
  pendingApproval.value = null
  isRunning.value = true

  const response = await fetch(`${apiBase}/api/sessions/${sessionId.value}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: { role: 'user', content },
      options: { stream: true, max_steps: 6 },
    }),
  })
  const data = await response.json()
  runId.value = data.run_id
  subscribe(data.events_url)
}

function subscribe(eventsUrl: string) {
  const source = new EventSource(`${apiBase}${eventsUrl}`)
  const eventTypes = [
    'agent.started',
    'agent.plan',
    'agent.state',
    'agent.message.delta',
    'agent.message.done',
    'tool.call',
    'tool.result',
    'approval.required',
    'agent.done',
    'agent.error',
  ]

  for (const type of eventTypes) {
    source.addEventListener(type, (message) => {
      const event = JSON.parse((message as MessageEvent).data) as AgentEvent
      events.value.push(event)

      if (event.type === 'agent.message.delta') {
        streamingText.value += event.payload.content || ''
      }

      if (event.type === 'approval.required') {
        pendingApproval.value = event.payload
      }

      if (event.type === 'agent.message.done') {
        messages.value.push(event.payload.message)
        streamingText.value = ''
      }

      if (event.type === 'agent.done' || event.type === 'agent.error') {
        isRunning.value = false
        source.close()
      }
    })
  }
}

async function decideApproval(decision: 'approved' | 'rejected') {
  if (!pendingApproval.value || !runId.value) return
  const approval = pendingApproval.value
  pendingApproval.value = null

  await fetch(`${apiBase}/api/runs/${runId.value}/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      approval_id: approval.approval_id,
      decision,
      message: decision === 'rejected' ? 'User rejected the action' : undefined,
    }),
  })
}

async function cancelRun() {
  if (!runId.value || !isRunning.value) return
  await fetch(`${apiBase}/api/runs/${runId.value}/cancel`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason: 'User cancelled' }),
  })
}

onMounted(async () => {
  if (await checkServer()) await createSession()
})
</script>

<template>
  <main class="shell">
    <aside class="sidebar">
      <div class="traffic-lights" aria-hidden="true">
        <span class="red"></span>
        <span class="yellow"></span>
        <span class="green"></span>
      </div>
      <section class="brand">
        <p>Local Agent</p>
        <h1>Moke</h1>
      </section>
      <button class="session active" type="button">
        <span>Workspace</span>
        <small>{{ sessionId || 'Creating session' }}</small>
      </button>
    </aside>

    <section class="chat">
      <header class="topbar">
        <div>
          <p>PreAct Runtime</p>
          <h2>{{ statusText }}</h2>
        </div>
        <span class="server-pill" :class="serverStatus">{{ serverStatus }}</span>
        <button class="ghost" type="button" :disabled="!isRunning" @click="cancelRun">Cancel</button>
      </header>

      <div class="conversation">
        <article v-for="(message, index) in messages" :key="index" class="bubble" :class="message.role">
          {{ message.content }}
        </article>
        <article v-if="streamingText" class="bubble assistant live">
          {{ streamingText }}
        </article>
      </div>

      <form class="composer" @submit.prevent="sendMessage">
        <input v-model="input" placeholder="Ask the agent to do something..." />
        <button type="submit" :disabled="serverStatus !== 'online' || isRunning || !input.trim()">Send</button>
      </form>
    </section>

    <aside class="trace">
      <header>
        <p>Run Trace</p>
        <strong>{{ events.length }} events</strong>
      </header>

      <section v-if="pendingApproval" class="approval">
        <p>{{ pendingApproval.reason }}</p>
        <span>{{ pendingApproval.action.tool }} · {{ pendingApproval.risk }}</span>
        <div>
          <button type="button" @click="decideApproval('approved')">Approve</button>
          <button type="button" class="secondary" @click="decideApproval('rejected')">Reject</button>
        </div>
      </section>

      <ol class="events">
        <li v-for="event in events" :key="event.id">
          <span>{{ event.type }}</span>
          <code>#{{ event.seq }}</code>
        </li>
      </ol>
    </aside>
  </main>
</template>
