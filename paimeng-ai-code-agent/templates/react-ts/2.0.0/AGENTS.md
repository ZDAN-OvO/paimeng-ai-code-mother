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
- 需要新库时用 shell 工具在 App runtime 里执行 `pnpm add <包名>@<版本>`（工作目录就是工程根 `/work`）。依赖只能来自 npm registry 的包名与版本范围：`git:`、`file:`、`link:`、`http(s):`、`workspace:` 与 `.npmrc` 都会被平台拒绝；shell 的网络是开放的，这条规则约束的是依赖来源，不是网络访问。
- 依赖装好后直接改源码引用它；平台在轮末会用 pnpm 归一化并校验 `pnpm-lock.yaml`，清单与锁文件对不上时这一轮会失败。构建由平台在隔离容器里执行 `tsc --noEmit` 和 `vite build --base=./`，不要自己提交或改锁文件来源。不要写 .env 或密钥，不要写服务端代码。
- 工作区里没有 `.git`，容器内也没有：版本历史在平台侧。需要看历史时用 git 工具（只读），不要执行 git 提交/切换命令。
- 用语义化 HTML、可访问的表单标签和按钮，支持键盘操作与窄屏显示。
