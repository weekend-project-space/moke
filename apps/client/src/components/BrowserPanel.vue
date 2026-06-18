<script setup lang="ts">
import {
  ArrowLeft,
  ArrowRight,
  Eye,
  EyeOff,
  Globe2,
  Plus,
  RefreshCw,
  RotateCw,
  X,
} from 'lucide-vue-next'
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { browserApi, isNativeBrowserAvailable, type BrowserPage } from '../api/browser'

const props = defineProps<{
  active: boolean
}>()

const pages = ref<BrowserPage[]>([])
const activePageId = ref<number | null>(null)
const address = ref('')
const errorMessage = ref('')
const isBusy = ref(false)
const nativeAvailable = ref(false)
let refreshTimer = 0

const activePage = computed(() => pages.value.find((page) => page.pageId === activePageId.value) || null)
const pageTitle = computed(() => activePage.value?.title || '未打开页面')
const pageUrl = computed(() => activePage.value?.url || '')
const canUseBrowser = computed(() => nativeAvailable.value)

function normalizeInput(value: string) {
  const trimmed = value.trim()
  if (!trimmed) return 'about:blank'
  return trimmed.includes('://') ? trimmed : `https://${trimmed}`
}

function applyState(result: { pages: BrowserPage[]; activePageId: number | null }) {
  pages.value = result.pages
  activePageId.value = result.activePageId

  const page = result.pages.find((item) => item.pageId === result.activePageId)
  if (page?.url) address.value = page.url
}

async function withBusy(action: () => Promise<void>) {
  if (isBusy.value) return

  isBusy.value = true
  errorMessage.value = ''
  try {
    await action()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error)
  } finally {
    isBusy.value = false
  }
}

async function refreshState() {
  if (!nativeAvailable.value) return

  try {
    applyState(await browserApi.listPages())
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error)
  }
}

async function ensurePage(url = address.value) {
  if (!activePage.value) {
    applyState(await browserApi.createPage({
      url: normalizeInput(url),
      visible: true,
    }))
    return
  }

  await browserApi.showBrowser(activePage.value.pageId)
}

async function submitAddress() {
  await withBusy(async () => {
    const url = normalizeInput(address.value)
    if (!activePage.value) {
      await ensurePage(url)
      return
    }

    applyState(await browserApi.navigatePage({
      pageId: activePage.value.pageId,
      type: 'url',
      url,
    }))
  })
}

async function createPage() {
  await withBusy(async () => {
    applyState(await browserApi.createPage({
      url: normalizeInput(address.value),
      visible: true,
    }))
  })
}

async function selectPage(pageId: number) {
  await withBusy(async () => {
    applyState(await browserApi.selectPage(pageId))
  })
}

async function closePage(pageId: number) {
  await withBusy(async () => {
    applyState(await browserApi.closePage(pageId))
  })
}

async function reloadPage(ignoreCache = false) {
  if (!activePage.value) return

  await withBusy(async () => {
    applyState(await browserApi.navigatePage({
      pageId: activePage.value?.pageId,
      type: 'reload',
      ignoreCache,
    }))
  })
}

async function syncVisibility() {
  if (!nativeAvailable.value) return

  try {
    if (props.active) {
      if (!activePage.value) return
      applyState(await browserApi.showBrowser(activePage.value.pageId))
    }
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error)
  }
}

onMounted(async () => {
  nativeAvailable.value = isNativeBrowserAvailable()

  if (!nativeAvailable.value) return

  await withBusy(async () => {
    const state = await browserApi.listPages()
    applyState(state)
    if (props.active) await syncVisibility()
  })

  refreshTimer = window.setInterval(refreshState, 1200)
})

onUnmounted(() => {
  if (refreshTimer) window.clearInterval(refreshTimer)
})

watch(
  () => props.active,
  () => {
    void syncVisibility()
  },
  { flush: 'post' },
)
</script>

<template>
  <section class="browser-panel">
    <header class="browser-header">
      <div>
        <p>浏览器</p>
        <strong>{{ pageTitle }}</strong>
      </div>
      <button type="button" :disabled="!canUseBrowser || isBusy" aria-label="新建页面" title="新建页面" @click="createPage">
        <Plus :size="15" stroke-width="2.2" />
      </button>
    </header>

    <nav class="browser-tabs" aria-label="浏览器页面">
      <div
        v-for="page in pages"
        :key="page.pageId"
        class="browser-tab"
        :class="{ active: page.pageId === activePageId }"
      >
        <button type="button" class="browser-tab-select" @click="selectPage(page.pageId)">
          <Globe2 :size="13" stroke-width="2.2" />
          <span>{{ page.title || page.url || '新页面' }}</span>
        </button>
        <i v-if="page.isLoading" aria-hidden="true"></i>
        <button type="button" class="browser-tab-close" aria-label="关闭页面" title="关闭页面" @click="closePage(page.pageId)">
          <X :size="12" stroke-width="2.3" />
        </button>
      </div>
      <span v-if="pages.length === 0">暂无页面</span>
    </nav>

    <form class="browser-toolbar" @submit.prevent="submitAddress">
      <button type="button" :disabled="true" aria-label="后退" title="后退">
        <ArrowLeft :size="15" stroke-width="2.2" />
      </button>
      <button type="button" :disabled="true" aria-label="前进" title="前进">
        <ArrowRight :size="15" stroke-width="2.2" />
      </button>
      <button type="button" :disabled="!activePage || isBusy" aria-label="刷新" title="刷新" @click="reloadPage(false)">
        <RefreshCw :size="15" stroke-width="2.2" />
      </button>
      <label>
        <Globe2 :size="14" stroke-width="2.2" />
        <input v-model="address" type="text" spellcheck="false" placeholder="输入网址" />
      </label>
      <button type="submit" :disabled="!canUseBrowser || isBusy" aria-label="访问" title="访问">
        <RotateCw :size="15" stroke-width="2.2" />
      </button>
    </form>

    <div class="browser-meta">
      <span>{{ pageUrl || '等待打开页面' }}</span>
      <strong v-if="activePage?.isLoading">加载中</strong>
      <strong v-else-if="activePage?.visible">
        <Eye :size="12" stroke-width="2.2" />
        显示中
      </strong>
      <strong v-else>
        <EyeOff :size="12" stroke-width="2.2" />
        已隐藏
      </strong>
    </div>

    <div class="browser-window-state">
      <div v-if="!nativeAvailable" class="browser-placeholder">
        <Globe2 :size="24" stroke-width="2" />
        <strong>需要在 Tauri 桌面壳中使用</strong>
        <span>网页会在独立的原生浏览器窗口中打开。</span>
      </div>
      <div v-else-if="errorMessage" class="browser-placeholder error">
        <strong>{{ errorMessage }}</strong>
      </div>
      <div v-else-if="!activePage" class="browser-placeholder">
        <Globe2 :size="24" stroke-width="2" />
        <strong>输入网址后访问</strong>
        <span>页面会在独立窗口中打开，右侧保留控制和状态。</span>
      </div>
      <div v-else class="browser-window-card">
        <Globe2 :size="22" stroke-width="2" />
        <strong>{{ activePage.title || '浏览器窗口已打开' }}</strong>
        <span>{{ activePage.url }}</span>
        <button type="button" :disabled="isBusy" @click="syncVisibility">
          <Eye :size="14" stroke-width="2.2" />
          显示窗口
        </button>
      </div>
    </div>
  </section>
</template>
