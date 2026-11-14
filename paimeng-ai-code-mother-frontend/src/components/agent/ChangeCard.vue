<template>
  <button class="change-card" type="button" @click="emit('open')">
    <span class="change-icon">◫</span>
    <span class="change-main">
      <span class="change-title">
        {{
          changes.filesChanged > 0 ? `更新了 ${changes.filesChanged} 个文件` : '本轮没有文件变更'
        }}
      </span>
      <span class="change-meta">
        <template v-if="changes.additions !== null || changes.deletions !== null">
          <span class="add">+{{ changes.additions ?? 0 }}</span>
          <span class="del">−{{ changes.deletions ?? 0 }}</span>
        </template>
        <span v-if="changes.partial || !changes.complete">部分统计</span>
        <span v-if="detailsStatus === 'incomplete'">详情不完整</span>
      </span>
    </span>
    <span class="change-arrow">查看 →</span>
  </button>
</template>

<script setup lang="ts">
defineProps<{
  changes: API.RunDetails['changes']
  detailsStatus?: 'pending' | 'ready' | 'incomplete'
}>()
const emit = defineEmits<{ (e: 'open'): void }>()
</script>

<style scoped>
.change-card {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 10px 0;
  padding: 11px 12px;
  border: 1px solid var(--pm-line);
  border-radius: var(--pm-radius-md);
  background: var(--pm-surface);
  color: var(--pm-ink);
  text-align: left;
  cursor: pointer;
}

.change-card:hover {
  border-color: var(--pm-brand-soft);
  background: var(--pm-surface-strong);
}

.change-icon {
  width: 28px;
  height: 28px;
  display: grid;
  place-items: center;
  border-radius: 9px;
  background: var(--pm-canvas);
  color: var(--pm-brand-strong);
  flex: 0 0 auto;
}

.change-main {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.change-title {
  font-size: 13px;
  font-weight: 600;
}

.change-meta {
  display: flex;
  gap: 8px;
  color: var(--pm-ink-3);
  font-size: 11px;
}

.add {
  color: var(--pm-success);
}

.del {
  color: var(--pm-danger);
}

.change-arrow {
  margin-left: auto;
  color: var(--pm-brand-strong);
  font-size: 12px;
}
</style>
