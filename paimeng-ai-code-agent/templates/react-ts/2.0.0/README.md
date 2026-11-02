# React 厚架子

平台新建构建类 App 时复制的 React 骨架：React 19、Vite、TypeScript、Tailwind v4、shadcn/ui 组件源码、lucide 图标、React Router。

## 本地运行

```bash
pnpm install
pnpm dev          # 开发服务器
pnpm type-check   # tsc --noEmit
pnpm build        # 类型检查 + vite build，产物在 dist/
```

## 结构

- `src/main.tsx`：入口，挂载 `#root`。
- `src/App.tsx`：路由表。
- `src/pages/`：页面。
- `src/components/layout/`：应用外壳与页头。
- `src/components/ui/`：shadcn/ui 组件源码。
- `src/index.css`：Tailwind 入口与设计令牌。
- `src/data/`：示例数据。

需要额外依赖时在 App runtime 里用 `pnpm add` 安装（Shell），平台只接受 npm registry 的包名与版本范围，并在轮末归一化 `pnpm-lock.yaml` 后构建静态产物。
