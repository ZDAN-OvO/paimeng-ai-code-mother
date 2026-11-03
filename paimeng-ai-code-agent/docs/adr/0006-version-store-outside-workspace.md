# Version store outside the Workspace

- Status: accepted
- Date: 2026-11-02

## Context

Version history used to be a normal Git repository at `<workspace>/.git`, and the agent's git tool ran in the Workspace. The next step gives each App a runtime container that bind-mounts the Workspace and exposes a shell. Any file inside that mount would then be writable by model-run commands, including `.git`: a command could rewrite refs, replace hooks, or commit a different tree than the platform records. Version identity and "restore an old version" are only trustworthy if the process producing files cannot change the history that names them.

## Decision

Each App's version history is a bare repository owned by the platform at `runtime/versionstore/repos/<codeGenType>_<id>.git`. The Workspace is its worktree and contains no `.git` directory or file.

- The platform commits from the Workspace or an isolated execution directory through a temporary index (`GIT_INDEX_FILE`), so committing never depends on a writable index inside the mounted tree either.
- The history-only-grows hook (`reference-transaction`) is installed in the platform repository's `hooks/`, not in the Workspace. Read-only git tools and version details/download read the same platform repository.
- Every commit entry point enforces one quota over the whole worktree diff: at most 1,000 changed files, 50 MiB total and 10 MiB per file by default, configurable through `COMMIT_MAX_FILES`, `COMMIT_MAX_BYTES` and `COMMIT_MAX_FILE_BYTES`. Dependencies, build output and platform metadata are excluded from the diff before counting. Exceeding the quota throws a readable Chinese reason before any commit object, pin, head move or ledger row exists, and leaves the Workspace untouched.
- Repositories created by the previous layout are moved into the platform location on first use; their history is preserved, and the Workspace copy is removed. Bulk migration of existing App data remains out of scope.

## Alternatives considered

- Keep `.git` in the Workspace and rely on the git tool's argument allowlist: the upcoming shell can run `git` directly, so a tool-level allowlist no longer bounds what the model can do.
- Mount only a subdirectory into the runtime and keep `.git` beside it: the Workspace is also the persistent source tree used by uploads, downloads and snapshots; splitting it would create two roots for the same App.
- Make the repository bare but keep commits through the default index: a concurrent direct disk write and a platform commit could interleave through shared index state. A per-commit temporary index keeps the two independent.

## Consequences

- The git tool must pass `--git-dir <platform repo> --work-tree <tree>`; assuming `git -C <workspace>` works is now a bug.
- Runtime containers and shell commands cannot see or modify version objects, refs or hooks even though they can write source files.
- Commit size is a platform invariant rather than a convention, so the same failure appears for file-tool writes, direct disk writes and future shell writes.
- Losing the platform version directory loses history; this is now platform-owned data and belongs in backup/cleanup paths such as `purgeVersions`.
- Tests that inspect history must use the platform repository path instead of `<workspace>/.git`.
