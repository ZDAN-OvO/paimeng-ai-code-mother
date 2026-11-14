<template>
  <a-layout id="basicLayout" :class="{ 'is-workspace': isWorkspace }">
    <GlobalHeader v-if="!isWorkspace" class="header" />
    <a-layout-content class="content">
      <router-view />
    </a-layout-content>
    <GlobalFooter v-if="!isWorkspace" class="footer" />
  </a-layout>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import GlobalHeader from '@/components/GlobalHeader.vue'
import GlobalFooter from '@/components/GlobalFooter.vue'

const route = useRoute()
const isWorkspace = computed(() => route.meta.workspace === true)
</script>

<style scoped>
#basicLayout {
  min-height: 100vh;
  background: var(--pm-page);
}

#basicLayout .header {
  background: color-mix(in srgb, var(--pm-page) 92%, transparent);
  backdrop-filter: blur(14px);
  padding-inline: 24px;
  border-bottom: 1px solid var(--pm-line);
  position: sticky;
  top: 0;
  z-index: 20;
}
/* 页面主体 */
#basicLayout .content {
  width: 100%;
  padding: 0;
  background: var(--pm-page);
  margin: 0;
}
/* 页脚 */
#basicLayout .footer {
  background: transparent;
  border-top: 1px solid var(--pm-line);
}

#basicLayout.is-workspace {
  height: 100vh;
  overflow: hidden;
}

#basicLayout.is-workspace .content {
  height: 100vh;
  min-height: 0;
}
</style>
