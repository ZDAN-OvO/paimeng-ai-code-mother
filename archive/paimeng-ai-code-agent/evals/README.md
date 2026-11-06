# 生成质量测评集

这里放的是**派蒙生成 Agent 的测评集与取证流程**，不是单元测试。它回答的问题是：

> 一个不会写代码的用户，用一句中文描述想要的东西，能不能拿到一个能用、能改、能发布的结果？

`tests/` 证明代码路径没坏；`evals/` 证明用户能完成事。两者不互相替代。

## 目录

```
evals/
├── README.md                  # 本文件：怎么跑、怎么判、依据是什么
├── rubric.md                  # 硬门槛、要求分、设计分、过程分与聚合
├── AGENTS.md                  # 维护规则
├── datasets/                  # 41 条用例，按套件分文件
│   ├── smoke.json             # 6 条：四种类型 + 自动选择 + follow-up
│   ├── functional.json        # 10 条：表单、计算、数据、筛选、多页、游戏、预约、购物袋
│   ├── constraints.json       # 8 条：类型冲突、依赖、入口、CDN、密钥、移动端、可访问性、子路径
│   ├── adversarial.json       # 8 条：注入、虚构、不可实现、范围爆炸、越权、提问、隐私、无限循环
│   ├── multiturn.json         # 5 条：追加、改版、选择性回退、steer、版本恢复（后两条手工）
│   └── web.json               # 4 条：事实、图片授权、检索缺口、政策引用（需开启联网）
├── judge/                     # 三个判分提示词
│   ├── requirement.md         # 逐条要求 → YES / PARTIAL / NO / UNKNOWN
│   ├── design.md              # 七个设计维度，0/1
│   └── process.md             # 硬门槛 + 过程检查
└── scripts/
    ├── schema.ts              # 数据形状（数据集与 runner 共用）
    ├── validate.ts            # schema、ID、类型/模板、跨字段一致性
    ├── run-case.ts            # 跑一条用例，收集转录、源码、截图、用量
    ├── probe.ts               # 打开预览地址，抓桌面/手机截图与可访问性信号
    └── summarize.ts          # 读 verdict，按 rubric 算分并输出 summary.json
```

## 数据集覆盖

| 能力 | 覆盖用例 |
|---|---|
| 四种产物类型 + 自动路由 | `smoke-01` ~ `smoke-05` |
| 构建、预览、早期预览 | 所有 runner 用例；P1 过程检查 |
| follow-up 增量与回归 | `smoke-06`、`multi-01` ~ `multi-03` |
| steer / 版本恢复 | `multi-04`、`multi-05`（手工） |
| 提问与回答后继续 | `adv-06` |
| 联网检索、引用、图片导入 | `web-01` ~ `web-04` |
| 平台类型与依赖约束 | `con-01` ~ `con-04`、`con-08` |
| 密钥、隐私、越权、破坏性请求 | `adv-01`、`adv-05`、`adv-07`、`con-05` |
| 虚构与不可实现承诺 | `adv-02`、`adv-03`、`web-03` |
| 范围收敛与预算 | `adv-04`、`adv-08` |
| 移动端与可访问性 | `smoke-02`、`func-01`、`func-07`、`con-06`、`con-07` |
| 状态、持久化、金额格式 | `func-02`、`func-03`、`func-06`、`func-10` |

## 用例字段

```json
{
  "id": "func-01-form-signup",
  "title": "婚礼报名：校验、成功态、手机端",
  "difficulty": "medium",
  "codeGenType": "html",
  "templateId": "html",
  "execution": "runner",
  "tags": ["form", "validation", "mobile"],
  "prompt": "用户原话，最多 1000 字",
  "followUps": [{ "kind": "follow-up", "text": "第二轮用户原话" }],
  "requirements": [
    {
      "id": "R1",
      "evidence": "dom",
      "action": "打开页面",
      "expect": "三个字段与提交按钮都存在，字段有可见标签"
    }
  ],
  "signals": {
    "ask": "forbidden",
    "web": "forbidden",
    "earlyPreview": true,
    "citations": false,
    "maxMinutes": 10
  },
  "notes": "覆盖什么、常见失败是什么"
}
```

- `codeGenType` 与 `templateId` 必须匹配：`html→html`、`multi_file→multi-file`、`vue_project→vue-ts`、`react_project→react-ts`、`auto→null`。
- `followUps.kind` 只能是 `follow-up`、`answer`、`steer`；`answer` 只出现在 `ask=required` 的用例；`steer` 只出现在手工用例。
- `requirements[].evidence` 决定 judge 看哪里：`dom`、`visual`、`source`、`transcript`、`network`、`runtime`。
- `signals.ask`：`forbidden` 不许提问；`required` 必须先问且只问一次；`allowed` 可以问但不纠缠。
- `signals.web`：`forbidden` 不许调用联网工具；`required` 必须实际检索；`citations` 要求可点击来源。
- `maxMinutes` 是**每一轮 Generation** 的生成时长验收上限，不是 runner 的总超时；runner 会多给 60 秒宽限。

