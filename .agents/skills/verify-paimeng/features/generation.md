# 生成与预览

用户注册登录后，在首页输入一句话创建应用，平台排队、运行 Agent、写出静态页面，并在独立来源的 iframe 里显示预览；刷新后历史与预览都还在。

## Sub-features

- `gen-register` 在注册页创建账号并跳回登录页。
- `gen-login` 登录后进入首页。
- `gen-create` 首页提交需求，创建应用并进入对话页，首条消息入队。
- `gen-complete` 运行到 `completed`，对话显示最终回复。
- `gen-preview` iframe 来源为 `app-{appId}.preview.*`，与主站不同源，显示生成内容。
- `gen-reload` 刷新后最终回复、用户需求与预览都恢复。

## How to get to it (user POV)

- 打开 `/user/register` 注册，再到 `/user/login` 登录。
- 首页需求输入框填写需求，点 `开始创建`。
- 进入 `/app/chat/{appId}` 对话页，右侧看预览。

## Driving it with pnpm verify

Preconditions:

- `pnpm verify doctor` 为 `ok:true`。
- 固定模型场景 `normal`，提示词为 `创建一个静态页面，页面标记为 <marker>`。

- **注册。** `/user/register` 填 `请输入账号`、`请输入密码`、`请确认密码`，点角色按钮 `注 册`。URL 变为 `/user/login`。
- **登录。** 填 `请输入账号`、`请输入密码`，点按钮 `登 录`。出现标题 `把一句话，变成能用的应用`。
- **创建。** 在占位 `例如：做一个可以添加、勾选和删除任务的待办清单，中文界面` 填提示词，点 `开始创建`。`POST /api/app/chat/queue` 返回 200、`code:0`，URL 匹配 `/app/chat/\d+`。
- **完成。** 轮询 `/api/app/run/status?appId=…&clientRequestId=…` 到 `completed`。页面出现 `页面已完成 <marker>` 与 `预览运行中`；`iframe[title="应用预览"]` 内有标题 `<marker>`；模型 stats `calls` 为 `['update_plan','write']`。
- **独立来源。** iframe `src` 的 hostname 为 `app-{appId}.<previewDomain>`，origin 不等于主站。
- **刷新。** `page.reload()` 后上述完成态仍成立，用户提示词可见，模型总请求数 `requests` 为 3（刷新没有触发新运行）。
- **执行。** `pnpm verify run generation`。退出码 0，`manifest.ok:true`，`artifacts/generation-*/trace.zip` 与 `test-finished-1.png` 存在。

## Gotchas

- 预览里的 `<marker>` 来自固定模型写的静态 HTML，只证明链路，不证明真实模型能写出好页面。
- Docker 被审计替身拦截，预览来自静态文件服务，不是容器构建产物；Vue/React 模板不在此覆盖。
- spec 在刷新后断言模型 `requests` 恰为 3。不等于 3 就按失败汇报并附上模型 stats，不改成大于等于。
- 注册与登录按钮文字中间有空格（Ant Design 双字按钮），选择器用 `/^注\s*册$/`、`/^登\s*录$/`。
