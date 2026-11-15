# 前端规范（Vue 3）

## 结构

```text
paimeng-ai-code-mother-frontend/
├── src/
│   ├── main.ts / App.vue     # 入口与根组件
│   ├── router/               # 路由
│   ├── access.ts             # 首次路由前拉取登录用户
│   ├── request.ts            # 唯一的 axios 实例
│   ├── api/                  # generated/ 生成代码、apiTypes.ts、chatTypes.ts、streamChat.ts
│   ├── config/               # 接口地址与预览地址
│   ├── pages/                # 页面（app/、user/ 等）
│   ├── components/           # 通用组件，agent/ 下为生成过程组件
│   ├── layouts/              # 布局
│   ├── stores/               # Pinia setup store
│   ├── utils/                # 不依赖 DOM 的纯函数工具
│   └── assets/               # 样式变量与图片
├── public/
└── test/                     # node:test 单元测试（*.test.ts）
```

- 组件统一使用 `<script setup lang="ts">`，UI 优先用 Ant Design Vue 现有组件，不引入新的 UI 库或 CSS 框架。
- 页面组件已经较大（如 `AppChatPage.vue`）。新增的可独立逻辑（解析、状态推导、格式化）抽到 `src/utils/` 并写测试，不要继续堆进页面。

## 框架规范

以官方文档为准：Vue 3.5 风格指南与 TypeScript 指南、Vue Router 4、Pinia 3、Vite 7。

### 组件（Vue 风格指南）

以下是风格指南的 Essential 和 Strongly Recommended 规则，新代码必须遵守：

- 组件名用多个单词，文件名用 PascalCase（如 `AppCard.vue`）；页面以 `Page` 结尾，强耦合的子组件以父组件名为前缀。
- `v-for` 必须带稳定的 `:key`，不要用数组下标；不要在同一元素上同时写 `v-if` 和 `v-for`，先用 `computed` 过滤。
- 除 `App.vue` 和布局组件外，样式使用 `<style scoped>`；全局样式变量放 `src/assets/tokens.css`。
- 模板里只写简单表达式，复杂逻辑放 `computed` 或函数。
- props 和 emits 用基于类型的 `defineProps<{…}>()`、`defineEmits<{…}>()` 声明；默认值用解构默认值或 `withDefaults`。
- 在模板中使用 PascalCase 组件名，指令使用缩写（`:`、`@`、`#`）。

### 组合式函数

- 有状态、跨组件复用的逻辑写成组合式函数，命名以 `use` 开头，放 `src/composables/`（需要时再创建）；无状态的纯函数仍然放 `src/utils/`。
- 组合式函数内注册的定时器、监听和请求，要在 `onUnmounted` 或 `onScopeDispose` 中清理。

### 状态（Pinia）

- 使用 setup store：`defineStore('id', () => { … })`，store id 与文件名一致，导出名为 `use…Store`。
- 从 store 解构 state 和 getters 时必须用 `storeToRefs()`，直接解构会丢失响应性；action 可以直接解构。
- 只有跨页面共享的状态放进 store，页面局部状态留在组件里。
- 在组件外（路由守卫、`request.ts`）使用 store 时，在函数内部调用 `use…Store()`，不要在模块顶层调用。
- `src/stores/counter.ts` 是脚手架遗留，没有被引用，不要模仿。

### 路由（Vue Router）

- 新增页面路由使用懒加载：`component: () => import('@/pages/…Page.vue')`。现有路由是同步导入。
- 导航守卫用返回值控制跳转（返回 `false` 或路由地址），不要使用已不推荐的 `next()` 回调写法；现有 `access.ts` 仍在用 `next()`，修改时一并改掉。

### 构建与环境（Vite）

- 只有 `VITE_` 前缀的变量会进入浏览器产物，因此任何密钥都不能放进前端环境变量。
- 新增环境变量时，在 `env.d.ts` 里扩充 `ImportMetaEnv` 类型，并通过 `src/config/env.ts` 读取，不要在组件里直接访问 `import.meta.env`。
- 环境变量的值总是字符串，数字和布尔值要显式转换。
- 导入路径使用 `@/` 别名且不带 `.ts` 后缀，这是当前多数文件的写法。

## 请求

- 普通 JSON 请求统一通过 `src/request.ts` 的 axios 实例（带 cookie，401 自动跳登录），不要另建 axios 实例。流式生成接口是例外，在 `src/api/streamChat.ts` 中用 `fetch` 读取响应流。
- 普通接口调用 `src/api/generated/` 下的生成函数，类型也在生成文件里；该目录由 `pnpm openapi` 从后端 `openapi.json` 生成，不能手改。改接口时修改后端 zod schema 并重新生成，用 `pnpm contract:check` 验证。业务代码里的可读类型别名写在 `src/api/apiTypes.ts`，聊天相关类型写在 `src/api/chatTypes.ts`。
- 只有流式聊天保留手写实现，位于 `src/api/streamChat.ts`。
- 生成过程的流式响应使用 `src/utils/sse.ts` 解析，断流不能当作成功处理。
- 接口地址和预览地址从 `src/config/env.ts` 获取，不要在组件里硬编码域名或端口。

## 安全

- 模型或用户输入的内容只能经 `MarkdownRenderer.vue` 渲染，并保持其 markdown-it 配置 `html: false`。不要在其他地方用 `v-html` 渲染这类内容；Vue 官方安全指南同样要求不把不可信内容作为模板或 HTML 渲染。
- 不要把用户提供的 URL 直接绑定到 `href`、`src`，除非确认协议是 `http`/`https`，否则可能执行 `javascript:` 链接。
- 预览 iframe 是跨源页面，不要读取或修改其 DOM。

## 文案

- 界面文案使用中文，面向最终用户，不要出现实现细节、开发备注或调试信息。

## 测试与风格

- 测试使用 Node 内置 `node:test`，文件放在 `test/*.test.ts`，从 `../src/...` 以 `.ts` 后缀导入，只测不依赖 DOM 的纯逻辑。
- Prettier：无分号、单引号、行宽 100。ESLint 已包含 Vue 与 TypeScript 推荐规则。
- 改动后至少运行 `pnpm --filter paimeng-ai-code-mother-frontend type-check`、`lint`、`test`。
