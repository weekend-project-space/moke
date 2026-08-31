import { onBeforeUnmount, ref, watch, type Ref } from 'vue'

type SettingsDiscardAction = () => void | Promise<void>

type SettingsDiscardFlowOptions = {
  dirty: Readonly<Ref<boolean>>
  discard: () => void | Promise<void>
  onDirtyChange?: (dirty: boolean) => void
}

export function useSettingsDiscardFlow({ dirty, discard, onDirtyChange }: SettingsDiscardFlowOptions) {
  const pendingAction = ref<SettingsDiscardAction | null>(null)

  function runAfterDiscard(action: SettingsDiscardAction) {
    if (dirty.value) pendingAction.value = action
    else void action()
  }

  function cancelDiscard() {
    pendingAction.value = null
  }

  async function confirmDiscard() {
    const action = pendingAction.value
    pendingAction.value = null
    if (!action) return
    await discard()
    await action()
  }

  if (onDirtyChange) {
    watch(dirty, onDirtyChange, { immediate: true })
    onBeforeUnmount(() => onDirtyChange(false))
  }

  return {
    pendingAction,
    runAfterDiscard,
    cancelDiscard,
    confirmDiscard,
  }
}
