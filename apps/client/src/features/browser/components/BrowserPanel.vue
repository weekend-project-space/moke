<script setup lang="ts">
import { ArrowLeft, ArrowRight, Globe2, Plus, RefreshCw, X } from 'lucide-vue-next'
import { ref, toRef } from 'vue'
import { useBrowserController } from '../composables/useBrowserController'
import type { BrowserLinkOpenMode } from '../model/preferences'
import { uiText } from '../../../text/uiText'

const props = defineProps<{ active: boolean }>()
const windowElement = ref<HTMLElement | null>(null)
const viewportElement = ref<HTMLElement | null>(null)
const {
  tabs, activeTabKey, activeTab, address, errorMessage, nativeAvailable,
  canCreateTab, canGoBack, canGoForward, canReload, tabKey,
  beginAddressEdit, endAddressEdit, submitAddress, createTab, openUrl,
  selectTab, closeTab, reloadPage, navigateHistory, getViewportBounds,
} = useBrowserController({
  active: toRef(props, 'active'),
  windowElement,
  viewportElement,
})

defineExpose({
  getBounds: getViewportBounds,
  openUrl: (url: string, mode?: BrowserLinkOpenMode) => openUrl(url, mode),
})
</script>

<template>
  <section class="browser-panel">
    <div class="browser-controls">
      <nav class="browser-tabs" :aria-label="uiText.browser.pages">
        <div v-for="tab in tabs" :key="tabKey(tab)" class="browser-tab" :class="{ active: tabKey(tab) === activeTabKey }">
          <button type="button" class="browser-tab-select" @click="selectTab(tab)">
            <Globe2 :size="13" stroke-width="2.2" />
            <span>{{ tab.title || (tab.url === 'about:blank' ? uiText.browser.newPage : tab.url) || uiText.browser.newPage }}</span>
          </button>
          <i v-if="tab.isLoading" aria-hidden="true"></i>
          <button type="button" class="browser-tab-close" :aria-label="uiText.browser.closePage" :title="uiText.browser.closePage" @click="closeTab(tab)">
            <X :size="12" stroke-width="2.3" />
          </button>
        </div>
        <button type="button" class="browser-tab-add" :disabled="!canCreateTab" :aria-label="uiText.browser.newPage" :title="uiText.browser.newPage" @click="createTab">
          <Plus :size="14" stroke-width="2.2" />
        </button>
      </nav>

      <form class="browser-toolbar" @submit.prevent="submitAddress">
        <button type="button" :disabled="!canGoBack" :aria-label="uiText.browser.back" :title="uiText.browser.back" @click="navigateHistory('back')"><ArrowLeft :size="15" stroke-width="2.2" /></button>
        <button type="button" :disabled="!canGoForward" :aria-label="uiText.browser.forward" :title="uiText.browser.forward" @click="navigateHistory('forward')"><ArrowRight :size="15" stroke-width="2.2" /></button>
        <button type="button" :disabled="!canReload" :aria-label="uiText.browser.reload" :title="uiText.browser.reload" @click="reloadPage(false)"><RefreshCw :size="15" stroke-width="2.2" /></button>
        <label>
          <Globe2 :size="14" stroke-width="2.2" />
          <input v-model="address" type="text" spellcheck="false" :placeholder="uiText.browser.addressPlaceholder" @focus="beginAddressEdit" @blur="endAddressEdit" />
        </label>
      </form>
    </div>

    <div ref="windowElement" class="browser-window-state">
      <div v-if="!nativeAvailable" class="browser-placeholder">
        <Globe2 :size="24" stroke-width="2" />
        <strong>{{ uiText.browser.requiresDesktopTitle }}</strong>
        <span>{{ uiText.browser.requiresDesktopDescription }}</span>
      </div>
      <div v-else-if="errorMessage" class="browser-placeholder error"><strong>{{ errorMessage }}</strong></div>
      <div v-else-if="!activeTab" class="browser-placeholder">
        <Globe2 :size="24" stroke-width="2" />
        <strong>{{ uiText.browser.openPromptTitle }}</strong>
        <span>{{ uiText.browser.openPromptDescription }}</span>
      </div>
      <div v-else ref="viewportElement" class="browser-viewport">
        <div v-if="activeTab.isLoading" class="browser-loading">
          <Globe2 :size="18" stroke-width="2" />
          <span>{{ uiText.browser.loading }}</span>
        </div>
      </div>
    </div>
  </section>
</template>
