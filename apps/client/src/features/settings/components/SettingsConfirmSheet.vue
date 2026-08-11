<script setup lang="ts">
import { AlertTriangle, Check, Trash2 } from 'lucide-vue-next'
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'

const props = withDefaults(defineProps<{
  open: boolean
  dialogId: string
  title: string
  description: string
  confirmLabel: string
  cancelLabel: string
  tone?: 'danger' | 'neutral'
  busy?: boolean
}>(), {
  tone: 'danger',
  busy: false,
})

const emit = defineEmits<{
  cancel: []
  confirm: []
}>()

const cancelButton = ref<HTMLButtonElement | null>(null)
let returnFocus: HTMLElement | null = null

function restoreFocus() {
  const target = returnFocus
  returnFocus = null
  if (target?.isConnected) target.focus({ preventScroll: true })
}

watch(() => props.open, async (open) => {
  if (!open) {
    restoreFocus()
    return
  }

  returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
  await nextTick()
  cancelButton.value?.focus({ preventScroll: true })
})

onBeforeUnmount(restoreFocus)

function cancel() {
  if (!props.busy) emit('cancel')
}

function confirm() {
  if (!props.busy) emit('confirm')
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="settings-confirm-backdrop"
      tabindex="-1"
      @click.self="cancel"
      @keydown.esc="cancel"
    >
      <section
        class="settings-confirm-sheet"
        :class="`is-${tone}`"
        role="dialog"
        aria-modal="true"
        :aria-labelledby="`${dialogId}-title`"
        :aria-describedby="`${dialogId}-description`"
      >
        <div class="settings-confirm-heading">
          <span class="settings-confirm-icon" aria-hidden="true">
            <AlertTriangle :size="18" />
          </span>
          <h2 :id="`${dialogId}-title`">{{ title }}</h2>
        </div>
        <p :id="`${dialogId}-description`">{{ description }}</p>
        <div class="settings-confirm-actions">
          <button ref="cancelButton" type="button" class="settings-secondary" :disabled="busy" @click="cancel">
            {{ cancelLabel }}
          </button>
          <button
            type="button"
            :class="tone === 'danger' ? 'settings-confirm-danger' : 'settings-primary'"
            :disabled="busy"
            @click="confirm"
          >
            <Trash2 v-if="tone === 'danger'" :size="14" />
            <Check v-else :size="14" />
            {{ confirmLabel }}
          </button>
        </div>
      </section>
    </div>
  </Teleport>
</template>