## 跑之前

前置条件与开发环境一致，见 [`../scripts/AGENTS.md`](../scripts/AGENTS.md)：

```bash
cd paimeng-ai-code-agent
npm run dev                         # Next 3000 + harness 5599 + 预览 3001
npx playwright install chromium     # 首次
```

模型必须是真实 provider（`AI_MODE=provider`，在管理端配置好模型）。**夹具模型（`AI_MODE=fixture` / `DURABLE_FAUX_FIXTURE=1`）只能验证管线，不能用来比较生成质量**；夹具把需求写进 `<h1>`，任何模型都能「通过」这类检查。

联网套件要求 `.env` 里 `WEB_ACCESS_ENABLED=true`，并确认搜索服务可用。图片用例还需要 `WEB_ACCESS_IMAGES=true`。

本地 `.env` 的限流是 `CHAT_RATE_LIMIT_RATE=30/60s`。如果 follow-up 太快收到 429，调高本机限流或换一个临时账号重跑。

**成本**：每条用例通常产生 1–3 次 Generation，会消耗真实 Credit。建议先跑 `smoke`，确认管线与判分流程，再跑全量。

## 跑一条用例

```bash
npx tsx evals/scripts/validate.ts
npx tsx evals/scripts/run-case.ts --list
npx tsx evals/scripts/run-case.ts --case smoke-01-html-portfolio --dry-run
npx tsx evals/scripts/run-case.ts --case smoke-01-html-portfolio
```

`--base` 默认取 `APP_ORIGIN`。它必须与应用配置的 origin 完全一致（`localhost` 与 `127.0.0.1` 算不同 origin），否则写请求会被来源校验拒绝。

runner 会：

1. 注册一个一次性账号（`eval_…`），登录。
2. 调 `app/add` 创建应用，按用例发送首轮与 follow-up；`answer` 步骤会带上 `expectedQuestionId`。
3. 消费 SSE，等待 `ready` / `failed` / `cancelled`；超时则调用取消。
4. 每一步保存 `events.json`、`generation.json`、`transcript.json`、`accounts.json`、`app.json`、源码副本与预览取证。
5. 不确定的地方停下来：模型提问但用例没有答案、生成失败、预览打不开。

产物在：

```
runtime/evals/<run-id>/<case-id>/
├── case.json
├── result.json
├── credentials.json          # 仅本机，临时账号
├── step-01/
│   ├── events.json           # 工具调用与进度
│   ├── generation.json
│   ├── transcript.json
│   ├── accounts.json         # token、轮次、构建次数
│   ├── app.json
│   ├── probe/
│   │   ├── desktop-full.png
│   │   ├── desktop-fold.png
│   │   ├── mobile-full.png
│   │   ├── mobile-fold.png
│   │   └── probe.json
│   └── source/
└── step-02/ ...
```

`runtime/` 已被 gitignore。证据不提交；需要分享时只给结论与必要截图。

单独取证一个已有预览：

```bash
npx tsx evals/scripts/probe.ts --url http://127.0.0.1:3001/preview/html_123/ --out runtime/evals/manual/probe
```

## 判分

一次运行结束后，对每个用例调用三个 judge：

1. 把 [`judge/requirement.md`](judge/requirement.md) 交给一个具备浏览器能力的 agent，替换 `{{CASE_JSON}}` 与 `{{EVIDENCE_DIR}}`，产出 `verdict-requirements.json`。
2. 用 [`judge/design.md`](judge/design.md) 看截图，产出 `verdict-design.json`。
3. 用 [`judge/process.md`](judge/process.md) 看状态、事件与源码，产出 `verdict-process.json`。
4. 人工抽查 10 条（覆盖 6 个套件），按 [`rubric.md`](rubric.md) 第 7 节校准。

```bash
npx tsx evals/scripts/summarize.ts --run runtime/evals/<run-id>
```

输出逐条表格、按套件的通过率/要求均分/设计均分/过程均分，并写入 `summary.json`。

判分顺序不能反：**先硬门槛，再功能，最后设计与过程**。一个泄密的页面功能全对也是 fail；一个功能全过但视觉平庸的页面仍然是 pass。

## 手工用例

`multi-04-steer` 与 `multi-05-restore-continue` 需要人在界面上卡时机，runner 不代跑。

**steer**：

1. 用 `prompt` 创建应用，进入对话。
2. 等到第一次 `buildPreview` 出现在工具卡片里。
3. 立刻用「插话」发送 `followUps[0].text`，确认它落在同一次 Generation 内。
4. 等 `ready`，对最终预览跑 `probe.ts`。
5. 截图：插话前、插话后、最终页面、带插话标记的对话；写一份 `notes.md` 记录时间点与 Generation id。

**版本恢复**：

1. 发送首轮 prompt，等 `ready`。
2. 在 UI 发送第一条 follow-up（深色开关），等 `ready`。
3. 在版本面板恢复到第 1 版，截图版本列表与恢复确认。
4. 发送第三条 follow-up（统计），等 `ready`。
5. 截图：恢复前、恢复后、第三轮结果、版本历史；对最终预览跑 `probe.ts`。

