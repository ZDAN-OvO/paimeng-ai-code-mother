# Git Identity

Who pushes to this repository, and why the answer depends on which directory you are in.

## Two identities

| Actor | GitHub identity | Where it comes from |
| --- | --- | --- |
| Human | `ZDAN-OvO` (personal account, repository admin) | `gh auth git-credential`, inherited from global git config |
| Agent | `zdan-coding-agent[bot]` (GitHub App, id 5556324) | installation token minted on demand by `~/.config/github-app/git-credential-github-app.mjs` |

The split is enforced by **directory**, not by discipline: the App credential helper and the bot
author identity live only in the agent worktree's own config file
(`.git/worktrees/<name>/config.worktree`). Every other directory — the main working copy and the
other worktrees — resolves to the personal account.

```
/home/zdan/github/zdan/paimeng-ai-code-mother    main checkout   → personal
/home/zdan/github/zdan/wt-paimeng/agent         agent worktree  → App
/home/zdan/github/zdan/wt-paimeng/*             other worktrees → personal
```

Nothing about the App is stored in `.git/config` or `~/.gitconfig`. The single shared setting is
`extensions.worktreeConfig = true`, a switch that makes git read per-worktree config; it carries no
identity.

## Repository rule

The `protect-main` ruleset (target `~DEFAULT_BRANCH`) rejects direct pushes to `main`: changes must
arrive through a pull request, fast-forwards only, no deletions. Its bypass list contains
**Repository admin** with `always`, i.e. the human owner. The App is not a repository admin and holds
only `contents:write`, `pull_requests:write`, `metadata:read`, so it can never satisfy the bypass —
an agent that pushes `main` fails with `GH013 … Changes must be made through a pull request`
regardless of how the rule is configured for admins.

## Rules for agents

1. Run every git write inside the agent worktree. `git` commands in the main checkout run as the
   human; using them there means impersonating the owner.
2. Push branches only (`agent/*`-style names). Never push `main`.
3. Open PRs and call the API with `~/.config/github-app/gh-app.mjs`, not bare `gh` — bare `gh` uses
   the human's token, and the PR would be authored by the owner instead of the bot.
4. Do not add `credential.helper` to `.git/config`, `~/.gitconfig`, or a `.git/worktrees/*` config of
   a worktree you did not create for this purpose. `.git/config` is shared by every worktree, so one
   line there silently rewrites the human's identity too.

## Verifying which identity is active

```bash
printf 'protocol=https\nhost=github.com\npath=ZDAN-GHN/paimeng-ai-code-mother.git\n\n' | git credential fill | grep username=
# x-access-token                → App
# ZDAN-GHN (any username)       → personal
```

`git config user.email` tells you who authors new commits: the bot address ends with
`+zdan-coding-agent[bot]@users.noreply.github.com`.

## Recreating the agent worktree

Per-worktree config disappears when the worktree is removed, so re-apply it after
`git worktree add`:

```bash
git config --local extensions.worktreeConfig true          # once per repository
git worktree add ../wt-paimeng/agent -b agent/work main
cd ../wt-paimeng/agent
git config --worktree credential.https://github.com.useHttpPath true
git config --worktree --add credential.https://github.com.helper ''   # required, see below
git config --worktree --add credential.https://github.com.helper '!~/.config/github-app/git-credential-github-app.mjs'
git config --worktree user.name 'zdan-coding-agent[bot]'
git config --worktree user.email '5556324+zdan-coding-agent[bot]@users.noreply.github.com'
```

The empty `helper =` line is not optional. Credential helpers accumulate across config scopes and
are consulted in order, so without a reset the global `gh` helper answers first and the worktree
silently pushes as the human while looking configured.

## Failure modes

- `GH013 … pull request` while the human is pushing: the push ran as the bot. Check
  `git credential fill` before suspecting the ruleset.
- `不在 allowlist 里` from the helper: `~/.config/github-app/config.json` lists `owner/repo` pairs;
  it must contain the name in `origin`. The helper fails closed rather than falling back to the
  personal account, so a renamed or transferred repository needs an allowlist update.
- Push rejected as non-fast-forward from the agent worktree: the branch is stale relative to `main`;
  fetch and rebase instead of force-pushing a branch someone may have reviewed.
