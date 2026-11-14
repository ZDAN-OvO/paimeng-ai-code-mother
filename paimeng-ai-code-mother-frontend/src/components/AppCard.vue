<template>
  <article class="app-card" @click="handleViewChat">
    <div class="app-visual">
      <span class="app-mark">{{ initial }}</span>
      <span v-if="app.currentRun" class="app-running">
        <span class="dot"></span>
        {{ app.currentRun.status === 'cancelling' ? '正在停止' : '生成中' }}
      </span>
      <span v-else-if="app.preview?.status === 'running'" class="app-ready">预览中</span>
    </div>
    <div class="app-info">
      <h3 class="app-title">{{ app.appName || '未命名应用' }}</h3>
      <div class="app-meta">
        <span>{{ formatTime(app.updateTime) }}</span>
        <span class="app-open">继续创作 →</span>
      </div>
    </div>
  </article>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { formatTime } from '@/utils/time'

const props = defineProps<{ app: API.AppVO }>()
const emit = defineEmits<{ (e: 'view-chat', appId: number): void }>()

const initial = computed(() => (props.app.appName || '应').trim().slice(0, 1))

const handleViewChat = () => emit('view-chat', props.app.id)
</script>

<style scoped>
.app-card {
  background: var(--pm-surface);
  border: 1px solid var(--pm-line);
  border-radius: var(--pm-radius-lg);
  overflow: hidden;
  cursor: pointer;
  transition:
    transform 180ms ease,
    box-shadow 180ms ease,
    border-color 180ms ease;
}

.app-card:hover {
  transform: translateY(-3px);
  border-color: var(--pm-brand-soft);
  box-shadow: var(--pm-shadow-md);
}

.app-visual {
  position: relative;
  height: 150px;
  display: flex;
  align-items: center;
  justify-content: center;
  background:
    radial-gradient(circle at 24% 20%, rgba(251, 214, 177, 0.8), transparent 34%),
    radial-gradient(circle at 80% 70%, rgba(235, 173, 149, 0.55), transparent 38%), var(--pm-canvas);
  border-bottom: 1px solid var(--pm-line);
}

.app-mark {
  display: grid;
  place-items: center;
  width: 64px;
  height: 64px;
  border-radius: 20px;
  background: rgba(255, 252, 247, 0.88);
  border: 1px solid rgba(255, 255, 255, 0.7);
  box-shadow: var(--pm-shadow-sm);
  color: var(--pm-brand-strong);
  font-size: 28px;
  font-weight: 700;
}

.app-running,
.app-ready {
  position: absolute;
  top: 12px;
  right: 12px;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 9px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 600;
}

.app-running {
  background: var(--pm-warning-bg);
  color: var(--pm-warning);
}

.app-ready {
  background: var(--pm-success-bg);
  color: var(--pm-success);
}

.dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
  animation: pulse 1.2s ease-in-out infinite;
}

@keyframes pulse {
  50% {
    opacity: 0.35;
  }
}

.app-info {
  padding: 14px 16px 16px;
}

.app-title {
  margin: 0 0 8px;
  color: var(--pm-ink);
  font-size: 15px;
  font-weight: 650;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.app-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  color: var(--pm-ink-3);
  font-size: 12px;
}

.app-open {
  color: var(--pm-brand-strong);
  opacity: 0;
  transition: opacity 180ms ease;
}

.app-card:hover .app-open {
  opacity: 1;
}
</style>
