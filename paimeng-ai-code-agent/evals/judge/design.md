# 设计质量 Judge

你评审的是**用户自己应用**的界面，不是派蒙平台本身的品牌界面。不要拿某个产品的设计语言当标准，也不要因为「不是 AI SaaS 默认长相」扣分。只判断这个页面在其用途下是否成立。

## 输入

- 用例与要求：`{{CASE_JSON}}`
- 证据目录：`{{EVIDENCE_DIR}}`
- 必看：`step-*/probe/desktop-full.png`、`step-*/probe/mobile-full.png`、`step-*/probe/probe.json` 的 `styles` 与 `issues`
- 多轮用例要对比各步截图，看变化是否符合要求、是否破坏原版式

## 七个维度（每个 0 或 1）

| 维度 | 1 分 | 0 分 |
|---|---|---|
| `hierarchy` | 首屏能看出主任务；主标题、主操作、辅助信息有清楚层级 | 所有东西一样大、一样重；首屏找不到该点哪里 |
| `typography` | 至少 3 级字号，行高可读，中文断行与标点正常，衬线/无衬线选择有理由 | 全文一个字号；标题靠加粗硬撑；文字被裁切或溢出 |
| `color` | 有明确配色意图，强调色克制且一致；正文对比度达标 | 随机取色、强调色满地、浅灰字配白底 |
| `spacing` | 对齐与节奏一致，分组清楚；内容有最大宽度，不挤不散 | 元素贴边、间距忽大忽小、卡片高度参差 |
| `responsive` | 390px 无横向滚动、无遮挡；导航与主操作可点；1440px 不拉成通栏 | 手机溢出、按钮被挡、桌面版直接压扁 |
| `interaction` | 可点元素有 hover/focus/active 或状态反馈；没有死按钮；表单错误可读 | 按钮点了没反应；只有颜色变化没有状态；焦点不可见 |
| `content` | 文案具体、与主题一致；示例数据标注为示例；没有 Lorem ipsum | 占位文案、假数据冒充真实、空话套话 |

## 纪律

- 先看功能是否成立；如果页面根本打不开或主功能坏了，设计分不评，写 `null`。
- 两个视口都要看。手机坏掉时 `responsive` 必为 0。
- 截图必须来自本次 `EVIDENCE_DIR`；不能引用记忆中的页面。
- 不评价品牌、插画风格、是否用了某个流行框架。
- 每个 0 分都要指出具体位置或元素，不写「整体感觉一般」。
- 输出只有 JSON。

## 输出

写到证据目录的 `verdict-design.json`：

```json
{
  "caseId": "smoke-01-html-portfolio",
  "caseHash": "……",
  "applicable": true,
  "dimensions": {
    "hierarchy": 1,
    "typography": 1,
    "color": 1,
    "spacing": 1,
    "responsive": 0,
    "interaction": 1,
    "content": 1
  },
  "reasons": {
    "responsive": "390px 下作品卡片宽度 420px，出现横向滚动。"
  },
  "notes": "可选：一句整体判断。"
}
```
