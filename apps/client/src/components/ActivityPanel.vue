<script setup lang="ts">
import { computed } from 'vue'

type TraceStep = {
  id: string
  kind: string
  title: string
  detail: string
}

const props = defineProps<{
  steps: TraceStep[]
  summary: string
}>()

const currentStep = computed(() => props.steps.at(-1))
const usedTools = computed(() => {
  const names: string[] = []

  for (const step of props.steps) {
    if (step.kind !== 'tool' || names.includes(step.title)) continue
    names.push(step.title)
  }

  return names.slice(0, 6)
})
const needsStep = computed(() =>
  [...props.steps].reverse().find((step) => ['ask', 'approval', 'error'].includes(step.kind)),
)
const statusTitle = computed(() => currentStep.value?.title || '等待开始')
const statusDetail = computed(
  () => currentStep.value?.detail || 'Moke 开始处理后，会在这里显示当前状态。',
)
</script>

<template>
  <aside class="trace">
    <header>
      <p>进展</p>
      <strong>{{ summary || '待命' }}</strong>
    </header>

    <section class="progress-card" :class="currentStep?.kind">
      <span>当前状态</span>
      <strong>{{ statusTitle }}</strong>
      <p>{{ statusDetail }}</p>
    </section>

    <section class="inspector-group">
      <p>已使用</p>
      <div v-if="usedTools.length > 0" class="tool-chips">
        <span v-for="tool in usedTools" :key="tool">{{ tool }}</span>
      </div>
      <strong v-else>暂无</strong>
    </section>

    <section class="inspector-group" :class="{ attention: needsStep }">
      <p>需要你处理</p>
      <template v-if="needsStep">
        <strong v-if="needsStep.kind !== 'ask'">{{ needsStep.title }}</strong>
        <span>{{ needsStep.detail }}</span>
      </template>
      <strong v-else>无</strong>
    </section>
  </aside>
</template>
