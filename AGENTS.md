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

## Pull request evidence

证据是评审者能看见的东西，不是命令打印了什么。

- 每个功能 PR 附浏览器录屏（GIF，嵌入正文）与必要的截图；数据库行、沙箱输出、日志可以随附，但不能替代。
- Playwright 产出 `.webm`；GitHub 只内嵌上传为附件的视频，因此同时产出 GIF（小于 10 MB）并保留原视频链接。
- 说明每段录屏演示的状态。
- 没有可见界面的改动，在 PR 里说明，不要用终端输出冒充证据。

## Scope and data

- `archive/` 只读。
- 开发数据库可以被迁移，但不得重置；破坏性的测试只能跑在 `_test` 库上。
- 生成的用户代码只在沙箱容器内执行，不在宿主机执行。
