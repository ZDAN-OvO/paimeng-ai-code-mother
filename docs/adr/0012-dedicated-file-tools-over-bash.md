# 0012 文件操作走专用工具，Bash 只做通用执行

- 状态：已接受
- 日期：2026-11-08

## 背景

只给一个 Bash，模型也能读写、移动、删除文件。代价是每次操作都靠命令行文本表达：路径越界难拦，覆盖与递归删除难核对，Plan 期间想禁写也只能整条禁掉 Shell。生成代码不可信，这条边界必须在执行器上成立，不能靠提示词。

可选做法：

1. 只提供 Bash，其余能力由命令行拼出来。
2. Bash 加少量工具（Read、Write、Edit）。
3. 八项文件与项目工具成组交付，Bash 只承担通用执行。

## 结论

选 3。M2 一次交付 `read_file`、`write_file`、`edit_file`、`glob_files`、`grep_files`、`move_file`、`delete_file`、`run_command`。所有路径限定在当前 Chat 的 Workspace，源路径、目标路径与符号链接解析都校验；Move 默认拒绝覆盖已有目标，Delete 执行前核对目标与预期修订、递归必须显式声明。

## 后果

- Plan 期间可以按工具粒度收起写操作，不必整条禁用 Shell。
- `list_files` 可保留做目录枚举，但不能替代 Glob 与 Grep。
- Bash 能运行本地 Git，不等于授权远端推送、合并或接入 GitHub 同步（ADR 0006）。
- 专用工具不是隔离边界：真正的隔离仍由 Sandbox 与执行器保证，Bash 遵守同一套权限。
