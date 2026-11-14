# 前端规范（Vue 3）

## 结构

- 页面放 `src/pages/`，通用组件放 `src/components/`，布局放 `src/layouts/`，状态放 `src/stores/`（Pinia setup store），纯函数工具放 `src/utils/`。
- 组件统一使用 `<script setup lang="ts">`，UI 优先用 Ant Design Vue 现有组件，不引入新的 UI 库或 CSS 框架。
- 页面组件已经较大（如 `AppChatPage.vue`）。新增的可独立逻辑（解析、状态推导、格式化）抽到 `src/utils/` 并写测试，不要继续堆进页面。

## 请求

- 普通 JSON 请求统一通过 `src/request.ts` 的 axios 实例（带 cookie，401 自动跳登录），不要另建 axios 实例。流式生成接口是例外，在 `src/api/appController.ts` 中用 `fetch` 读取响应流。
- 接口函数写在 `src/api/*Controller.ts`，类型写在 `src/api/typings.d.ts` 的 `API` 命名空间，与 `docs/api.md` 保持一致。
- 生成过程的流式响应使用 `src/utils/sse.ts` 解析，断流不能当作成功处理。
- 接口地址和预览地址从 `src/config/env.ts` 获取，不要在组件里硬编码域名或端口。

## 安全

- 模型或用户输入的内容只能经 `MarkdownRenderer.vue` 渲染，并保持其 markdown-it 配置 `html: false`。不要在其他地方用 `v-html` 渲染这类内容。
- 预览 iframe 是跨源页面，不要读取或修改其 DOM。

## 文案

- 界面文案使用中文，面向最终用户，不要出现实现细节、开发备注或调试信息。

## 测试与风格

- 测试使用 Node 内置 `node:test`，文件放在 `test/*.test.ts`，从 `../src/...` 以 `.ts` 后缀导入，只测不依赖 DOM 的纯逻辑。
- Prettier：无分号、单引号、行宽 100。ESLint 已包含 Vue 与 TypeScript 推荐规则。
- 改动后至少运行 `pnpm --filter paimeng-ai-code-mother-frontend type-check`、`lint`、`test`。
