<script setup lang="ts">
import { ArrowUp, Box, Brain, Check, ChevronDown, Cpu, FileText, FolderOpen, FolderPlus, Hand, Paperclip, Plus, ShieldAlert, ShieldCheck, Square, X } from 'lucide-vue-next'
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import type { ModelSummary, SkillSummary, WorkspaceEntry } from '@moke/agent-sdk'
import { uiText } from '../../../text/uiText'
import type { ApprovalMode, FileAttachmentInput, ImageAttachment, ReasoningEffort } from '../model/conversation'
import ComposerSelectControl from './ComposerSelectControl.vue'

type ComposerReasoningEffort = 'default' | ReasoningEffort
type ComposerModel = ModelSummary & { provider: string; providerName?: string }

const props = defineProps<{
  attachments: ImageAttachment[]
  files: FileAttachmentInput[]
  inputValue: string
  modelName: string
  modelProvider: string
  modelProviderId?: string
  primaryDisabled: boolean
  primaryIsStop: boolean
  reasoningEffort: ComposerReasoningEffort
  reasoningOptions: ReasoningEffort[]
  approvalMode?: ApprovalMode
  nativeWorkspacePicker?: boolean
  workspaceRoot?: string
  workspaceSuggestions?: string[]
  workspaceEntries?: WorkspaceEntry[]
  skills?: SkillSummary[]
  modelOptions?: ComposerModel[]
}>()

const emit = defineEmits<{
  addAttachments: [attachments: ImageAttachment[]]
  chooseFiles: []
  chooseWorkspaceDirectory: []
  submit: []
  input: []
  enter: [event: KeyboardEvent]
  removeAttachment: [id: string]
  removeFile: [path: string]
  'update:reasoningEffort': [value: ComposerReasoningEffort]
  'update:approvalMode': [value: ApprovalMode]
  'update:workspaceRoot': [value: string]
  'update:inputValue': [value: string]
  chooseWorkspaceEntry: [entry: WorkspaceEntry]
  selectModel: [model: ComposerModel]
}>()

const addMenuOpen = ref(false)
const attachmentError = ref('')
const composerEl = ref<HTMLFormElement | null>(null)
const discoveryMenu = ref<HTMLElement | null>(null)
const dragDepth = ref(0)
const fileInput = ref<HTMLInputElement | null>(null)
const textarea = ref<HTMLTextAreaElement | null>(null)
const modelMenuOpen = ref(false)
const approvalMenuOpen = ref(false)
const workspaceMenuOpen = ref(false)
const workspaceCustomOpen = ref(false)
const workspaceDraft = ref('')
const isDraggingImage = ref(false)
const discoverySelectedIndex = ref(0)
const dismissedDiscoveryKey = ref('')
const activeDiscovery = computed(() => {
  const match = props.inputValue.match(/(?:^|\s)([@/])([^\s]*)$/)
  if (!match) return null
  return { trigger: match[1], query: match[2] }
})

const discoveryKey = computed(() => {
  const discovery = activeDiscovery.value
  return discovery ? `${discovery.trigger}:${discovery.query}` : ''
})

const discoveryItems = computed(() => {
  if (dismissedDiscoveryKey.value === discoveryKey.value) return []
  if (activeDiscovery.value?.trigger === '@') {
    return (props.workspaceEntries || []).map((entry) => ({
      key: entry.path,
      name: entry.name,
      detail: entry.path,
      kind: 'file' as const,
      entry,
    }))
  }
  if (activeDiscovery.value?.trigger === '/') {
    return (props.skills || []).map((skill) => ({
      key: skill.name,
      name: skill.name,
      detail: skill.description,
      kind: 'skill' as const,
      skill,
    }))
  }
  return []
})
const modelsByKey = computed(() => new Map(
  (props.modelOptions || []).map((model) => [modelKey(model), model]),
))

watch(() => props.inputValue, () => {
  if (dismissedDiscoveryKey.value && dismissedDiscoveryKey.value !== discoveryKey.value) {
    dismissedDiscoveryKey.value = ''
  }
  discoverySelectedIndex.value = 0
})

