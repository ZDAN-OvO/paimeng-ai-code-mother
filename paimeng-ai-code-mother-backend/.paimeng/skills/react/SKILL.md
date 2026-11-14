---
name: react
description: "在派蒙平台创建或修改 React + Vite 构建型应用。适用于用户明确要求 React，或现有 package.json 已使用 React 的情况；覆盖依赖、类型检查、构建和实时预览的交付流程。"
---

# React + Vite 交付

## 适用判断

- 用户明确要求 React，或现有 `package.json` 依赖包含 `react` 时使用本技能。
- 纯静态页面且用户未要求框架时，不要引入 React；使用 `static` 技能。
- 从静态项目切换为 React 时，先确认这是用户要求，再建立 `package.json`、依赖和 React 入口。

## 平台边界

- 平台负责安装依赖、在存在 `typecheck` 脚本时运行类型检查、执行 `build`，并启动 Vite 预览；不要运行 npm，也不要启动 dev server。
- 依赖只能通过 `dependencies` 工具管理：先 `list_allowed`，再 `add`。不要手写锁文件、`.npmrc`、`node_modules` 或 `dist`。
- 当前允许清单没有 React 路由或状态库；优先用组件状态和 props 实现，不要引入清单外依赖。
- Vite 的 host、port、HMR 由平台注入；不要在 `vite.config.ts` 固定 `server.host`、`server.port` 或 `server.hmr`。
- 预览环境没有外网：禁止 CDN、远程字体和远程接口；所有资源放在项目内。
- 文件工具路径相对于项目根目录；写或改之前先 `read`；`edit` 的 `oldText` 必须唯一匹配；删除目录前先 `ls` 并核对 `version`。
- 写完文件后直接结束本回合，不要轮询 `preview status` 或等待预览启动；平台会在模型回合结束后安装、检查、构建并启动预览。

## 标准结构

```text
index.html
package.json
vite.config.ts
src/main.tsx
src/App.tsx
src/style.css
```

- `index.html` 使用 `<script type="module" src="/src/main.tsx"></script>`。
- `package.json` 必须包含 `"dev": "vite"` 和 `"build": "vite build"`。
- TypeScript 项目建议增加 `"typecheck": "tsc --noEmit"`；平台会在存在该脚本时运行。
- `vite.config.ts` 使用 `defineConfig` 和 `@vitejs/plugin-react`。
- `src/main.tsx` 使用 `createRoot` 挂载 `App`，不要使用已废弃的 `ReactDOM.render`。

## 工作流

1. 侦察：读取现有 `package.json`、`index.html`、`vite.config.ts` 和 `src/`，确认是新建还是增量修改。
2. 依赖：通过 `dependencies` 工具添加 React、React DOM、Vite、`@vitejs/plugin-react`、TypeScript 和类型包。
3. 实现：先写入口和组件结构，再补样式与交互；修改已有文件时保持组件边界和命名。
4. 自检：脚本齐全、入口引用正确、JSX/TSX 无未定义变量、交互真实可用、没有 TODO 或空组件。
5. 交付：用中文说明关键文件、实现内容和验证方式；不要声称平台验证已通过。

## 质量原则

- 使用函数组件和 Hooks；状态放在最接近使用位置的组件，避免为小页面引入额外架构。
- 需要样式时优先普通 CSS；用户明确要求 Tailwind 时再通过 `dependencies` 添加 `tailwindcss` 和 `@tailwindcss/vite`。
- 列表渲染提供稳定的 `key`，表单控件受控或明确说明非受控行为。
- 保持用户已有页面和交互，不要为小改动重建整个项目。

## 常见修复

- 依赖缺失或版本不符：读取错误中的包名，用 `dependencies list_allowed` 核对范围后重新添加。
- TypeScript/JSX 错误：按错误文件和行号修改变量、类型、导入或 JSX 属性；不要关闭检查来绕过。
- 构建失败：先看 Vite 日志中的第一个错误，优先修根因；不要删除构建脚本或改用其他打包器。
- 预览空白或 401：检查入口路径、Vite 配置和平台返回的预览状态；不要自行启动服务器。
