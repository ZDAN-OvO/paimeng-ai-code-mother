# Paimeng Studio

开源版的 v0。用一句自然语言描述，生成一个完整的 Next.js 应用，在沙箱里实时预览，通过对话迭代，按版本回滚，最后发布成一个可访问的地址。

## 当前状态

仓库正在重建。旧的实现整体归档在 [archive/paimeng-ai-code-agent/](archive/paimeng-ai-code-agent/)，只作为参考，不是当前事实。新的实现将直接落在仓库根目录，架构与交付顺序见 [docs/architecture.md](docs/architecture.md)。

在新代码落地之前，仓库根没有可运行的 package.json。

## 目录

```
/
├── docs/                    # 架构总述与 ADR
│   ├── architecture.md      # 唯一的架构文档，先读它
│   └── adr/                 # 每个重要决策一条
├── archive/                 # 旧实现，只读参考
│   ├── paimeng-ai-code-agent/   # 基于 pi-durable 的上一版（Next.js）
│   ├── paimeng-ai-code-backend/
│   ├── paimeng-ai-code-mother-frontend/
│   └── paimeng-ai-code-mother-microservice/
├── AGENTS.md                # 仓库导航与协作约定
├── PRODUCT.md               # 产品范围、用户与约束
└── GLOSSARY.md              # 领域术语
```

新代码落地后，根目录还会有 `src/`、`skills/`、`templates/`、`config/`、`migrations/`，职责见 `docs/architecture.md` 的模块边界一节。

## 技术栈

- Next.js（App Router）+ React + TypeScript
- Tailwind CSS + shadcn/ui
- Vercel AI SDK 7，agent 使用 `ToolLoopAgent`
- PostgreSQL + Drizzle ORM
- Docker：沙箱与发布实例

## 文档

- 架构与 13 条验收契约：[docs/architecture.md](docs/architecture.md)
- 产品范围：[PRODUCT.md](PRODUCT.md)
- 术语：[GLOSSARY.md](GLOSSARY.md)
- 决策记录：[docs/adr/](docs/adr/)
