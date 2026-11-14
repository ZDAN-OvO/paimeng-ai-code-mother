<template>
  <div class="validation-card">
    <button
      class="validation-head"
      type="button"
      :aria-expanded="open"
      @click="open = !open"
    >
      <span class="validation-title">平台验证</span>
      <span class="validation-meta">
        <span v-if="attempts.length" class="attempt-state" :class="overall.state">
          {{ overall.label }}
        </span>
        <span v-if="attempts.length" class="validation-round">共 {{ attempts.length }} 轮</span>
        <DownOutlined v-if="open" class="validation-chevron" />
        <RightOutlined v-else class="validation-chevron" />
      </span>
    </button>
    <div v-if="open" class="validation-body">
      <div v-for="attempt in attempts" :key="attempt.attempt" class="attempt">
        <div class="attempt-head">
          <span>第 {{ attempt.attempt }} 轮</span>
          <span class="attempt-state" :class="attempt.state">{{ attempt.label }}</span>
        </div>
        <div class="checks">
          <button
            v-for="check in attempt.checks"
            :key="check.check"
            class="check"
            type="button"
            @click="emit('openLog', attempt.attempt, check.check)"
          >
            <span class="check-dot" :class="check.status"></span>
            <span class="check-name">{{ checkLabel(check.check) }}</span>
            <span class="check-status">{{ checkText(check.status) }}</span>
          </button>
        </div>
      </div>
      <p v-if="!attempts.length" class="no-validation">本轮尚未产生验证记录。</p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { DownOutlined, RightOutlined } from '@ant-design/icons-vue'

const props = defineProps<{ validations: API.RunValidation[] }>()
const emit = defineEmits<{ (e: 'openLog', attempt: number, check: string): void }>()

const checks = ['source', 'manifest', 'install', 'typecheck', 'build', 'preview']
const open = ref(false)

const attempts = computed(() => {
  const byAttempt = new Map<number, API.RunValidation[]>()
  for (const item of props.validations) {
    const list = byAttempt.get(item.attempt) ?? []
    list.push(item)
    byAttempt.set(item.attempt, list)
  }
  return [...byAttempt.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([attempt, items]) => {
      const failed = items.some((item) => item.status === 'failed')
      const running = items.some((item) => item.status === 'running')
      const order = new Map(checks.map((check, index) => [check, index]))
      return {
        attempt,
        state: failed ? 'failed' : running ? 'running' : 'passed',
        label: failed ? '未通过' : running ? '验证中' : '通过',
        checks: [...items].sort((a, b) => (order.get(a.check) ?? 99) - (order.get(b.check) ?? 99)),
      }
    })
})

const overall = computed(() => {
  if (attempts.value.some((item) => item.state === 'failed')) {
    return { state: 'failed', label: '未通过' }
  }
  if (attempts.value.some((item) => item.state === 'running')) {
    return { state: 'running', label: '验证中' }
  }
  return { state: 'passed', label: '通过' }
})

const checkLabel = (check: string) => {
  const map: Record<string, string> = {
    source: '源码检查',
    manifest: '项目清单',
    install: '安装依赖',
    typecheck: '类型检查',
    build: '构建',
    preview: '预览启动',
  }
  return map[check] ?? check
}

const checkText = (status: API.RunValidation['status']) => {
  if (status === 'passed') return '通过'
  if (status === 'failed') return '失败'
  if (status === 'running') return '进行中'
  return '跳过'
}
</script>

<style scoped>
.validation-card {
  border: 1px solid var(--pm-line);
  border-radius: var(--pm-radius-md);
  background: var(--pm-surface);
  padding: 12px 14px;
  margin: 10px 0;
}

.validation-head,
.attempt-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.validation-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  text-align: left;
  cursor: pointer;
}

.validation-title {
  color: var(--pm-ink-2);
  font-size: 12px;
  font-weight: 650;
  letter-spacing: 0.06em;
}

.validation-round {
  color: var(--pm-ink-3);
  font-size: 11px;
}

.validation-meta {
  display: inline-flex;
  align-items: center;
  gap: 7px;
}

.validation-chevron {
  color: var(--pm-ink-3);
  font-size: 9px;
}

.validation-body {
  margin-top: 8px;
}

.attempt + .attempt {
  margin-top: 10px;
  border-top: 1px dashed var(--pm-line);
  padding-top: 10px;
}

.attempt-head {
  color: var(--pm-ink-2);
  font-size: 12px;
  font-weight: 600;
  margin-bottom: 5px;
}

.attempt-state {
  padding: 2px 7px;
  border-radius: 999px;
  font-size: 10px;
}

.attempt-state.passed {
  color: var(--pm-success);
  background: var(--pm-success-bg);
}

.attempt-state.failed {
  color: var(--pm-danger);
  background: var(--pm-danger-bg);
}

.attempt-state.running {
  color: var(--pm-warning);
  background: var(--pm-warning-bg);
}

.checks {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}

.check {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 7px;
  border: 1px solid var(--pm-line);
  border-radius: 7px;
  background: transparent;
  color: var(--pm-ink-2);
  font-size: 11px;
  cursor: pointer;
}

.check:hover {
  background: var(--pm-canvas);
}

.check-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--pm-ink-3);
}

.check-dot.passed {
  background: var(--pm-success);
}

.check-dot.failed {
  background: var(--pm-danger);
}

.check-dot.running {
  background: var(--pm-warning);
}

.check-status {
  color: var(--pm-ink-3);
}

.no-validation {
  margin: 2px 0 0;
  color: var(--pm-ink-3);
  font-size: 12px;
}
</style>
