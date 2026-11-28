<template>
  <a-layout id="basicLayout" :class="{ 'creation-shell': creationLayout }">
    <!-- 顶部导航栏 -->
    <GlobalHeader v-if="!workspace" :home="home" :class="{ header: !home }" />
    <!-- 主要内容区域 -->
    <a-layout-content class="content">
      <router-view />
    </a-layout-content>
    <!-- 底部版权信息 -->
    <GlobalFooter v-if="!creationLayout" class="footer" />
  </a-layout>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import GlobalHeader from '@/components/GlobalHeader.vue'
import GlobalFooter from '@/components/GlobalFooter.vue'
import '@/assets/creation.css'

const route = useRoute()
const home = computed(() => route.name === '主页')
const workspace = computed(() => route.name === '应用对话')
const creationLayout = computed(() => home.value || workspace.value)
</script>

<style scoped>
#basicLayout {
  background: none;
}

#basicLayout.creation-shell {
  background: var(--paper);
}

#basicLayout .header {
  background: white;
  color: unset;
  padding-inline: 20px;
  margin-bottom: 1px;
}
/* 页面主体 */
#basicLayout .content {
  width: 100%;
  padding: 0;
  background: none;
  margin: 0;
}
/* 页脚 */
#basicLayout .footer {
  padding: 16px;
  bottom: 0;
  left: 0;
  right: 0;
  text-align: center;
}
</style>
