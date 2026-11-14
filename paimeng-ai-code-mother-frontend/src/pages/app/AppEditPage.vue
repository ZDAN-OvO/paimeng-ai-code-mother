<template>
  <div id="appEditPage">
    <a-card class="edit-card" :bordered="false">
      <template #title>
        <div class="card-title">
          <a-button type="text" @click="goBack">← 返回</a-button>
          <span>编辑应用</span>
        </div>
      </template>
      <a-form layout="vertical" :model="form" @finish="handleSubmit">
        <a-form-item
          label="应用名称"
          name="appName"
          :rules="[{ required: true, message: '请输入应用名称' }]"
        >
          <a-input
            v-model:value="form.appName"
            :maxlength="50"
            show-count
            placeholder="给应用起个名字"
          />
        </a-form-item>
        <a-form-item>
          <a-space>
            <a-button type="primary" html-type="submit" :loading="saving">保存</a-button>
            <a-button @click="goChat">进入对话</a-button>
          </a-space>
        </a-form-item>
      </a-form>
    </a-card>
  </div>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { message } from 'ant-design-vue'
import { getAppVoById, updateApp } from '@/api/appController'

const route = useRoute()
const router = useRouter()
const appId = Number(route.params.id)
const saving = ref(false)
const form = reactive({ appName: '' })

const loadApp = async () => {
  try {
    const res = await getAppVoById(appId)
    if (res.data.code === 0 && res.data.data) {
      form.appName = res.data.data.appName
    } else {
      message.error(res.data.message || '应用不存在')
      await router.push('/')
    }
  } catch {
    message.error('加载应用失败')
  }
}

const handleSubmit = async () => {
  const name = form.appName.trim()
  if (name.length < 1 || name.length > 50) {
    message.warning('应用名称需为 1-50 个字符')
    return
  }
  saving.value = true
  try {
    const res = await updateApp({ id: appId, appName: name })
    if (res.data.code === 0) {
      message.success('已保存')
      await goChat()
    } else {
      message.error(res.data.message || '保存失败')
    }
  } catch {
    message.error('保存失败，请重试')
  } finally {
    saving.value = false
  }
}

const goChat = () => router.push(`/app/chat/${appId}`)
const goBack = () => router.back()

onMounted(loadApp)
</script>

<style scoped>
#appEditPage {
  min-height: calc(100vh - 64px);
  display: flex;
  justify-content: center;
  padding: 48px 16px;
  background: var(--pm-page);
}
.edit-card {
  width: 100%;
  max-width: 560px;
  border-radius: 16px;
  border: 1px solid var(--pm-line);
  box-shadow: var(--pm-shadow-md);
}
.card-title {
  display: flex;
  align-items: center;
  gap: 8px;
}
</style>