watch(() => discoveryItems.value.length, (length) => {
  discoverySelectedIndex.value = length ? Math.min(discoverySelectedIndex.value, length - 1) : 0
})

const selectedModelKey = computed(() => {
  const key = `${props.modelProviderId || props.modelProvider}\u0000${props.modelName}`
  return modelsByKey.value.has(key) ? key : undefined
})

function chooseDiscoveryItem(item: (typeof discoveryItems.value)[number]) {
  const discovery = activeDiscovery.value
  if (!discovery) return
  if (discovery.trigger === '@' && item.kind === 'file') {
    emit('chooseWorkspaceEntry', item.entry)
    emit('update:inputValue', props.inputValue.replace(/(?:^|\s)@[^\s]*$/, ' ').trimStart())
  } else if (discovery.trigger === '/' && item.kind === 'skill') {
    emit('update:inputValue', props.inputValue.replace(/(?:^|\s)\/[^\s]*$/, ` /${item.skill.name} `).trimStart())
  }
}

function scrollSelectedDiscoveryItemIntoView() {
  void nextTick(() => {
    discoveryMenu.value
      ?.querySelector<HTMLElement>('[aria-selected="true"]')
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  })
}

function handleTextareaKeydown(event: KeyboardEvent) {
  if (discoveryItems.value.length) {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      discoverySelectedIndex.value = (discoverySelectedIndex.value + 1) % discoveryItems.value.length
      scrollSelectedDiscoveryItemIntoView()
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      discoverySelectedIndex.value = (discoverySelectedIndex.value - 1 + discoveryItems.value.length) % discoveryItems.value.length
      scrollSelectedDiscoveryItemIntoView()
      return
    }
    if (event.key === 'Enter' && !event.isComposing) {
      event.preventDefault()
      const item = discoveryItems.value[discoverySelectedIndex.value]
      if (item) chooseDiscoveryItem(item)
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      dismissedDiscoveryKey.value = discoveryKey.value
      return
    }
  }

  if (event.key === 'Enter') emit('enter', event)
}
const MAX_IMAGE_ATTACHMENTS = 4
const MAX_IMAGE_FILE_BYTES = 4 * 1024 * 1024
const MAX_IMAGE_TOTAL_BYTES = 5 * 1024 * 1024
const addOptions = ['attachment']
const approvalOptions: ApprovalMode[] = ['manual', 'ai_review', 'auto_approve']

function resize() {
  const input = textarea.value
  if (!input) return

  input.style.height = 'auto'
  input.style.height = `${Math.min(input.scrollHeight, 136)}px`
}

function focus() {
  textarea.value?.focus()
}

function focusFromPanelClick(event: MouseEvent) {
  const target = event.target
  if (!(target instanceof Element)) return
  if (target instanceof HTMLTextAreaElement) return
  const button = target.closest('button')
  if (button instanceof HTMLButtonElement && !button.disabled) return
  textarea.value?.focus()
}

function handleInput(event: Event) {
  emit('update:inputValue', (event.target as HTMLTextAreaElement).value)
  void nextTick(() => {
    resize()
    emit('input')
  })
}

function reasoningLabel(value: ComposerReasoningEffort) {
  return value === 'default' ? uiText.composer.thinkingAuto : uiText.composer.thinkingOption(value)
}

function chooseReasoning(value: string) {
  emit('update:reasoningEffort', value as ComposerReasoningEffort)
}

function toggleAutoReasoning() {
  if (props.reasoningEffort !== 'default') {
    chooseReasoning('default')
    return
  }
  const manualEffort = props.reasoningOptions.includes('medium') ? 'medium' : props.reasoningOptions[0]
  if (manualEffort) chooseReasoning(manualEffort)
}

