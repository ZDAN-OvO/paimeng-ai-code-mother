# 开发这个应用

这是已初始化的 React 厚架子：React 19 + Vite + TypeScript + Tailwind v4 + shadcn/ui 组件源码。先 listFiles，再 read 阅读本文件、package.json、入口 `src/main.tsx` 和要改的页面，然后在现有工程上实现需求。

## 结构

- `src/App.tsx`：路由表（React Router 的 HashRouter）。新增页面时在这里加一条路由。
- `src/pages/`：页面组件。示例工作台在 `home.tsx`，可以直接改写成用户要的页面。
- `src/components/layout/`：应用外壳与页头；主导航在 `app-shell.tsx`。
- `src/components/ui/`：shadcn/ui 组件源码（button、card、badge）。需要新组件时照同样写法添加。
- `src/data/`：示例数据，替换成真实内容或删除。
- `src/index.css`：Tailwind 入口与设计令牌（颜色、字体、圆角、阴影）。改主题时改这里的 `@theme`，不要在组件里写死颜色。
- 图标用已安装的 `lucide-react`。

## 约定

- 用函数组件和 TypeScript 写页面。入口 `src/main.tsx`、`index.html` 的 `#root` 和 `vite.config.ts` 的 `base: './'` 都不要改。
- 优先复用已有布局、设计令牌和 `src/components/ui/` 里的组件，按需扩展；不要重写一套设计系统，也不要引入 antd。
- package.json 的依赖与 pnpm-lock.yaml 由模板版本固定，不要增删依赖。构建诊断指出清单或锁文件被改坏时，恢复模板版本后重试 buildPreview。
- 平台用 pnpm 安装依赖，并在隔离容器中执行 `tsc --noEmit` 和 `vite build --base=./`，通过后才提供预览。不要写 .env 或密钥，不要写服务端代码。
- 用语义化 HTML、可访问的表单标签和按钮，支持键盘操作与窄屏显示。
