<script setup lang="ts">
import { ConfigProvider, theme as antdTheme } from 'ant-design-vue'
import BasicLayout from './layouts/BasicLayout.vue'
import { onMounted } from 'vue'
import { useLoginUserStore } from '@/stores/loginUser.ts'

const customTheme = {
  algorithm: antdTheme.defaultAlgorithm,
  token: {
    colorPrimary: '#1d1c1c',
    colorInfo: '#a9553f',
    colorLink: '#a9553f',
    colorBgBase: '#fffdf9',
    colorTextBase: '#1d1c1c',
    colorBorder: '#e8d9cc',
    colorBorderSecondary: '#f0e4d9',
    borderRadius: 10,
    fontFamily:
      "'PingFang SC', 'HarmonyOS Sans SC', 'Noto Sans SC', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  },
}
// 项目加载的时候默认出用户
onMounted(() => {
  useLoginUserStore().fetchLoginUser()
})
</script>

<template>
  <div id="app">
    <ConfigProvider :theme="customTheme">
      <BasicLayout />
    </ConfigProvider>
  </div>
</template>

<style>
html {
  overflow-x: hidden;
}

body {
  overflow-x: hidden;
}

a {
  color: var(--pm-brand-strong);
}
</style>
