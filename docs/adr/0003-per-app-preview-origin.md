# 每个应用使用独立的预览来源，经网关鉴权

预览页面运行的是不可信代码，因此每个应用使用独立来源 `app-{appId}.preview.<domain>`，由后端预览网关按应用 ID 转发，不同应用、主站和预览之间不共享 cookie，也不能访问彼此的 DOM。预览通过主站签发的 60 秒单次票据换取该来源的 host-only cookie，每个请求和 WebSocket 都重新校验所有者、主站 session 和应用状态。代价是需要泛域名解析、额外的授权往返，并且放弃直接读取 iframe DOM 的可视化编辑。

## Considered Options

- 主站同源路径（`/preview/{appId}`）：部署简单，但预览脚本能读写主站 cookie 和 DOM。
- 所有应用共用一个预览来源：能隔离主站，但应用之间可以互相读取存储和发起请求。
- 把票据放在 URL 里：实现简单，但票据会进入资源 URL、Referer 和访问日志。