手工证据建议放在 `runtime/evals/manual/<case-id>/`，同样跑三个 judge。

## 设计依据

这套测评集借用了公开 benchmark 的做法，但不是它们的复刻：

- **[WebGen-Bench](https://arxiv.org/abs/2505.03733)**：把需求拆成「操作 + 预期结果」的测试用例，用浏览器执行；最佳组合也只有 27.8%。本目录的 `requirements[].action/expect` 直接采用这个形状。没有借用它的 101 条固定任务和 VLM 打分，因为产品类型与提示语言不同。
- **[WebDev Arena](https://arena.ai/blog/webdev-arena)**：用真实用户 prompt 而不是合成题；它也暴露了两个问题——单文件限制和 18% 的「两边都坏」。本目录因此保留多文件/工程类型，并把「坏」拆成硬门槛与要求分，而不是只给一个偏好票。
- **[Design2Code](https://arxiv.org/abs/2403.03163)**：视觉质量要看渲染结果，不能只看代码。本目录用桌面/手机截图 + 七维设计 rubric；没有用 CLIP/像素相似度，因为这里没有参考设计稿，用户应用也不该被要求长得像某个模板。
- **[Agent-as-a-Judge](https://arxiv.org/abs/2410.10934)**：agent 产物的验收需要看中间过程与需求级证据，纯 LLM 打分不够。本目录把要求判定、设计、过程拆成三个 judge，并要求每条判定引用证据文件。
- **[SWE-Compass](https://arxiv.org/abs/2511.05459)**：失败最多的两类是需求误解和不完整修复，而不是「不会写代码」。`adversarial` 与 `multiturn` 套件专门覆盖这两类。
- **[Grading methods](https://www.compilenrun.com/docs/ai/agents/agents-evaluation-and-testing/agents-grading-methods/)**：硬门槛决定对错，软 rubric 给质量；部分完成给部分分；成本与延迟单独报告。`rubric.md` 的结构来自这里。
- **[LLM eval patterns](https://www.pathrule.io/patterns/llm-evals)**：能确定性检查的先用确定性检查；judge 要校准；数据集随代码版本化，并从真实失败增长。

平台约束不是网上抄的，来自当前实现：

- 类型规则、首次构建时机、git 只读：`../src/server/generation/prompts/generation-instructions.ts`
- 允许依赖与精确版本：`../src/server/delivery/build-contract.ts`
- 入口、`base: './'`、构建与预览限制：`../docs/artifacts.md`、`../templates/*/AGENTS.md`
- `ready` 不等于有可用预览：`../docs/implementation-contract.md`
- 联网引用与图片授权：`../src/server/generation/tools/web/instructions.ts`
- 提问只能发生在改源码之前：`../src/server/generation/tools/ask-tool.ts`

## 已知限制

- **尚未用真实模型跑全量**。数据集、脚本与判分流程已就绪；第一次运行先跑 `smoke`，确认模型配置、预览与 judge 都成立，再跑其他套件。
- **judge 尚未校准**。先按 `rubric.md` 第 7 节做 10 条人工对照；在完成之前，这套结果只能用于发现回归，不能用于给模型排名。
- **单次运行有随机性**。比较两个模型时至少各跑 3 次，报告区间或逐条稳定性，不要拿一次 pass 率下结论。
- **41 条不是统计样本**。它覆盖的是产品最常坏的路径，不是全部用户需求。
- **web 套件依赖外部服务与时效**。2025 诺贝尔奖、2026 购置税政策会过时；跑之前确认事实仍然成立，或换成年份无关的题。
- **probe 是启发式**。对比度只覆盖纯色背景上的直接文本；图片/渐变背景会跳过或误报；没有做完整 WCAG 审计。
- **runner 不验证所有交互**。它只抓首屏截图，点击、输入、拖拽需要 judge 打开预览实际操作；预览已关闭时只能判 `UNKNOWN`。
- **Credit 未折算**。`accounts.json` 有 token、轮次与构建次数；模型配置 JSON 中的人民币 Token price 会变，这里不硬编码金额。实际结算采用的价格以账单快照为准，见 [ADR-0006](../docs/adr/0006-model-config-document.md)。
- **部署、下载与管理员权限不在本轮范围**。这里只评到「可预览的生成结果」；发布、下载和后台有独立的 E2E 测试。
- **临时账号与应用会留在开发库**。目前不做自动清理，避免误删；需要清理时按账号 `eval_…` 手动处理。

## 加用例

1. 失败一次就加一条；只加能复现的失败，不写「可能会坏」的猜想。
2. 一条要求只测一件事；`action` 写清怎么操作，`expect` 写清观察到什么算过，`partial` 写清差在哪算半分。
3. 新 id 用新序号；不要复用旧 id，也不要在原地改 `expect` 让历史结果看起来变好。
4. 跑 `npx tsx evals/scripts/validate.ts`；再跑一次 `--dry-run` 确认步骤正确。
5. 用真实模型跑通一次，再提交数据集。没跑通的用例先留在本地。
