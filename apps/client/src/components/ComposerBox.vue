<script setup lang="ts">
import { ArrowUp, ImagePlus, Square, X } from 'lucide-vue-next'
import { nextTick, ref } from 'vue'
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

const fileInput = ref<HTMLInputElement | null>(null)
const textarea = ref<HTMLTextAreaElement | null>(null)

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

function chooseImages() {
  fileInput.value?.click()
}

function handleFileChange(event: Event) {
  const input = event.target as HTMLInputElement
  void addImageFiles(Array.from(input.files || []))
  input.value = ''
}

function handlePaste(event: ClipboardEvent) {
  const files = Array.from(event.clipboardData?.files || []).filter((file) => file.type.startsWith('image/'))
  if (!files.length) return

  event.preventDefault()
  void addImageFiles(files)
}

defineExpose({ focus, resize })
</script>

<template>
  <form class="composer" @submit.prevent="$emit('submit')">
    <div class="composer-panel input-mode" @click="focusFromPanelClick">
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
            :aria-label="uiText.composer.addImage"
            :title="uiText.composer.addImage"
            @click="chooseImages"
          >
            <ImagePlus :size="16" stroke-width="2.1" />
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
