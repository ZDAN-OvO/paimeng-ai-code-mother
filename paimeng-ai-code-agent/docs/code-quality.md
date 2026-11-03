# 代码质量检查

当前产品使用 ESLint 9 flat config、Next.js 官方 Core Web Vitals 规则、typescript-eslint 和 Prettier。不存在适用于所有公司的统一“企业 lint 标准”；这里选择维护方推荐配置，加上适合本项目的异步与类型检查，避免拼接相互冲突的旧规则集。

从 `paimeng-ai-code-agent/` 运行：

```sh
npm run check:fast    # ESLint、Prettier、UI/E2E 写法与模块边界
npm run lint         # 只读检查，任何未豁免的 error 或 warning 都失败
npm run lint:fix     # 自动修复可以安全修复的 lint 问题
npm run format       # 格式化当前产品代码、测试、脚本及配置
npm run format:check # 只检查格式
npm run type-check
```

GitHub Actions 的默认检查执行 lint、格式检查、项目护栏、类型检查和单元测试。已有 pre-commit hook 调用 `check:fast`，因此安装过 hooks 的工作区会自动获得这些检查；其他工作区可以运行 `npm run hooks:install`。pre-push 仍执行类型检查。

## 规则职责

- ESLint 的 JavaScript recommended 规则检查无效控制流、重复定义和其他明显错误。
- Next.js Core Web Vitals 包含 Next.js、React、Hooks 和无障碍检查；Hooks 依赖缺失也提升为 error。
- TypeScript recommended 加上类型感知的 `no-floating-promises`、`no-misused-promises`、`await-thenable`、`no-unnecessary-type-assertion` 和 `only-throw-error`，检查未处理的 Promise、错误的异步回调、不必要的断言等问题。类型信息来自项目的 tsconfig。
- 项目补充严格相等、禁止 `var`、优先 `const`、禁止重复导入和未使用变量检查。允许用 `value == null` / `value != null` 同时判断 `null` 与 `undefined`。未使用的函数参数或异常参数允许使用 `_` 前缀；不允许靠变量名前缀隐藏未使用的局部变量。
- Prettier 单独负责格式，`eslint-config-prettier` 放在 ESLint 配置末尾，关闭冲突的排版规则。使用两空格、单引号、分号、尾逗号、LF 和 100 列换行宽度。`printWidth` 是排版目标，长 URL 或字符串不强制拆断。
- `.editorconfig` 为编辑器提供相同的缩进与换行约定。可启用编辑器的 Prettier 保存时格式化；无需安装 ESLint 的 Prettier 插件。

检查排除构建产物、运行数据、历史文档与原型、版本化生成模板和静态资源。模板会影响用户生成的代码与模板版本，不随平台代码的格式化批量改写；已执行的 SQL 迁移也不改写。具体范围以 [ESLint 配置](../eslint.config.mjs) 和 [Prettier 忽略文件](../.prettierignore) 为准。

## React 存量诊断

初次接入保留 44 条既有诊断，记录在 [eslint-suppressions.json](../eslint-suppressions.json)：29 条 `set-state-in-effect`、10 条 `exhaustive-deps`、4 条 `immutability`、1 条 `refs`。它们涉及现有聊天同步、录音、表单初始化等状态管理，需要分别核对生命周期与业务行为；本次工具接入没有把它们视为已修复，也没有全局关闭这些规则。

使用 ESLint 官方 bulk suppressions，按“文件 + 规则 + 数量”记录存量。新文件的违规、同一文件超过登记数量的违规，以及其他未登记规则的违规都会失败。它不是按源码位置精确匹配：同文件同规则下删除一个旧问题、增加一个新问题，数量不变时可能不会阻断，代码审查仍须检查这种替换。修改这些组件时应修复相关问题，而不是把基线当成永久许可。

修复已有诊断后运行 `npm run lint:prune` 缩减记录。普通 `npm run lint` 会拒绝过时的抑制记录，要求维护基线。不要用 `--suppress-all`、扩大基线或全局关闭规则来让检查通过；新增豁免必须单独说明理由并审查。

少量逐行例外在源码旁写明原因：例如需要登录 Cookie 的图片不能使用服务端图片优化代理，文件名过滤需要匹配控制字符，antd Popconfirm 实际会等待返回的 Promise。无效的 `eslint-disable` 会作为 error 报告。

## 项目 UI 护栏

`check:ui` 的表单绑定检查按 JSX 语法树识别有 `name` 的 `Form.Item`。它拒绝直接的布局包装元素和显式空白表达式，避免 antd 丢失注入的 `value` / `onChange`；普通文案中的 Prettier `{' '}` 不受限制。对应回归用例见 [ui-patterns.test.ts](../tests/unit/infra/ui-patterns.test.ts)。

## 维护依据

- [Next.js ESLint 配置](https://nextjs.org/docs/app/api-reference/config/eslint)
- [typescript-eslint 推荐配置](https://typescript-eslint.io/users/configs/)
- [typescript-eslint 类型感知检查](https://typescript-eslint.io/getting-started/typed-linting/)
- [ESLint bulk suppressions](https://eslint.org/docs/latest/use/suppressions)
- [Prettier 与 linter 集成](https://prettier.io/docs/integrating-with-linters)
