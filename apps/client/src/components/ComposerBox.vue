<script setup lang="ts">
import { ArrowUp, Brain, Check, ChevronDown, Image, Plus, Square, X } from 'lucide-vue-next'
import { nextTick, onMounted, onUnmounted, ref } from 'vue'
import { uiText } from '../text/uiText'
import type { ImageAttachment, ReasoningEffort } from '../types/conversation'

type ComposerReasoningEffort = 'default' | ReasoningEffort

const props = defineProps<{
  attachments: ImageAttachment[]
  inputValue: string
  primaryDisabled: boolean
  primaryIsStop: boolean
  reasoningEffort: ComposerReasoningEffort
  reasoningOptions: ReasoningEffort[]
}>()

const emit = defineEmits<{
  addAttachments: [attachments: ImageAttachment[]]
  submit: []
  input: []
  enter: [event: KeyboardEvent]
  removeAttachment: [id: string]
  'update:reasoningEffort': [value: ComposerReasoningEffort]
  'update:inputValue': [value: string]
}>()

const addMenuOpen = ref(false)
const attachmentError = ref('')
const composerEl = ref<HTMLFormElement | null>(null)
const dragDepth = ref(0)
const fileInput = ref<HTMLInputElement | null>(null)
const textarea = ref<HTMLTextAreaElement | null>(null)
const thinkingMenuOpen = ref(false)
const isDraggingImage = ref(false)
const MAX_IMAGE_ATTACHMENTS = 4
const MAX_IMAGE_FILE_BYTES = 4 * 1024 * 1024
const MAX_IMAGE_TOTAL_BYTES = 5 * 1024 * 1024

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

function chooseReasoning(value: ComposerReasoningEffort) {
  thinkingMenuOpen.value = false
  emit('update:reasoningEffort', value)
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

function chooseImages() {
  addMenuOpen.value = false
  fileInput.value?.click()
}

function toggleAddMenu() {
  thinkingMenuOpen.value = false
  addMenuOpen.value = !addMenuOpen.value
}

function toggleThinkingMenu() {
  addMenuOpen.value = false
  thinkingMenuOpen.value = !thinkingMenuOpen.value
}

function closeAddMenuOnOutsideClick(event: PointerEvent) {
  if (!addMenuOpen.value && !thinkingMenuOpen.value) return
  const target = event.target
  if (target instanceof Node && composerEl.value?.contains(target)) return
  addMenuOpen.value = false
  thinkingMenuOpen.value = false
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
  const files = imageFilesFromDataTransfer(event.dataTransfer)
  if (!files.length) return

  event.preventDefault()
  dragDepth.value += 1
  isDraggingImage.value = true
  addMenuOpen.value = false
  thinkingMenuOpen.value = false
}

function handleDragOver(event: DragEvent) {
  if (!isDraggingImage.value) return
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
}

function handleDragLeave(event: DragEvent) {
  if (!isDraggingImage.value) return
  event.preventDefault()
  dragDepth.value = Math.max(0, dragDepth.value - 1)
  if (dragDepth.value === 0) isDraggingImage.value = false
}

function handleDrop(event: DragEvent) {
  const files = imageFilesFromDataTransfer(event.dataTransfer)
  if (!files.length) return

  event.preventDefault()
  dragDepth.value = 0
  isDraggingImage.value = false
  void addImageFiles(files)
}

defineExpose({ focus, resize })
</script>

<template>
  <form ref="composerEl" class="composer" @submit.prevent="$emit('submit')">
    <div v-if="addMenuOpen" class="composer-option-list">
      <button type="button" @click="chooseImages">
        <Image :size="15" stroke-width="2.1" />
        <span>{{ uiText.composer.chooseImage }}</span>
      </button>
    </div>
    <div v-if="thinkingMenuOpen" class="composer-option-list composer-thinking-menu">
      <button
        v-for="option in thinkingOptions()"
        :key="option"
        type="button"
        :class="{ active: option === props.reasoningEffort }"
        @click="chooseReasoning(option)"
      >
        <Check v-if="option === props.reasoningEffort" :size="14" stroke-width="2.2" />
        <Brain v-else :size="14" stroke-width="2.1" />
        <span>{{ reasoningLabel(option) }}</span>
      </button>
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
          <button
            class="composer-secondary-action"
            type="button"
            :aria-label="uiText.composer.add"
            :title="uiText.composer.add"
            :class="{ active: addMenuOpen }"
            @click="toggleAddMenu"
          >
            <Plus :size="17" stroke-width="2.2" />
          </button>
          <button
            v-if="props.reasoningOptions.length"
            class="composer-thinking-action"
            type="button"
            :aria-label="uiText.composer.thinking"
            :title="uiText.composer.thinking"
            :class="{ active: thinkingMenuOpen }"
            @click="toggleThinkingMenu"
          >
            <Brain :size="14" stroke-width="2.1" />
            <span>{{ reasoningLabel(props.reasoningEffort) }}</span>
            <ChevronDown :size="13" stroke-width="2.2" />
          </button>
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
      <p v-if="attachmentError" class="composer-attachment-error" role="status">{{ attachmentError }}</p>
    </div>
  </form>
</template>
