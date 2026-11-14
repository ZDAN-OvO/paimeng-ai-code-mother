---
name: vue
description: "在派蒙平台创建或修改 Vue 3 + Vite 构建型应用。适用于用户明确要求 Vue，或现有 package.json 已使用 Vue 的情况；覆盖依赖、类型检查、构建和实时预览的交付流程。"
---

# Vue 3 + Vite 交付

## 适用判断

- 用户明确要求 Vue 3/Vite，或现有 `package.json` 依赖包含 `vue` 时使用本技能。
- 纯静态页面且用户未要求框架时，不要引入 Vue；使用 `static` 技能。
- 从静态项目切换为 Vue 时，先确认这是用户要求，再建立 `package.json`、依赖和 Vue 入口。

## 平台边界

- 平台负责安装依赖、在存在 `typecheck` 脚本时运行类型检查、执行 `build`，并启动 Vite 预览；不要运行 npm，也不要启动 dev server。
- 依赖只能通过 `dependencies` 工具管理：先 `list_allowed`，再 `add`。不要手写锁文件、`.npmrc`、`node_modules` 或 `dist`。
- Vite 的 host、port、HMR 由平台注入；不要在 `vite.config.ts` 固定 `server.host`、`server.port` 或 `server.hmr`。
- 预览环境没有外网：禁止 CDN、远程字体和远程接口；所有资源放在项目内。
- 文件工具路径相对于项目根目录；写或改之前先 `read`；`edit` 的 `oldText` 必须唯一匹配；删除目录前先 `ls` 并核对 `version`。
- 写完文件后直接结束本回合，不要轮询 `preview status` 或等待预览启动；平台会在模型回合结束后安装、检查、构建并启动预览。

## 标准结构

```text
index.html
package.json
vite.config.ts
src/main.ts
src/App.vue
src/style.css
```

- `index.html` 使用 `<script type="module" src="/src/main.ts"></script>`。
- `package.json` 必须包含 `"dev": "vite"` 和 `"build": "vite build"`。
- TypeScript 项目建议增加 `"typecheck": "vue-tsc --noEmit"`；平台会在存在该脚本时运行。
- `vite.config.ts` 使用 `defineConfig` 和 `@vitejs/plugin-vue`，只保留业务需要的配置。

## 工作流

1. 侦察：读取现有 `package.json`、`index.html`、`vite.config.ts` 和 `src/`，确认是新建还是增量修改。
2. 依赖：通过 `dependencies` 工具添加 Vue、Vite、`@vitejs/plugin-vue`、TypeScript 和 `vue-tsc` 等实际需要的包。
3. 实现：先写入口和组件结构，再补样式与交互；修改已有文件时保持组件边界和命名。
4. 自检：脚本齐全、入口引用正确、组件无未定义变量、交互真实可用、没有 TODO 或空组件。
5. 交付：用中文说明关键文件、实现内容和验证方式；不要声称平台验证已通过。

## 质量原则

- 优先使用 Composition API 和 `<script setup lang="ts">`，状态放在最接近使用位置的组件。
- 需要路由或全局状态时，使用允许清单内的 `vue-router` / `pinia`，不要引入清单外依赖。
- 样式优先使用普通 CSS；用户明确要求 Tailwind 时再通过 `dependencies` 添加 `tailwindcss` 和 `@tailwindcss/vite`。
- 保持用户已有页面和交互，不要为小改动重建整个项目。

## 常见修复

- 依赖缺失或版本不符：读取错误中的包名，用 `dependencies list_allowed` 核对范围后重新添加。
- TypeScript 错误：按错误文件和行号修改变量、类型或导入；不要用 `any` 或关闭检查来绕过。
- 构建失败：先看 Vite 日志中的第一个错误，优先修根因；不要删除构建脚本或改用其他打包器。
- 预览空白或 401：检查入口路径、Vite 配置和平台返回的预览状态；不要自行启动服务器。
