<script setup lang="ts">
const props = withDefaults(defineProps<{
  align?: 'start' | 'end'
  menuClass?: string
  open: boolean
  options: readonly string[]
  selected: string
}>(), {
  align: 'start',
  menuClass: '',
})

const emit = defineEmits<{
  select: [value: string]
  'update:open': [value: boolean]
}>()

function toggle() {
  emit('update:open', !props.open)
}

function select(value: string) {
  emit('update:open', false)
  emit('select', value)
}
</script>

<template>
  <div class="composer-select-control">
    <div
      v-if="open"
      class="composer-option-list composer-select-menu"
      :class="[menuClass, `align-${align}`]"
    >
      <button
        v-for="option in options"
        :key="option"
        type="button"
        :class="{ active: option === selected }"
        @click="select(option)"
      >
        <span class="composer-option-icon">
          <slot name="option-icon" :option="option" />
        </span>
        <span><slot name="option-label" :option="option">{{ option }}</slot></span>
        <span v-if="option === selected" class="composer-option-check">
          <slot name="option-selected" :option="option" />
        </span>
      </button>
    </div>
    <slot name="trigger" :open="open" :toggle="toggle" />
  </div>
</template>
