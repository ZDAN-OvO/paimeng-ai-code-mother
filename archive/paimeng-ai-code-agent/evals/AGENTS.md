# evals/

生成 Agent 的测评集与取证流程。这里不是测试套件：`../tests/` 证明代码路径没坏，这里证明用户能完成事。判分标准见 `rubric.md`，运行方法见 `README.md`。

## Layout

```
evals/
├── AGENTS.md     # 本文件：维护规则
├── README.md     # 运行、判分、依据与限制
├── rubric.md     # 门槛、计分与聚合
├── datasets/     # 用例数据；一个套件一个 JSON
├── judge/        # 三个判分提示词
└── scripts/      # validate / run-case / probe / summarize
```

## Rules

- 用例 id 不复用。实质修改 `prompt`、`requirements` 或 `signals` 时换新序号或加 `-r2`；旧运行才保持可比。
- 不为了某次运行通过而删要求、改 `expect` 或把 `NO` 改成 `PARTIAL`。要改就换 id 并写清原因。
- 失败一次就加一条用例；只加能复现的失败，不写猜测。
- 证据写到 `../runtime/evals/`（已 gitignore），不提交截图、转录或临时账号。
- 夹具模型（`AI_MODE=fixture`）只验证管线，不能用来报告生成质量；真实模型运行会消耗 Credit。
- Judge 只看证据，不看模型名；每条判定必须引用文件或字段。先校准再排名。
- 新脚本必须被 `README.md` 或 `package.json` 引用；一次性调查脚本用完删除。
- 提交前跑 `npx tsx evals/scripts/validate.ts` 与 `npx tsx evals/scripts/run-case.ts --case <id> --dry-run`。
