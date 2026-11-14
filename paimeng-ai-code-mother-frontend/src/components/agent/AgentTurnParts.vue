<template>
  <div class="turn-parts">
    <template v-for="block in blocks" :key="block.key">
      <MarkdownRenderer v-if="block.type === 'text' && block.text" :content="block.text" />
      <div v-else-if="block.type === 'tools'" class="activity-group" :class="block.group.status">
        <button
          class="activity-group-head"
          type="button"
          :aria-expanded="isOpen(block.key)"
          @click="toggle(block.key)"
        >
          <span class="activity-group-icon">
            <ReadOutlined v-if="block.group.kind === 'exploration'" />
            <EditOutlined v-else-if="block.group.kind === 'file-changes'" />
            <AppstoreOutlined v-else-if="block.group.kind === 'dependencies'" />
            <ToolOutlined v-else />
          </span>
          <span class="activity-group-title">
            {{ activityGroupLabel(block.group.kind, block.group.status) }}
          </span>
          <DownOutlined v-if="isOpen(block.key)" class="activity-group-chevron" />
          <RightOutlined v-else class="activity-group-chevron" />
        </button>
        <div v-if="isOpen(block.key)" class="activity-group-body">
          <div
            v-for="entry in block.group.entries"
            :key="entry.id"
            class="turn-activity"
            :class="entry.status"
          >
            <LoadingOutlined v-if="entry.status === 'running'" class="activity-icon" spin />
            <CloseCircleFilled v-else-if="entry.status === 'failed'" class="activity-icon failed" />
            <MinusCircleFilled v-else-if="entry.status === 'stopped'" class="activity-icon stopped" />
            <SearchOutlined v-else-if="entry.tool === 'grep' || entry.tool === 'find'" class="activity-icon" />
            <FileTextOutlined
              v-else-if="['read', 'write', 'edit', 'delete', 'ls'].includes(entry.tool)"
              class="activity-icon"
            />
            <ToolOutlined v-else class="activity-icon" />
            <span class="activity-text">{{ entry.label }}</span>
            <span v-if="entry.status === 'failed'" class="activity-state">失败</span>
          </div>
        </div>
      </div>
      <PlanCard v-else-if="block.type === 'plan'" :plan="block.plan" />
      <div v-else-if="block.type === 'validation'" class="validation-line" :class="block.validation.status">
        <span class="validation-dot"></span>
        <span>平台验证 · 第 {{ block.validation.attempt }} 轮</span>
        <span>{{ validationText(block.validation.status) }}</span>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import {
  AppstoreOutlined,
  CloseCircleFilled,
  DownOutlined,
  EditOutlined,
  FileTextOutlined,
  LoadingOutlined,
  MinusCircleFilled,
  ReadOutlined,
  RightOutlined,
  SearchOutlined,
  ToolOutlined,
} from '@ant-design/icons-vue'
import MarkdownRenderer from '@/components/MarkdownRenderer.vue'
import PlanCard from './PlanCard.vue'
import { activityGroupLabel } from '@/utils/agentActivity'
import { buildTurnBlocks, visibleTurnBlocks } from '@/utils/turnBlocks'

const props = withDefaults(defineProps<{
  message: API.ChatUIMessage
  status: 'streaming' | 'completed' | 'failed' | 'cancelled'
  processExpanded?: boolean
}>(), { processExpanded: true })

const expanded = ref<string[]>([])
const blocks = computed(() =>
  visibleTurnBlocks(
    buildTurnBlocks(props.message.parts, props.status),
    props.status,
    props.processExpanded,
  ),
)
const isOpen = (key: string) => expanded.value.includes(`${props.message.id}:${key}`)
const toggle = (key: string) => {
  const value = `${props.message.id}:${key}`
  const index = expanded.value.indexOf(value)
  if (index >= 0) expanded.value.splice(index, 1)
  else expanded.value.push(value)
}
const validationText = (status: string) =>
  status === 'passed' ? '通过' : status === 'failed' ? '未通过' : status === 'skipped' ? '未执行' : '验证中'
</script>

<style scoped>
.turn-parts {
  display: grid;
  gap: 8px;
}

.activity-group {
  border: 1px solid var(--pm-line);
  border-radius: var(--pm-radius-md);
  background: var(--pm-surface-subtle);
  overflow: hidden;
}

.activity-group-head {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 9px 11px;
  border: 0;
  background: transparent;
  color: var(--pm-ink-2);
  font-size: 13px;
  text-align: left;
  cursor: pointer;
}

.activity-group-title {
  flex: 1;
}

.activity-group-chevron {
  color: var(--pm-ink-3);
}

.activity-group-body {
  border-top: 1px solid var(--pm-line);
  padding: 6px 11px 9px;
}

.turn-activity {
  display: flex;
  align-items: center;
  gap: 7px;
  min-height: 28px;
  color: var(--pm-ink-2);
  font-size: 12px;
}

.activity-icon {
  flex: none;
  color: var(--pm-ink-3);
}

.activity-icon.failed {
  color: var(--pm-danger);
}

.activity-icon.stopped {
  color: var(--pm-ink-3);
}

.activity-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.activity-state {
  margin-left: auto;
  color: var(--pm-danger);
}

.validation-line {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 11px;
  border: 1px solid var(--pm-line);
  border-radius: var(--pm-radius-md);
  color: var(--pm-ink-2);
  font-size: 12px;
}

.validation-line > :last-child {
  margin-left: auto;
}

.validation-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--pm-accent);
}

.validation-line.failed .validation-dot {
  background: var(--pm-danger);
}
</style>
