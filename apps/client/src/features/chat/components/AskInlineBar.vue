<script setup lang="ts">
import type { AskOption, PendingAsk } from '../model/conversation'

defineProps<{
  ask: PendingAsk
  submitting?: boolean
}>()

const emit = defineEmits<{
  select: [option: AskOption]
}>()
</script>

<template>
  <section class="ask-inline" aria-live="polite">
    <div class="ask-inline-question">{{ ask.question }}</div>
    <div class="ask-inline-options">
      <button
        v-for="option in ask.options"
        :key="option.id"
        type="button"
        :disabled="submitting"
        @click="emit('select', option)"
      >
        {{ option.label }}
      </button>
    </div>
  </section>
</template>
