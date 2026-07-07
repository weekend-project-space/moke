<script setup lang="ts">
import { ArrowUp, Square } from 'lucide-vue-next'
import { nextTick, ref } from 'vue'
import { uiText } from '../text/uiText'

const props = defineProps<{
  inputValue: string
  primaryDisabled: boolean
  primaryIsStop: boolean
}>()

const emit = defineEmits<{
  submit: []
  input: []
  enter: [event: KeyboardEvent]
  'update:inputValue': [value: string]
}>()

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

defineExpose({ focus, resize })
</script>

<template>
  <form class="composer" @submit.prevent="$emit('submit')">
    <div class="composer-panel input-mode" @click="focusFromPanelClick">
      <div class="composer-input-row">
        <div class="composer-textarea-area">
          <textarea
            ref="textarea"
            :value="props.inputValue"
            rows="1"
            :placeholder="uiText.composer.placeholder"
            @input="handleInput"
            @keydown.enter="$emit('enter', $event)"
          ></textarea>
        </div>
        <div class="composer-footer">
          <span aria-hidden="true"></span>
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
