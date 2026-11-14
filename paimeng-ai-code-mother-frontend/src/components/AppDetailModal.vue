<template>
  <a-modal v-model:open="visible" title="应用详情" :footer="null" width="500px">
    <div class="app-detail-content">
      <div class="info-item">
        <span class="info-label">创建时间：</span>
        <span>{{ formatTime(app?.createTime) }}</span>
      </div>
      <div class="info-item">
        <span class="info-label">最近更新：</span>
        <span>{{ formatTime(app?.updateTime) }}</span>
      </div>
      <div class="info-item">
        <span class="info-label">预览状态：</span>
        <a-tag :color="previewColor">{{ previewText }}</a-tag>
      </div>
      <div v-if="showActions" class="app-actions">
        <a-space>
          <a-button type="primary" @click="emit('edit')">
            <template #icon><EditOutlined /></template>
            修改名称
          </a-button>
          <a-popconfirm
            title="删除后源码和全部对话都会永久消失，确定删除吗？"
            @confirm="emit('delete')"
            ok-text="确定删除"
            cancel-text="取消"
          >
            <a-button danger>
              <template #icon><DeleteOutlined /></template>
              删除
            </a-button>
          </a-popconfirm>
        </a-space>
      </div>
    </div>
  </a-modal>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { EditOutlined, DeleteOutlined } from '@ant-design/icons-vue'
import { formatTime } from '@/utils/time'

const props = withDefaults(
  defineProps<{ open: boolean; app?: API.AppVO; showActions?: boolean }>(),
  { showActions: false },
)
const emit = defineEmits<{
  (e: 'update:open', value: boolean): void
  (e: 'edit'): void
  (e: 'delete'): void
}>()

const visible = computed({
  get: () => props.open,
  set: (value) => emit('update:open', value),
})

const previewText = computed(() => {
  const status = props.app?.preview?.status
  if (status === 'running') return '运行中'
  if (status === 'starting') return '启动中'
  if (status === 'failed') return '启动失败'
  return '未启动'
})

const previewColor = computed(() => {
  const status = props.app?.preview?.status
  if (status === 'running') return 'green'
  if (status === 'starting') return 'blue'
  if (status === 'failed') return 'red'
  return 'default'
})
</script>

<style scoped>
.app-detail-content {
  padding: 8px 0;
}
.info-item {
  display: flex;
  align-items: center;
  margin-bottom: 12px;
}
.info-label {
  width: 80px;
  color: var(--pm-ink-3);
  font-size: 14px;
  flex-shrink: 0;
}
.app-actions {
  padding-top: 16px;
  border-top: 1px solid var(--pm-line);
}
</style>
