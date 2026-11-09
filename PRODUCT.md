# Product

## Platform

web

## Stack

Next.js（App Router）+ React + TypeScript，代码位于仓库根。Tailwind CSS + shadcn/ui。Vercel AI SDK 7 的 `ToolLoopAgent`。PostgreSQL + Drizzle。Docker 承载沙箱与发布实例。旧实现位于 `archive/paimeng-ai-code-agent/`，只作为参考。

## Users

没有编程能力、但有明确界面或应用想法的人：独立经营者、小团队创始人、设计师、内容创作者、运营人员。他们在浏览器里用中文描述想要的东西，希望立刻看到一个能点击的版本，再通过对话修改，最后拿到一个可以公开访问的网址。

## Product Purpose

把一句自然语言描述变成一个可用、可预览、可修改、可发布的 Next.js 应用。产品的成功不是生成了一段代码，而是用户在不写代码的情况下得到第一版、看懂它、改到满意，并把它发布出去。

## Positioning

开源、可自托管、单用户优先。不追 SaaS 的协作与计费，追的是「clone 下来就能用」和「生成的应用真的跑得起来」。

## Operating Context

- 首页：描述需求、选择内置模板、浏览自己的项目。
- 项目：一个 Project 拥有多个 Chat，多个 Chat 共用一个发布地址。
- 对话：流式输出、工具调用状态、代码面板、实时预览、版本切换。
- 版本：每条助手消息一个版本，可看 diff、可回滚，回滚追加新版本。
- 发布：得到一个 `/deploys/<deployKey>` 地址；回滚后重新发布即生效。
- Design mode：点选预览元素，生成一句指向该组件的对话输入。
- 技能：内置技能与用户自建技能同一套加载机制，按需加载正文。

## Scope

13 条验收契约见 `docs/architecture.md` 第 2 节。每条以「能在浏览器里演示的路径」为完成标准。

明确不做：多人协作与邀请、Figma 导入、Vercel 一键部署、GitHub PR 导出、数据连接向导、计费与额度、组件市场、移动端 App、公开模板画廊。

## Capabilities and Constraints

- 单用户本地优先，不做注册登录；产品默认只监听 `127.0.0.1`。
- 生成的应用只在 Docker 沙箱内运行，沙箱默认禁出站。
- 模型密钥只放在环境变量，不写入数据库、不写入镜像。
- 不做持久化执行：进程中断即失败，用户重试。
- 不引入付费服务作为必需依赖；可选集成必须可关闭。

## Brand

- 产品名：**Paimeng**，中文名保留「派蒙」。
- 界面结构与交互对齐 v0：三栏（对话、预览、代码）、版本条、发布按钮。视觉使用 shadcn/ui 默认体系，不做像素级复刻。
- 中文优先，语气直接、克制、具体。

## Evidence on Hand

- `docs/architecture.md`：架构、13 条验收契约、交付顺序。
- `docs/adr/`：每个重要决策的背景与后果。
- `archive/paimeng-ai-code-agent/`：上一版的实现与踩坑记录，仅作参考。
