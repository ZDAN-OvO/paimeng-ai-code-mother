# 0005 提供商模型身份与按模型计价

状态：已接受。
日期：2026-11-02。

## 背景

模型配置过去把「提供商 + 请求模型名 + 能力 + 调用参数」存在槽位行（`model_alias`）上，费率也按 `(provider_id, model_name)` 字符串匹配。这带来三个实际问题：

- 不同提供商下的同名模型没有共同可引用的身份，槽位、费率和运行用量只能靠字符串对齐；上游响应名一变化，历史关联就可能断掉。
- 同一模型被多个槽位共用时，能力被重复声明；槽位要求与能力声明只能靠表单互相对齐。
- 改价、换槽位或换提供商时，无法稳定回答「这次运行当时用的是哪条价格」。

计划与迁移设计见 `docs/plans/provider-model-billing.md`。

## 决策

1. **新增 `provider_model`**：提供商下已登记的请求模型，雪花 BIGINT 主键，对外为十进制字符串。`(provider_id, upstream_model_name)` 唯一，按原始字符串区分大小写；`provider_id` 与 `upstream_model_name` 创建后不可变。改名或换请求名登记另一条记录。
2. **槽位引用模型**：`model_alias.provider_model_id` 是槽位的唯一模型身份。能力（streaming / toolCalling / structuredOutput / imageInput）与兼容声明（`reasoningContentPassthrough`）属于模型；temperature / topP / maxOutputTokens / reasoning 仍属于槽位。旧的 provider/name/capabilities 列保留为兼容投影，不再是独立真值。
3. **统一解析**：`src/server/models/resolver.ts` 在同一个配置快照上组装提供商连接、模型能力/兼容与槽位参数；Next adapter、harness adapter 与语音转写共用它。缺少槽位、停用模型、引用断开或能力不满足都返回可读的 503/50300。
4. **费率按模型 ID**：`credit_rate_card.provider_model_id` 与生效时间共同定位版本；新写入只接收模型 ID，`provider_id` / `model_name` 由服务端派生。`(provider_model_id, effective_from)` 在非空值上唯一。
5. **运行身份固定**：`generation_step.provider_model_id` 记录配置身份；`model_name` 保存配置请求名，上游实际响应名只写入 `upstream_provider` / `upstream_model_id`。产品库运行描述 `app.run-model` 增加可选的 `providerModelId` 与 `compatibility`。
6. **计费按步骤时间**：有模型 ID 的步骤只按该 ID 和步骤发生时间取价；查不到即待处理，不回退到响应名或当前槽位。没有 ID 的历史步骤保留原来的字符串候选分支，作为明确兼容路径。
7. **历史数据不重写**：旧费率行保留 NULL 模型 ID，显示为「历史费率，未关联模型」；旧步骤保持未关联。回填工具默认 dry-run，冲突不吞，不触碰账单与结算。
8. **过渡写入口**：P5 之前旧页面仍可补历史费率或调整槽位；已登记模型的当前/未来旧写法被拒绝。P5 界面切换后，服务端旧写入口作为过渡保留，最终随兼容分支一起移除。

## 后果

- 管理流程变成「提供商 → 登记模型 → 分配槽位 → 配置费率」；同名跨提供商可并存，槽位切换只影响新绑定。
- 新运行的步骤和账单快照带模型 ID；已计价事实不因改配置重算，补结算按 ID 与 stepId 去重。
- 旧运行描述可由新代码读取；新描述带可选字段，回退到旧代码会读不懂新字段，回退前需要暂停新提交。
- 迁移必须按「新增结构 → 预检 → 受控回填 → 同版本部署 → 核验」执行，旧费率不会被自动套到新模型上。

## 替代方案

- **只加一个全局模型目录**：不同提供商的同名模型仍必须合并，无法表达「同一模型名在两个网关下不同价格」，放弃。
- **继续用字符串匹配并加更多候选键**：无法稳定区分同名跨提供商，也无法阻止响应名漂移，放弃。
- **把能力和参数全部放在槽位**：同一模型被多槽位共用时继续重复声明，且无法在模型详情上统一改价，放弃。
