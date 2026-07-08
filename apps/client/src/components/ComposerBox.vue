<script setup lang="ts">
import { ArrowUp, Image, Plus, Square, X } from 'lucide-vue-next'
import { nextTick, onMounted, onUnmounted, ref } from 'vue'
import { uiText } from '../text/uiText'
import type { ImageAttachment } from '../types/conversation'

const props = defineProps<{
  attachments: ImageAttachment[]
  inputValue: string
  primaryDisabled: boolean
  primaryIsStop: boolean
}>()

const emit = defineEmits<{
  addAttachments: [attachments: ImageAttachment[]]
  submit: []
  input: []
  enter: [event: KeyboardEvent]
  removeAttachment: [id: string]
  'update:inputValue': [value: string]
}>()

const addMenuOpen = ref(false)
const composerEl = ref<HTMLFormElement | null>(null)
const dragDepth = ref(0)
const fileInput = ref<HTMLInputElement | null>(null)
const textarea = ref<HTMLTextAreaElement | null>(null)
const isDraggingImage = ref(false)

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

  const attachments = await Promise.all(imageFiles.map(readImageFile))
  emit('addAttachments', attachments)
}

function imageFilesFromDataTransfer(dataTransfer: DataTransfer | null) {
  return Array.from(dataTransfer?.files || []).filter((file) => file.type.startsWith('image/'))
}

function chooseImages() {
  addMenuOpen.value = false
  fileInput.value?.click()
}

function toggleAddMenu() {
  addMenuOpen.value = !addMenuOpen.value
}

function closeAddMenuOnOutsideClick(event: PointerEvent) {
  if (!addMenuOpen.value) return
  const target = event.target
  if (target instanceof Node && composerEl.value?.contains(target)) return
  addMenuOpen.value = false
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
  </form>
</template>
