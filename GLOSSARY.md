# Paimeng 术语

## 产品结构

**Project**：一个产品，拥有自己的发布地址与环境变量。一个 Project 可以有多个 Chat。
_Avoid_：应用、App、站点。

**Chat**：一条对话线，属于一个 Project，或者在还没有 Project 时作为 Draft 存在。每次生成、每次迭代都发生在一个 Chat 里。
_Avoid_：会话、对话（在指代数据实体时）。

**Draft**：还没决定要不要变成项目的 Chat。首页一句话先开 Draft 并照常生成；用户满意后点「创建项目」，Draft 原地转成 Project（Chat 与 Version 都不复制）。Draft 没有发布地址与环境变量。
_Avoid_：临时项目、草稿项目、未完成项目。

**Archive**：把会话从默认列表里收起来，不是删除。归档后仍能在「对话 → 归档」里找到并恢复，版本、发布地址都不受影响。
_Avoid_：删除、丢弃。

**Message**：Chat 里的一条消息，结构是 AI SDK 的 `UIMessage` parts。用户消息与助手消息同表，用 `seq` 排序。
_Avoid_：记录、条目。

**Version**：一条助手消息结束后产生的源码快照。版本线是线性的；回滚会追加一个新版本，不修改历史。
_Avoid_：快照版本号、commit。

**Snapshot**：Version 在磁盘上的源码树副本，保存在宿主机，不含 `node_modules` 与 `.next`。
_Avoid_：备份、存档。

**Template**：内置的起始项目，新建 Draft 时选择，转正时带入 Project。用户不能发布模板。
_Avoid_：脚手架、starter。

## 生成与技能

**Skill**：一个目录，包含 `SKILL.md`（frontmatter 有 name 与 description）以及可选的 `references/` 与 `scripts/`。Skill 决定这一轮该怎么做，工具决定能做什么。
_Avoid_：插件、能力、tool。

**Built-in skill**：随仓库发布的 Skill，位于 `skills/`，只读。

**User skill**：用户自建或导入的 Skill，位于 `data/users/<userId>/skills/`。

**Trust**：用户导入 Skill 时的显式确认。未信任的 Skill 不执行任何脚本。

**Skill router**：由生成模型自己完成的路由：描述常驻 system prompt，正文通过 `load_skill` 按需加载。
_Avoid_：分类器、意图识别。

**Tool**：模型可以调用的函数，例如读文件、写文件、运行命令、抓取网页。工具不承载任务策略。

**Design mode**：在预览里点选元素，读出该元素的源码位置，生成一句指向该组件的对话输入。

## 运行

**Sandbox**：每个 Chat 一个的 Docker 容器，承载工作区与 `next dev`。默认禁出站。
_Avoid_：容器（在指代这一概念时）、执行环境。

**Workspace**：Sandbox 里生成项目的目录，挂载为命名卷。

**Preview**：通过宿主机反向代理访问沙箱里 `next dev` 的页面。

**Deploy**：把某个 Version 的构建产物放进只读容器并对外提供访问。发布地址是 `/deploys/<deployKey>`。
_Avoid_：上线、部署（在指代数据实体时）。

**Deploy key**：发布地址里的不可猜测标识。

**Runner**：运行发布产物的通用镜像，与应用镜像分开。

## 模型

**Provider**：一个模型服务，包含 baseURL、协议与密钥的环境变量名，声明在 `config/providers.json`。

**Model**：Provider 下的一个具体模型，用户在 Chat 里可以切换。

## 不做

**Durable execution**：本产品不做进程重启后的自动续跑。中断即失败，用户重试。
