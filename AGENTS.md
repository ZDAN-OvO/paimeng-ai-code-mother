# paimeng-ai-code-mother

开源版 v0：一句话生成完整的 Next.js 应用，沙箱预览，对话迭代，发布。

## Layering

```
/
├── AGENTS.md          # this file: repo navigation and collaboration rules
├── PRODUCT.md         # product scope, users, constraints
├── GLOSSARY.md        # domain terms; `_Avoid_` lines list the synonyms not to use
├── docs/              # architecture.md and adr/
├── archive/           # old implementations, read-only reference; never current truth
└── src/, skills/, templates/, config/, migrations/   # the product, once it lands
```

新代码直接位于仓库根。`archive/` 里的任何东西都不参与构建、不被新代码导入。

## Source of truth

- 架构与验收契约只在 `docs/architecture.md`。决策的理由在 `docs/adr/`，不在别处复述。
- 术语以 `GLOSSARY.md` 为准。
- 不把代码能表达的东西写进文档；文档只解释为什么。
- 文档与契约、验收入口、证据三者由 `npm run check:docs` 检查：路由与 13 条在两份文档里对齐，`docs/evidence/INDEX.md` 里每条承诺的证据不能过期。改完先跑它，红了不提交。
