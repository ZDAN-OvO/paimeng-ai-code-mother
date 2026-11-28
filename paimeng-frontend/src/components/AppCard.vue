<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ExportOutlined, GlobalOutlined, MessageOutlined } from '@ant-design/icons-vue'
import { getDeployUrl } from '@/config/env'
import { formatCodeGenType } from '@/utils/codeGenTypes'

const props = defineProps<{ app: API.AppVO; featured?: boolean }>()
const coverFailed = ref(false)
watch(
  () => props.app.cover,
  () => {
    coverFailed.value = false
  },
)

const title = computed(() => props.app.appName || '未命名应用')
const category = computed(() => formatCodeGenType(props.app.codeGenType))
const chat = computed(() =>
  props.app.id == null
    ? undefined
    : {
        name: '应用对话',
        params: { id: String(props.app.id) },
      },
)
const published = computed(() => (props.app.deployKey ? getDeployUrl(props.app.deployKey) : ''))
const showcase = computed(() => props.featured && Boolean(published.value))
</script>

<template>
  <article class="project-card">
    <div class="project-cover">
      <img v-if="app.cover && !coverFailed" :src="app.cover" alt="" @error="coverFailed = true" />
      <GlobalOutlined v-else aria-hidden="true" />
    </div>
    <div class="project-meta">
      <div class="project-copy">
        <h3>
          <a
            v-if="showcase"
            class="project-link"
            :href="published"
            target="_blank"
            rel="noopener noreferrer"
          >
            {{ title }}
          </a>
          <RouterLink v-else-if="chat" class="project-link" :to="chat">
            {{ title }}
          </RouterLink>
          <span v-else>{{ title }}</span>
        </h3>
        <p>{{ category }}</p>
      </div>
      <RouterLink
        v-if="showcase && chat"
        class="project-action"
        :to="chat"
        :aria-label="'查看对话 · ' + title"
        title="查看对话"
      >
        <MessageOutlined />
      </RouterLink>
      <a
        v-else-if="published && !showcase && chat"
        class="project-action"
        :href="published"
        target="_blank"
        rel="noopener noreferrer"
        :aria-label="'打开发布网站 · ' + title"
        title="打开发布网站"
      >
        <ExportOutlined />
      </a>
      <ExportOutlined v-else-if="chat || showcase" class="project-arrow" aria-hidden="true" />
    </div>
  </article>
</template>

<style scoped>
.project-card {
  position: relative;
  min-width: 0;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--white);
}
.project-card:hover,
.project-card:focus-within {
  border-color: #c9c6be;
}
.project-cover {
  display: grid;
  height: 155px;
  place-items: center;
  overflow: hidden;
  border-radius: 11px 11px 0 0;
  background: var(--slot);
  color: #9b968b;
  font-size: 30px;
}
.project-cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.project-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  min-height: 65px;
  padding: 9px 14px;
}
.project-copy {
  min-width: 0;
}
.project-copy h3,
.project-copy p {
  margin: 0;
  overflow-wrap: anywhere;
}
.project-copy h3 {
  font-size: 14px;
  font-weight: 650;
}
.project-copy p {
  margin-top: 2px;
  color: var(--muted);
  font-size: 12px;
}
.project-link {
  color: var(--ink);
}
.project-link::after {
  position: absolute;
  inset: 0;
  border-radius: var(--radius);
  content: '';
}
.project-action {
  position: relative;
  display: grid;
  flex: none;
  width: 32px;
  height: 32px;
  place-items: center;
  border-radius: 7px;
  color: var(--muted);
}
.project-action:hover {
  background: var(--slot);
  color: var(--ink);
}
.project-arrow {
  padding-inline: 9px;
  color: var(--muted);
}
</style>
