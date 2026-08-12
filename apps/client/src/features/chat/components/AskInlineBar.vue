<script setup lang="ts">
import { ref } from 'vue'
import { ArrowRight, Check, Pencil } from 'lucide-vue-next'
import { uiText } from '../../../text/uiText'
import type { AskOption, PendingAsk } from '../model/conversation'

defineProps<{
  ask: PendingAsk
  submitting?: boolean
}>()

const emit = defineEmits<{
  select: [answer: AskOption | string]
}>()

const customText = ref('')
const selectedAnswer = ref<string | null>(null)

function selectOption(option: AskOption) {
  selectedAnswer.value = option.id
  emit('select', option)
}

function submitCustom() {
  const text = customText.value.trim()
  if (!text) return
  selectedAnswer.value = 'custom'
  emit('select', text)
}
</script>

<template>
  <section class="ask-inline" aria-live="polite">
    <div class="ask-inline-question">{{ ask.question }}</div>
    <div>
      <div class="ask-inline-options">
        <button
          v-for="(option, index) in ask.options"
          :key="option.id"
          type="button"
          :class="{ selected: selectedAnswer === option.id }"
          :disabled="submitting"
          @click="selectOption(option)"
        >
          <span class="ask-inline-option-index">{{ index + 1 }}</span>
          <span class="ask-inline-option-label">{{ option.label }}</span>
          <Check v-if="selectedAnswer === option.id" class="ask-inline-option-arrow" :size="15" stroke-width="2.2" aria-hidden="true" />
          <ArrowRight v-else class="ask-inline-option-arrow" :size="15" stroke-width="2" aria-hidden="true" />
        </button>
      </div>
      <form class="ask-inline-custom" :class="{ selected: selectedAnswer === 'custom' }" @submit.prevent="submitCustom">
        <Pencil :size="15" stroke-width="1.8" aria-hidden="true" />
        <input v-model="customText" :placeholder="uiText.chat.askOtherPlaceholder" :disabled="submitting" maxlength="2000" :aria-label="uiText.chat.askOtherPlaceholder" />
        <Check v-if="selectedAnswer === 'custom'" :size="15" stroke-width="2.2" aria-hidden="true" />
      </form>
    </div>
  </section>
</template>
