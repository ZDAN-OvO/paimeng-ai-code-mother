<template>
  <div class="plan-card">
    <button class="plan-head" type="button" :aria-expanded="open" @click="open = !open">
      <span class="plan-label">本轮计划</span>
      <span class="plan-revision">
        第 {{ plan.revision }} 版
        <span class="plan-chevron" :class="{ open }">⌄</span>
      </span>
    </button>
    <ol v-if="open" class="plan-steps">
      <li v-for="step in plan.steps" :key="step.id" :class="`step-${step.status}`">
        <span class="step-icon">
          <CheckCircleFilled v-if="step.status === 'completed'" />
          <LoadingOutlined v-else-if="step.status === 'in_progress'" spin />
          <span v-else class="step-dot"></span>
        </span>
        <span class="step-title">{{ step.title }}</span>
        <span class="step-state">{{ stateText(step.status) }}</span>
      </li>
    </ol>
  </div>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import { CheckCircleFilled, LoadingOutlined } from '@ant-design/icons-vue'

const props = defineProps<{ plan: API.RunPlan }>()

const allDone = () => props.plan.steps.every((step) => step.status === 'completed')
const open = ref(!allDone() || props.plan.steps.length < 3)

watch(
  () => props.plan.revision,
  () => {
    if (allDone()) open.value = false
  },
)

const stateText = (status: API.RunPlanStep['status']) => {
  if (status === 'completed') return '已完成'
  if (status === 'in_progress') return '进行中'
  return '待开始'
}
</script>

<style scoped>
.plan-card {
  border: 1px solid var(--pm-line);
  border-radius: var(--pm-radius-md);
  background: var(--pm-surface);
  padding: 12px 14px;
  margin: 12px 0;
}

.plan-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  padding: 0;
  margin: 0 0 8px;
  border: 0;
  background: transparent;
  color: inherit;
  cursor: pointer;
}

.plan-label {
  color: var(--pm-ink-2);
  font-size: 12px;
  font-weight: 650;
  letter-spacing: 0.06em;
}

.plan-revision {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--pm-ink-3);
  font-size: 11px;
}

.plan-chevron {
  transition: transform 160ms ease;
}

.plan-chevron.open {
  transform: rotate(180deg);
}

.plan-steps {
  list-style: none;
  padding: 0;
  margin: 0;
  display: grid;
  gap: 7px;
}

.plan-steps li {
  display: flex;
  align-items: center;
  gap: 9px;
  min-width: 0;
  color: var(--pm-ink-2);
  font-size: 13px;
}

.step-icon {
  display: inline-flex;
  color: var(--pm-ink-3);
  flex: 0 0 auto;
}

.step-completed .step-icon {
  color: var(--pm-success);
}

.step-in_progress .step-icon {
  color: var(--pm-brand-strong);
}

.step-dot {
  width: 12px;
  height: 12px;
  border: 1px solid var(--pm-line-strong);
  border-radius: 50%;
  display: block;
}

.step-title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.step-completed .step-title {
  color: var(--pm-ink-3);
  text-decoration: line-through;
}

.step-state {
  margin-left: auto;
  flex: 0 0 auto;
  white-space: nowrap;
  color: var(--pm-ink-3);
  font-size: 11px;
}
</style>
