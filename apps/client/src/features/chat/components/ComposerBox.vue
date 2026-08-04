<script setup lang="ts">
import { ArrowUp, Box, Brain, Check, ChevronDown, FolderOpen, FolderPlus, Hand, Image, Plus, ShieldAlert, ShieldCheck, Square, X } from 'lucide-vue-next'
import { nextTick, onMounted, onUnmounted, ref } from 'vue'
import { uiText } from '../../../text/uiText'
import type { ApprovalMode, ImageAttachment, ReasoningEffort } from '../model/conversation'
import ComposerSelectControl from './ComposerSelectControl.vue'

type ComposerReasoningEffort = 'default' | ReasoningEffort

const props = defineProps<{
  attachments: ImageAttachment[]
  inputValue: string
  modelName: string
  modelProvider: string
  primaryDisabled: boolean
  primaryIsStop: boolean
  reasoningEffort: ComposerReasoningEffort
  reasoningOptions: ReasoningEffort[]
  approvalMode?: ApprovalMode
  nativeWorkspacePicker?: boolean
  workspaceRoot?: string
  workspaceSuggestions?: string[]
}>()

const emit = defineEmits<{
  addAttachments: [attachments: ImageAttachment[]]
  chooseWorkspaceDirectory: []
  submit: []
  input: []
  enter: [event: KeyboardEvent]
  removeAttachment: [id: string]
  'update:reasoningEffort': [value: ComposerReasoningEffort]
  'update:approvalMode': [value: ApprovalMode]
  'update:workspaceRoot': [value: string]
  'update:inputValue': [value: string]
}>()

const addMenuOpen = ref(false)
const attachmentError = ref('')
const composerEl = ref<HTMLFormElement | null>(null)
const dragDepth = ref(0)
const fileInput = ref<HTMLInputElement | null>(null)
const textarea = ref<HTMLTextAreaElement | null>(null)
const thinkingMenuOpen = ref(false)
const approvalMenuOpen = ref(false)
const workspaceMenuOpen = ref(false)
const workspaceCustomOpen = ref(false)
const workspaceDraft = ref('')
const isDraggingImage = ref(false)
const MAX_IMAGE_ATTACHMENTS = 4
const MAX_IMAGE_FILE_BYTES = 4 * 1024 * 1024
const MAX_IMAGE_TOTAL_BYTES = 5 * 1024 * 1024
const addOptions = ['image'] as const
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

function thinkingOptions() {
  return ['default' as const, ...props.reasoningOptions]
}

function chooseReasoning(value: string) {
  emit('update:reasoningEffort', value as ComposerReasoningEffort)
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
  if (value === 'image') chooseImages()
}

function updateAddMenu(value: boolean) {
  thinkingMenuOpen.value = false
  approvalMenuOpen.value = false
  workspaceMenuOpen.value = false
  addMenuOpen.value = value
}

function updateThinkingMenu(value: boolean) {
  addMenuOpen.value = false
  approvalMenuOpen.value = false
  workspaceMenuOpen.value = false
  thinkingMenuOpen.value = value
}

function approvalModeLabel(value: ApprovalMode) {
  return value === 'manual' ? 'Manual' : value === 'ai_review' ? 'AI review' : 'Auto approve'
}

function updateApprovalMenu(value: boolean) {
  addMenuOpen.value = false
  thinkingMenuOpen.value = false
  workspaceMenuOpen.value = false
  approvalMenuOpen.value = value
}

function chooseApprovalMode(value: string) {
  emit('update:approvalMode', value as ApprovalMode)
}

function updateWorkspaceMenu(value: boolean) {
  addMenuOpen.value = false
  thinkingMenuOpen.value = false
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
  if (!addMenuOpen.value && !thinkingMenuOpen.value && !approvalMenuOpen.value && !workspaceMenuOpen.value) return
  const target = event.target
  if (target instanceof Node && composerEl.value?.contains(target)) return
  addMenuOpen.value = false
  thinkingMenuOpen.value = false
  approvalMenuOpen.value = false
  workspaceMenuOpen.value = false
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
  thinkingMenuOpen.value = false
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

defineExpose({ focus, openWorkspaceEditor, resize })
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
              id="composer-workspace-input"
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
        <div class="composer-textarea-area">
          <textarea
            ref="textarea"
            :value="props.inputValue"
            rows="1"
            :placeholder="uiText.composer.placeholder"
            @input="handleInput"
            @keydown.enter="$emit('enter', $event)"
            @paste="handlePaste"
          ></textarea>
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
              <Image :size="15" stroke-width="2.1" />
            </template>
            <template #option-label>{{ uiText.composer.chooseImage }}</template>
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
          <div v-if="props.modelName || props.reasoningOptions.length" class="composer-model-context">
            <div
              v-if="props.modelName"
              class="composer-model"
              :title="uiText.composer.currentModel(props.modelName, props.modelProvider)"
            >
              <Box :size="14" stroke-width="1.9" />
              <span>{{ props.modelName }}</span>
            </div>
            <ComposerSelectControl
              v-if="props.reasoningOptions.length"
              align="end"
              :open="thinkingMenuOpen"
              :options="thinkingOptions()"
              :selected="props.reasoningEffort"
              menu-class="composer-thinking-menu"
              @select="chooseReasoning"
              @update:open="updateThinkingMenu"
            >
              <template #option-icon>
                <Brain :size="14" stroke-width="2.1" />
              </template>
              <template #option-selected>
                <Check :size="14" stroke-width="2.2" />
              </template>
              <template #option-label="{ option }">{{ reasoningLabel(option as ComposerReasoningEffort) }}</template>
              <template #trigger="{ open, toggle }">
                <button
                  class="composer-thinking-action"
                  type="button"
                  :aria-label="uiText.composer.thinking"
                  :title="uiText.composer.thinking"
                  :class="{ active: open }"
                  @click="toggle"
                >
                  <Brain :size="14" stroke-width="2.1" />
                  <span>{{ reasoningLabel(props.reasoningEffort) }}</span>
                  <ChevronDown :size="13" stroke-width="2.2" />
                </button>
              </template>
            </ComposerSelectControl>
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
