# app-runtime spike

**Throwaway investigation. Not production code, not in the build.**

This directory answers three questions that decide the shape of the App runtime plan. Each answer has a runnable script and raw output; the production implementation is a separate task.

- **S1**: With Workspace and pnpm store on two separate bind mounts, does pnpm still hardlink package files?
- **S2**: Does Vite's dev server, including HMR WebSocket, work behind `/preview/<appKey>/` on one preview origin?
- **S3**: After a shell command returns, can the platform guarantee that no stray process writes the Workspace before committing a Version?

## Reported decisions

1. **S1** — Two bind mounts are kept. The App's pnpm **virtual store lives inside the shared store mount** (`/store/apps/<key>/.paimeng-virtual`); `node_modules` stays in the Workspace and contains symlinks into that virtual store. Package files are hardlinked inside the store mount. The default virtual store (`node_modules/.pnpm`) is **not** used: across the two mounts, `link()` returns `EXDEV` and pnpm copies, doubling disk.
2. **S2** — One preview proxy handles HTTP and WebSocket upgrade. Vite runs with `--base /preview/<appKey>/`; leave `server.hmr.clientPort` unset so the HMR client falls back to the page's proxy port. Two Apps do not share sockets or modules. No path rewriting is needed beyond the proxy prefix.
3. **S3** — Do not rely on the command returning. At every round settle: freeze the dev-server tree (`SIGSTOP`), `SIGSTOP` every non-allowlisted process, then `SIGKILL`, wait for `/proc` to clear, snapshot the Workspace, and stop the dev server. Run the container with a reaper (`--init`) so killed orphans do not accumulate as zombies. The existing `setsid` + process-group watchdog is necessary for timeouts but **not sufficient** at normal return.

## Run it

Prerequisites: Docker, Node 20+, the local spike image, and network for the first pnpm install.

```bash
# Image used by the recorded run (node:24-alpine + git + pnpm 10.18.3).
# The image is local; rebuild and pin a digest for a repeatable production baseline.
docker build -t paimeng-app-runtime:1894779bd433 \
  -f docs/prototypes/in-progress/app-runtime/spike/Dockerfile .

# S1: mounts, pnpm virtual store, inode sharing, concurrent installs
node docs/prototypes/in-progress/app-runtime/spike/s1-hardlinks.mjs

# S2: real Vite 7 dev server + HTTP/WS proxy + Playwright HMR
node docs/prototypes/in-progress/app-runtime/spike/s2-hmr-proxy.mjs

# S3: shell background writers, stop barrier, freeze, reaper, container restart
node docs/prototypes/in-progress/app-runtime/spike/s3-stop-barrier.mjs
```

The scripts are idempotent: they create uniquely named containers, remove them in `finally`, and write results to `evidence/`. Heavy installs and Vite packages live under `/tmp/app-runtime-spike-*`; they are disposable. The recorded run used the image above; a different image or pnpm version changes the numbers.

## Evidence

| File | What it is |
| --- | --- |
| `evidence/s1.json`, `s1-summary.md` | layouts, inode samples, allocated bytes, concurrency, ownership |
| `evidence/s2.json`, `s2-summary.md`, `s2-hmr.png` | HMR timings, WebSocket frames, two-App isolation, SPA deep link, console errors |
| `evidence/s3.json`, `s3-summary.md` | per-scenario late writes, barrier durations, zombies, freeze/resume, container kill/start |

`report.md` interprets the numbers, records the prior branch as prior art, lists limits and rejected alternatives, and states what the plan changes. Read that before changing production code.

## Limits

- The dev server in S3 is a heartbeat HTTP server, not Vite. It proves process control, not that a Vite plugin cannot write while frozen.
- S2 uses a minimal proxy written for the spike, not the product's `preview.ts`. Cookies, host checks, the editor bridge and production CSP still need their own tests.
- S1 is single-user and single-host; the store is shared without per-user isolation. Multi-tenant store isolation is out of scope.
- No real model, Postgres queue, slot scheduler, disk quota, or network-failure injection is exercised here.
- The spike image is a local tag, not a digest-pinned production image. Rebuild and re-measure before setting budgets.

## Status

`in-progress`: the answers feed the app-runtime plan. After the production implementation ships, move this directory to `docs/prototypes/archive/app-runtime/` (or `deprecated/` if the approach is rejected) and record the implementing version in this README.