function imageId() {
  return `img_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

function readImageFile(file: File) {
  return new Promise<ImageAttachment>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result !== 'string') {
        reject(new Error('Failed to read image'))
        return
      }

      resolve({
        id: imageId(),
        kind: 'image',
        name: file.name,
        mime_type: file.type,
        data_url: reader.result,
      })
    }
    reader.onerror = () => reject(reader.error || new Error('Failed to read image'))
    reader.readAsDataURL(file)
  })
}

async function addImageFiles(files: File[]) {
  const imageFiles = files.filter((file) => file.type.startsWith('image/'))
  if (!imageFiles.length) return

  attachmentError.value = ''
  const availableSlots = Math.max(0, MAX_IMAGE_ATTACHMENTS - props.attachments.length)
  if (availableSlots === 0) {
    attachmentError.value = uiText.composer.imageLimitReached
    return
  }

  let totalBytes = props.attachments.reduce((total, attachment) => total + approximateDataUrlBytes(attachment.data_url), 0)
  const acceptedFiles: File[] = []
  let rejectedForSize = false
  let rejectedForCount = false

  for (const file of imageFiles) {
    if (acceptedFiles.length >= availableSlots) {
      rejectedForCount = true
      continue
    }
    if (file.size > MAX_IMAGE_FILE_BYTES || totalBytes + file.size > MAX_IMAGE_TOTAL_BYTES) {
      rejectedForSize = true
      continue
    }

    totalBytes += file.size
    acceptedFiles.push(file)
  }

  const results = await Promise.allSettled(acceptedFiles.map(readImageFile))
  const attachments = results.flatMap((result) => result.status === 'fulfilled' ? [result.value] : [])
  if (attachments.length) emit('addAttachments', attachments)

  if (results.some((result) => result.status === 'rejected')) {
    attachmentError.value = uiText.composer.imageReadFailed
  } else if (rejectedForSize) {
    attachmentError.value = uiText.composer.imageTooLarge
  } else if (rejectedForCount) {
    attachmentError.value = uiText.composer.imageLimitReached
  }
}

function addLocalImages(images: ImageAttachment[], readFailed = false) {
  attachmentError.value = ''
  const availableSlots = Math.max(0, MAX_IMAGE_ATTACHMENTS - props.attachments.length)
  let totalBytes = props.attachments.reduce((total, attachment) => total + approximateDataUrlBytes(attachment.data_url), 0)
  let rejectedForSize = false
  const accepted = images.slice(0, availableSlots).filter((image) => {
    const size = approximateDataUrlBytes(image.data_url)
    if (size > MAX_IMAGE_FILE_BYTES || totalBytes + size > MAX_IMAGE_TOTAL_BYTES) {
      rejectedForSize = true
      return false
    }
    totalBytes += size
    return true
  })

  if (accepted.length) emit('addAttachments', accepted)
  if (readFailed) attachmentError.value = uiText.composer.imageReadFailed
  else if (rejectedForSize) attachmentError.value = uiText.composer.imageTooLarge
  else if (images.length > availableSlots) attachmentError.value = uiText.composer.imageLimitReached
}

function approximateDataUrlBytes(dataUrl: string) {
  const commaIndex = dataUrl.indexOf(',')
  const base64Length = commaIndex >= 0 ? dataUrl.length - commaIndex - 1 : dataUrl.length
  return Math.floor(base64Length * 0.75)
}

function imageFilesFromDataTransfer(dataTransfer: DataTransfer | null) {
  return Array.from(dataTransfer?.files || []).filter((file) => file.type.startsWith('image/'))
}

function hasFileDataTransfer(dataTransfer: DataTransfer | null) {
  if (!dataTransfer) return false
  if (Array.from(dataTransfer.items).some((item) => item.kind === 'file')) return true
  if (Array.from(dataTransfer.types).some((type) => type.toLowerCase() === 'files')) return true
  return dataTransfer.files.length > 0
}

function chooseImages() {
  addMenuOpen.value = false
  fileInput.value?.click()
}

function chooseAddAction(value: string) {
  if (value !== 'attachment') return
  if (!props.nativeWorkspacePicker) return chooseImages()
  addMenuOpen.value = false
  emit('chooseFiles')
}

function updateAddMenu(value: boolean) {
  approvalMenuOpen.value = false
  workspaceMenuOpen.value = false
  modelMenuOpen.value = false
  addMenuOpen.value = value
}

function updateModelMenu(value: boolean) {
  addMenuOpen.value = false
  approvalMenuOpen.value = false
  workspaceMenuOpen.value = false
  modelMenuOpen.value = value
}

function modelKey(model: ComposerModel) {
  return `${model.provider}\u0000${model.name}`
}

function modelFromKey(value: string) {
  return modelsByKey.value.get(value)
}

function approvalModeLabel(value: ApprovalMode) {
  return value === 'manual' ? 'Manual' : value === 'ai_review' ? 'AI review' : 'Auto approve'
}

function updateApprovalMenu(value: boolean) {
  addMenuOpen.value = false
  workspaceMenuOpen.value = false
  modelMenuOpen.value = false
  approvalMenuOpen.value = value
}

function chooseApprovalMode(value: string) {
  emit('update:approvalMode', value as ApprovalMode)
}

function updateWorkspaceMenu(value: boolean) {
  addMenuOpen.value = false
  approvalMenuOpen.value = false
  workspaceMenuOpen.value = value
  workspaceCustomOpen.value = false
}

function workspaceOptions() {
  return [...new Set([props.workspaceRoot, ...(props.workspaceSuggestions || [])].filter((root): root is string => Boolean(root)))].slice(0, 5)
}

function workspaceName(root: string) {
  const normalized = root.replace(/[\\/]+$/, '')
  return normalized.split(/[\\/]/).at(-1) || root
}

function chooseWorkspace(root: string) {
  emit('update:workspaceRoot', root)
}

function beginCustomWorkspace() {
  if (props.nativeWorkspacePicker) {
    workspaceMenuOpen.value = false
    emit('chooseWorkspaceDirectory')
    return
  }
  openWorkspaceEditor()
}

function openWorkspaceEditor() {
  workspaceDraft.value = props.workspaceRoot || ''
  workspaceMenuOpen.value = true
  workspaceCustomOpen.value = true
}

function applyWorkspace() {
  const value = workspaceDraft.value.trim()
  if (!value) return
  emit('update:workspaceRoot', value)
  workspaceMenuOpen.value = false
  workspaceCustomOpen.value = false
}

function closeAddMenuOnOutsideClick(event: PointerEvent) {
  if (!addMenuOpen.value && !approvalMenuOpen.value && !workspaceMenuOpen.value && !modelMenuOpen.value) return
  const target = event.target
  if (target instanceof Node && composerEl.value?.contains(target)) return
  addMenuOpen.value = false
  approvalMenuOpen.value = false
  workspaceMenuOpen.value = false
  modelMenuOpen.value = false
}

onMounted(() => {
  document.addEventListener('pointerdown', closeAddMenuOnOutsideClick)
})

onUnmounted(() => {
  document.removeEventListener('pointerdown', closeAddMenuOnOutsideClick)
})

function handleFileChange(event: Event) {
  const input = event.target as HTMLInputElement
  void addImageFiles(Array.from(input.files || []))
  input.value = ''
}

function handlePaste(event: ClipboardEvent) {
  const files = imageFilesFromDataTransfer(event.clipboardData)
  if (!files.length) return

  event.preventDefault()
  void addImageFiles(files)
}

function handleDragEnter(event: DragEvent) {
  if (!hasFileDataTransfer(event.dataTransfer)) return

  event.preventDefault()
  dragDepth.value += 1
  isDraggingImage.value = true
  addMenuOpen.value = false
  approvalMenuOpen.value = false
  workspaceMenuOpen.value = false
}

function handleDragOver(event: DragEvent) {
  if (!hasFileDataTransfer(event.dataTransfer)) return
  event.preventDefault()
  if (!isDraggingImage.value) {
    dragDepth.value = Math.max(1, dragDepth.value)
    isDraggingImage.value = true
  }
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
}

function handleDragLeave(event: DragEvent) {
  if (!isDraggingImage.value) return
  event.preventDefault()
  dragDepth.value = Math.max(0, dragDepth.value - 1)
  if (dragDepth.value === 0) isDraggingImage.value = false
}

function handleDrop(event: DragEvent) {
  if (!hasFileDataTransfer(event.dataTransfer)) return

  event.preventDefault()
  const files = imageFilesFromDataTransfer(event.dataTransfer)
  dragDepth.value = 0
  isDraggingImage.value = false
  if (!files.length) return
  void addImageFiles(files)
}

defineExpose({ addLocalImages, focus, openWorkspaceEditor, resize })
</script>

<template>
  <form ref="composerEl" class="composer" @submit.prevent="$emit('submit')">
    <div v-if="props.workspaceRoot !== undefined" class="composer-workspace-context">
      <ComposerSelectControl
        :open="workspaceMenuOpen"
        :options="workspaceOptions()"
        :selected="props.workspaceRoot || ''"
        menu-class="composer-workspace-menu"
        @select="chooseWorkspace"
        @update:open="updateWorkspaceMenu"
      >
        <template #menu-header>{{ uiText.composer.recentWorkspaces }}</template>
        <template #option-icon>
          <FolderOpen :size="15" stroke-width="2.1" />
        </template>
        <template #option-label="{ option }">
          <span class="composer-workspace-option-copy">
            <strong>{{ workspaceName(option) }}</strong>
          </span>
        </template>
        <template #option-selected>
          <Check :size="14" stroke-width="2.3" />
        </template>
        <template #menu-footer>
          <div v-if="workspaceCustomOpen" class="composer-workspace-editor">
            <input
              v-model="workspaceDraft"
              :aria-label="uiText.composer.workspace"
              type="text"
              @keydown.enter.prevent="applyWorkspace"
            />
            <button type="button" @click="applyWorkspace">{{ uiText.composer.applyWorkspace }}</button>
          </div>
          <button v-else class="composer-workspace-other" type="button" @click="beginCustomWorkspace">
            <FolderPlus :size="15" stroke-width="2.1" />
            <span>{{ uiText.composer.chooseOtherWorkspace }}</span>
          </button>
        </template>
        <template #trigger="{ open, toggle }">
          <button
            class="composer-workspace-context-trigger"
            type="button"
            :aria-label="uiText.composer.workspaceLabel(props.workspaceRoot || '')"
            :title="props.workspaceRoot || uiText.composer.workspace"
            :class="{ active: open }"
            @click="toggle"
          >
            <FolderOpen :size="15" stroke-width="1.9" />
            <span>{{ props.workspaceRoot ? workspaceName(props.workspaceRoot) : uiText.composer.chooseProject }}</span>
            <ChevronDown :size="13" stroke-width="2.2" />
          </button>
        </template>
      </ComposerSelectControl>
    </div>
    <div
      class="composer-panel input-mode"
      :class="{ dragging: isDraggingImage }"
      @click="focusFromPanelClick"
      @dragenter="handleDragEnter"
      @dragover="handleDragOver"
      @dragleave="handleDragLeave"
      @drop="handleDrop"
    >
      <div class="composer-input-row">
        <div v-if="props.attachments.length" class="composer-attachments">
          <div v-for="attachment in props.attachments" :key="attachment.id" class="composer-attachment">
            <img :src="attachment.data_url" :alt="attachment.name || uiText.composer.imageAttachment" />
            <button
              type="button"
              :aria-label="uiText.composer.removeImage"
              :title="uiText.composer.removeImage"
              @click="emit('removeAttachment', attachment.id)"
            >
              <X :size="12" stroke-width="2.4" />
            </button>
          </div>
        </div>
        <div v-if="props.files.length" class="composer-files">
          <div v-for="file in props.files" :key="file.path" class="composer-file" :title="file.path">
            <FileText :size="15" stroke-width="1.9" />
            <span>{{ file.name }}</span>
            <button
              type="button"
              :aria-label="uiText.composer.removeFile(file.name)"
              :title="uiText.composer.removeFile(file.name)"
              @click="emit('removeFile', file.path)"
            >
              <X :size="12" stroke-width="2.4" />
            </button>
          </div>
        </div>
        <div class="composer-textarea-area">
          <textarea
            ref="textarea"
            :value="props.inputValue"
            rows="1"
            :placeholder="uiText.composer.placeholder"
            @input="handleInput"
            @keydown="handleTextareaKeydown"
            @paste="handlePaste"
          ></textarea>
          <div v-if="discoveryItems.length" ref="discoveryMenu" class="composer-discovery-menu" role="listbox">
            <button
              v-for="(item, index) in discoveryItems"
              :key="item.key"
              type="button"
              class="composer-discovery-item"
              :aria-selected="index === discoverySelectedIndex"
              :class="{ selected: index === discoverySelectedIndex }"
              @mouseenter="discoverySelectedIndex = index"
              @click="chooseDiscoveryItem(item)"
            >
              <FileText v-if="item.kind === 'file'" :size="14" stroke-width="2" />
              <Box v-else :size="14" stroke-width="2" />
              <span>{{ item.name }}</span>
              <small>{{ item.detail }}</small>
            </button>
          </div>
        </div>
        <div class="composer-footer">
          <div class="composer-footer-left">
          <ComposerSelectControl
            :open="addMenuOpen"
            :options="addOptions"
            menu-class="composer-add-menu"
            @select="chooseAddAction"
            @update:open="updateAddMenu"
          >
            <template #option-icon>
              <Paperclip :size="15" stroke-width="2.1" />
            </template>
            <template #option-label>{{ uiText.composer.addFilesOrImages }}</template>
            <template #trigger="{ open, toggle }">
              <button
                class="composer-secondary-action"
                type="button"
                :aria-label="uiText.composer.add"
                :title="uiText.composer.add"
                :aria-expanded="open"
                :class="{ active: open }"
                @click="toggle"
              >
                <Plus :size="17" stroke-width="2.2" />
              </button>
            </template>
          </ComposerSelectControl>
          <ComposerSelectControl
            v-if="props.approvalMode"
            :open="approvalMenuOpen"
            :options="approvalOptions"
            :selected="props.approvalMode"
            menu-class="composer-approval-menu"
            @select="chooseApprovalMode"
            @update:open="updateApprovalMenu"
          >
            <template #option-icon="{ option }">
              <Hand v-if="option === 'manual'" :size="15" stroke-width="2.1" />
              <ShieldCheck v-else-if="option === 'ai_review'" :size="15" stroke-width="2.1" />
              <ShieldAlert v-else :size="15" stroke-width="2.1" />
            </template>
            <template #option-selected>
              <Check :size="14" stroke-width="2.3" />
            </template>
            <template #option-label="{ option }">{{ approvalModeLabel(option as ApprovalMode) }}</template>
            <template #trigger="{ open, toggle }">
              <button
                class="composer-approval-action"
                type="button"
                aria-label="Approval mode"
                title="Approval mode"
                :class="{ active: open }"
                @click="toggle"
              >
                <Hand v-if="props.approvalMode === 'manual'" :size="14" stroke-width="2.1" />
                <ShieldCheck v-else-if="props.approvalMode === 'ai_review'" :size="14" stroke-width="2.1" />
                <ShieldAlert v-else :size="14" stroke-width="2.1" />
              </button>
            </template>
          </ComposerSelectControl>
          </div>
          <div class="composer-footer-right">
          <div v-if="props.modelName || props.reasoningOptions.length || props.modelOptions?.length" class="composer-model-context">
            <ComposerSelectControl
              v-if="props.modelOptions?.length"
              :open="modelMenuOpen"
              :options="props.modelOptions.map(modelKey)"
              :selected="selectedModelKey"
              align="end"
              menu-class="composer-model-menu"
              @select="(value) => { const model = modelFromKey(value); if (model) emit('selectModel', model) }"
              @update:open="updateModelMenu"
            >
              <template #menu-header>Model</template>
              <template #option-icon><Cpu :size="15" stroke-width="1.8" /></template>
              <template #option-label="{ option }">
                <span class="composer-model-option-copy">
                  <strong>{{ modelFromKey(option)?.name || option }}</strong>
                  <small>{{ modelFromKey(option)?.providerName || modelFromKey(option)?.provider }}</small>
                </span>
              </template>
              <template #option-selected><Check :size="14" stroke-width="2.2" /></template>
              <template v-if="props.reasoningOptions.length" #menu-footer>
                <div class="composer-thinking-section" role="group" :aria-label="uiText.composer.thinking">
                  <div class="composer-thinking-section-label">
                    <Brain :size="13" stroke-width="2" />
                    <span>{{ uiText.composer.thinking }}</span>
                  </div>
                  <div class="composer-thinking-auto-row">
                    <span>{{ reasoningLabel('default') }}</span>
                    <button
                      type="button"
                      class="composer-thinking-auto-switch"
                      :class="{ active: props.reasoningEffort === 'default' }"
                      role="switch"
                      :aria-checked="props.reasoningEffort === 'default'"
                      :aria-label="reasoningLabel('default')"
                      @click="toggleAutoReasoning"
                    >
                      <span class="composer-thinking-auto-thumb"></span>
                    </button>
                  </div>
                  <div class="composer-thinking-manual-label">Manual</div>
                  <div class="composer-thinking-options" role="group" aria-label="Manual thinking effort">
                    <button
                      v-for="option in props.reasoningOptions"
                      :key="option"
                      type="button"
                      class="composer-thinking-option"
                      :class="{ active: option === props.reasoningEffort }"
                      :aria-pressed="option === props.reasoningEffort"
                      @click="chooseReasoning(option)"
                    >
                      {{ reasoningLabel(option) }}
                    </button>
                  </div>
                </div>
              </template>
              <template #trigger="{ open, toggle }">
                <button
                  class="composer-model-action"
                  type="button"
                  :aria-label="uiText.composer.currentModel(props.modelName, props.modelProvider)"
                  :title="uiText.composer.currentModel(props.modelName, props.modelProvider)"
                  :class="{ active: open }"
                  @click="toggle"
                >
                  <Cpu :size="14" stroke-width="1.8" />
                  <span class="composer-model-name">{{ props.modelName || 'Select model' }}</span>
                  <span v-if="props.reasoningOptions.length" class="composer-model-effort">
                    {{ reasoningLabel(props.reasoningEffort) }}
                  </span>
                  <ChevronDown :size="12" stroke-width="2.1" />
                </button>
              </template>
            </ComposerSelectControl>
            <div
              v-else-if="props.modelName"
              class="composer-model"
              :title="uiText.composer.currentModel(props.modelName, props.modelProvider)"
            >
              <Cpu :size="14" stroke-width="1.8" />
              <span>{{ props.modelName }}</span>
            </div>
          </div>
          <input
            ref="fileInput"
            class="composer-file-input"
            type="file"
            accept="image/*"
            multiple
            @change="handleFileChange"
          />
          <button
            class="primary-action"
            type="submit"
            :class="{ stop: primaryIsStop }"
            :disabled="primaryDisabled"
            :aria-label="primaryIsStop ? uiText.composer.stop : uiText.composer.send"
            :title="primaryIsStop ? uiText.composer.stop : uiText.composer.send"
          >
            <Square v-if="primaryIsStop" :size="15" fill="currentColor" stroke-width="2.2" />
            <ArrowUp v-else :size="17" stroke-width="2.4" />
          </button>
          </div>
        </div>
      </div>
      <p v-if="attachmentError" class="composer-attachment-error" role="status">{{ attachmentError }}</p>
    </div>
  </form>
</template>
