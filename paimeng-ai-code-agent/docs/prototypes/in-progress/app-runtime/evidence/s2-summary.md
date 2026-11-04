# S2 结果：Vite HMR 经过 `/preview/<appKey>/` 子路径代理

- Vite 7.0.0，Chromium 153.0.8010.12，代理端口 3101
- HMR 端口策略：__HMR_PORT__ 未设置（只传 --base），客户端回退到页面端口 3101
- 首次加载：marker=first-A，bridge=true，booted=yes
- 5 次 HMR：56ms / 59ms / 61ms / 59ms / 56ms；探针保留=hmr-no-reload
- WebSocket：ws://127.0.0.1:3101/preview/react_project_700000001/?token=tZKEKZw14QI7；帧数 6；update 帧=true
- 第二个 App：marker=first-B，HMR 后探针=b，串流=false
- SPA 深链：status=200，marker 可见=true
- 错误：pageErrors=0，requestfailed=0，consoleErrors=0

