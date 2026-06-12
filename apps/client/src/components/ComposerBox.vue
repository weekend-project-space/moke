<script setup lang="ts">
import { SendHorizontal, Square } from 'lucide-vue-next'
import { nextTick, ref } from 'vue'

type AskOption = {
  id: string
  label: string
}

type PendingAsk = {
  ask_id: string
  call_id: string
  question: string
  options: AskOption[]
  created_at?: string
}

const props = defineProps<{
  inputValue: string
  pendingAsk: PendingAsk | null
  primaryDisabled: boolean
  primaryIsStop: boolean
}>()

const emit = defineEmits<{
  submit: []
  input: []
  enter: [event: KeyboardEvent]
  selectAskOption: [option: AskOption]
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
    <div class="composer-panel" :class="{ 'input-mode': !pendingAsk }">
      <div v-if="pendingAsk" class="ask-prompt">
        <p>{{ pendingAsk.question }}</p>
        <div class="ask-options">
          <button
            v-for="option in pendingAsk.options"
            :key="option.id"
            type="button"
            @click="$emit('selectAskOption', option)"
          >
            {{ option.label }}
          </button>
        </div>
      </div>
      <div v-else class="composer-input-row">
        <textarea
          ref="textarea"
          :value="props.inputValue"
          rows="1"
          placeholder="输入给 Moke 的消息"
          @input="handleInput"
          @keydown.enter="$emit('enter', $event)"
        ></textarea>
        <button
          class="primary-action"
          type="submit"
          :class="{ stop: primaryIsStop }"
          :disabled="primaryDisabled"
          :aria-label="primaryIsStop ? '停止运行' : '发送消息'"
          :title="primaryIsStop ? '停止运行' : '发送消息'"
        >
          <Square v-if="primaryIsStop" :size="16" fill="currentColor" stroke-width="2.2" />
          <SendHorizontal v-else :size="18" stroke-width="2.2" />
        </button>
      </div>
    </div>
  </form>
</template>
