import 'server-only';
import { createServer, request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import { readFile, lstat, realpath } from 'node:fs/promises';
import { join, relative, isAbsolute, extname, resolve } from 'node:path';
import { getConfig } from '../infra/config';
import { ensureSafeDirectory, validateDeployKey } from '../workspace/workspace';
import { currentDelivery, legacyDelivery, resolveDelivery } from './delivery-store';
import { appHasWriteAuthority } from '../app-runtime/store';
import { runtimePreviewTarget } from '../app-runtime/supervisor';
import type { CodeGenType } from '@/shared/contracts';
import { maxSelectedElements } from '@/shared/element-selection';

const mime: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
};

/** 静态资源的 Content-Type；未知扩展名返回 null（调用方决定 404 还是拒绝）。 */
export function contentType(path: string) { return mime[extname(path)] ?? null; }

/**
 * 预览里的可视化编辑桥接。`locked` 是「这一轮 Generation 仍持有写权限」：
 * 锁住时任何 TOGGLE_EDIT_MODE 都不会真正打开悬浮/选中，元素选择与编辑在生成期间是只读的。
 */
function editorBridge(parentOrigin: string, locked = false) {
  return `<script data-paimeng-editor>(function(){
  var parentOrigin=${JSON.stringify(parentOrigin)};
  // 初始锁来自服务端（文档在生成期间加载时必须只读）；宿主页随后可以用 locked 字段解锁/重锁，
  // 因为同一个文档会跨过生成收束，不能只在 HTML 里定格一次。
  var locked=${locked ? 'true' : 'false'};
  var MAX_SELECTED=${maxSelectedElements};
  var HOVER='paimeng-edit-hover';
  var SELECTED='paimeng-edit-selected';
  var STYLE_ID='paimeng-editor-style';
  var enabled=false;
  // 供宿主页与验收断言读取的桥接状态：ready / locked / on。没有它只能靠悬浮样式猜。
  var mark=function(state){try{document.documentElement.dataset.paimengEditor=state;}catch(e){}};
  mark(locked?'locked':'ready');
  var hovered=null;
  var selected=[];
  function styleOnce(){
    if(document.getElementById(STYLE_ID))return;
    var style=document.createElement('style');
    style.id=STYLE_ID;
    style.textContent='.'+HOVER+'{outline:2px dashed #1890ff !important;outline-offset:2px !important;cursor:crosshair !important}.'+SELECTED+'{outline:3px solid #52c41a !important;outline-offset:2px !important;cursor:default !important}';
    (document.head||document.documentElement).appendChild(style);
  }
  function clearHover(){if(hovered){hovered.classList.remove(HOVER);hovered=null;}}
  function clearSelected(){for(var index=0;index<selected.length;index++)selected[index].classList.remove(SELECTED);selected=[];}
  function clearAll(){clearHover();clearSelected();}
  function classListOf(element){return typeof element.className==='string'?element.className.split(/\\s+/).filter(Boolean):[];}
  function selectorFor(element){
    var parts=[];
    var current=element;
    while(current&&current!==document.body&&current.nodeType===1){
      var part=current.tagName.toLowerCase();
      if(current.id){parts.unshift(part+'#'+CSS.escape(current.id));break;}
      var classes=classListOf(current).slice(0,3);
      if(classes.length)part+='.'+classes.map(function(name){return CSS.escape(name);}).join('.');
      var parent=current.parentElement;
      if(parent){
        var siblings=Array.prototype.filter.call(parent.children,function(child){return child.tagName===current.tagName;});
        part+=':nth-of-type('+(siblings.indexOf(current)+1)+')';
      }
      parts.unshift(part);
      current=parent;
    }
    return 'body>'+parts.join('>');
  }
  function elementInfo(element){
    return {
      tagName:element.tagName.toLowerCase(),
      id:element.id||'',
      className:(typeof element.className==='string'?element.className:'').trim().slice(0,512),
      textContent:(element.textContent||'').trim().slice(0,2000),
      selector:selectorFor(element),
      pagePath:location.pathname+location.hash
    };
  }
  function reportSelected(){parent.postMessage({type:'ELEMENTS_SELECTED',elements:selected.map(elementInfo)},parentOrigin);}
  function toggleSelected(element){
    var index=selected.indexOf(element);
    if(index>=0){selected.splice(index,1);element.classList.remove(SELECTED);reportSelected();return;}
    if(selected.length>=MAX_SELECTED){parent.postMessage({type:'SELECTION_LIMIT',max:MAX_SELECTED},parentOrigin);return;}
    selected.push(element);element.classList.add(SELECTED);reportSelected();
  }
  window.addEventListener('message',function(event){
    if(event.source!==parent||event.origin!==parentOrigin||!event.data||typeof event.data!=='object')return;
    if(event.data.type==='TOGGLE_EDIT_MODE'){
      if(typeof event.data.locked==='boolean')locked=event.data.locked;
      enabled=!locked&&event.data.editMode===true;
      if(enabled)styleOnce();
      mark(locked?'locked':(enabled?'on':'ready'));
      clearAll();
    }else if(event.data.type==='CLEAR_ALL_EFFECTS'){
      enabled=false;clearAll();
    }else if(event.data.type==='CLEAR_SELECTION'){
      var selector=event.data.selector;
      if(typeof selector==='string'){
        for(var index=selected.length-1;index>=0;index--){
          if(selectorFor(selected[index])===selector){selected[index].classList.remove(SELECTED);selected.splice(index,1);}
        }
      }else clearSelected();
    }
  });
  document.addEventListener('mouseover',function(event){
    if(!enabled||!(event.target instanceof HTMLElement))return;
    var target=event.target;
    if(target===document.body||target===document.documentElement)return;
    if(target.tagName==='SCRIPT'||target.tagName==='STYLE')return;
    if(target===hovered||selected.indexOf(target)>=0)return;
    clearHover();
    target.classList.add(HOVER);
    hovered=target;
  },true);
  document.addEventListener('mouseout',function(event){
    if(!enabled)return;
    var target=event.target;
    if(!(target instanceof HTMLElement))return;
    if(!event.relatedTarget||!(target.contains(event.relatedTarget)))clearHover();
  },true);
  document.addEventListener('click',function(event){
    if(!enabled||!(event.target instanceof HTMLElement))return;
    event.preventDefault();event.stopPropagation();
    var target=event.target;
    if(target===document.body||target===document.documentElement)return;
    if(target.tagName==='SCRIPT'||target.tagName==='STYLE')return;
    clearHover();
    toggleSelected(target);
  },true);
  parent.postMessage({type:'EDITOR_READY'},parentOrigin);
})();</script>`;
}

/** `/preview|delivery/<codeGenType>_<appId>/...` 里的应用标识。 */
function appFromKey(key: string): { id: string; codeGenType: CodeGenType } {
  const match = key.match(/^(html|multi_file|vue_project|react_project)_([1-9]\d{0,19})$/);
  if (!match) throw new Error('应用标识不合法');
  return { codeGenType: match[1] as CodeGenType, id: match[2] };
}

export type DevServerTarget = { status: 'ready' | 'starting' | 'failed'; port: number | null };
type PreviewApp = { id: string; codeGenType: CodeGenType };

export type PreviewServerOptions = {
  runtimeRoot?: string;
  /** 解析某个 App 的 dev server；默认读 runtime 台账并探测端口。测试可以注入固定目标。 */
  devServerFor?: (app: PreviewApp) => Promise<DevServerTarget | null>;
  /** 这一轮 Generation 是否仍持有写权限：为 true 时预览只读。 */
  writeAuthorityOf?: (app: PreviewApp) => Promise<boolean>;
  /** dev server 解析结果的缓存时长；默认 1 秒，测试传 0。 */
  devServerCacheMs?: number;
};

const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'te', 'trailer', 'upgrade', 'proxy-authenticate', 'proxy-authorization', 'set-cookie', 'content-length']);

function proxyHeaders(headers: import('node:http').IncomingHttpHeaders) {
  return Object.fromEntries(Object.entries(headers).filter(([name, value]) => value !== undefined && !HOP_BY_HOP.has(name.toLowerCase())));
}

/** dev server 模式的 CSP：允许 Vite 的内联模块、HMR websocket 与同源资源；仍然禁止嵌套页面与表单外发。 */
function devCsp(appOrigin: string) {
  return `default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' data: https://fonts.gstatic.com; img-src 'self' data: blob: https:; connect-src 'self' ws: wss:; worker-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'self'; frame-ancestors ${appOrigin}; sandbox allow-scripts allow-same-origin allow-forms allow-popups allow-modals`;
}

function injectBridge(html: string, parentOrigin: string, locked: boolean) {
  const script = editorBridge(parentOrigin, locked);
  return /<\/body>/i.test(html) ? html.replace(/<\/body>/i, script + '</body>') : html + script;
}

/** 运行时还没给出 dev server 时的明确状态；不把 Docker/代理的内部错误透给浏览器。 */
function runtimeStatusPage(status: 'starting' | 'failed') {
  const text = status === 'starting'
    ? '应用运行时正在启动，页面稍后自动出现。生成中的改动会实时显示在这里。'
    : '应用运行时暂时不可用，仍可查看上一次构建的页面。可以重新发送消息再试。';
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>应用运行时</title></head><body data-paimeng-preview-state="${status}" style="font-family:system-ui;background:#fff6f1;color:#3d3d3d;margin:0"><main style="max-width:560px;margin:18vh auto;padding:32px;text-align:center"><h1 style="font-size:18px;font-weight:600">${status === 'starting' ? '正在准备应用运行时' : '应用运行时不可用'}</h1><p style="line-height:1.7;color:#7a6a62">${text}</p></main></body></html>`;
}

function sendStatusPage(res: import('node:http').ServerResponse, status: 'starting' | 'failed') {
  if (res.headersSent) { res.end(); return; }
  res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Retry-After': '2' });
  res.end(runtimeStatusPage(status));
}

/** 把一次 HTTP 请求代理给 dev server：HTML 注入编辑桥接与 CSP，其余资源原样流式转发。 */
function proxyHttp(
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse,
  target: { port: number; parentOrigin: string; locked: boolean },
): Promise<void> {
  return new Promise<void>(done => {
    let settled = false;
    const finish = () => { if (!settled) { settled = true; done(); } };
    const upstream = httpRequest({
      host: '127.0.0.1', port: target.port, method: req.method, path: req.url,
      headers: { ...req.headers, host: `127.0.0.1:${target.port}`, 'accept-encoding': 'identity', connection: 'close' },
    }, response => {
      const type = String(response.headers['content-type'] ?? '');
      const headers = proxyHeaders(response.headers);
      if (type.includes('text/html')) {
        const chunks: Buffer[] = [];
        response.on('data', chunk => chunks.push(Buffer.from(chunk)));
        response.on('end', () => {
          try {
            const body = Buffer.from(injectBridge(Buffer.concat(chunks).toString('utf8'), target.parentOrigin, target.locked));
            res.writeHead(response.statusCode ?? 200, {
              ...headers, 'content-type': 'text/html; charset=utf-8', 'content-length': String(body.length),
              'cache-control': 'no-store', 'content-security-policy': devCsp(target.parentOrigin),
            });
            res.end(req.method === 'HEAD' ? undefined : body);
          } catch { sendStatusPage(res, 'failed'); }
          finish();
        });
        response.on('error', () => { sendStatusPage(res, 'failed'); finish(); });
        return;
      }
      res.writeHead(response.statusCode ?? 200, { ...headers, 'cache-control': 'no-store' });
      response.pipe(res);
      response.on('end', finish);
      response.on('error', finish);
    });
    upstream.setTimeout(20_000, () => upstream.destroy(new Error('预览代理超时')));
    upstream.on('error', () => { sendStatusPage(res, 'starting'); finish(); });
    req.pipe(upstream);
  });
}

/** HMR websocket：把升级请求原样转给 dev server，双向透传字节。 */
function proxyUpgrade(req: import('node:http').IncomingMessage, socket: import('node:net').Socket, head: Buffer, port: number) {
  const upstream = connect(port, '127.0.0.1', () => {
    const headers = { ...req.headers, host: `127.0.0.1:${port}` };
    const lines = [`${req.method ?? 'GET'} ${req.url ?? '/'} HTTP/1.1`];
    for (const [name, value] of Object.entries(headers)) {
      if (value === undefined) continue;
      for (const item of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${item}`);
    }
    lines.push('', '');
    upstream.write(lines.join('\r\n'));
    if (head.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
  upstream.setTimeout(0);
}

export async function createPreviewServer(options: PreviewServerOptions = {}) {
  const config = getConfig();
  const origin = new URL(config.previewOrigin);
  // 测试可以指向临时运行目录；生产默认仍是 getConfig().runtimeRoot。
  const root = await ensureSafeDirectory(resolve(options.runtimeRoot ?? config.runtimeRoot));
  const devServerFor = options.devServerFor ?? (async (app: PreviewApp) => runtimePreviewTarget(app));
  const writeAuthorityOf = options.writeAuthorityOf ?? (async (app: PreviewApp) => appHasWriteAuthority(app));
  // 每个资源请求都查一次台账太贵；ready 的解析结果缓存 1 秒，状态变化（启动中/失败）不缓存。
  const cacheMs = options.devServerCacheMs ?? 1000;
  const resolved = new Map<string, { at: number; target: DevServerTarget }>();
  async function devServerOf(app: PreviewApp): Promise<DevServerTarget | null> {
    const key = `${app.codeGenType}_${app.id}`;
    const cached = resolved.get(key);
    if (cached && Date.now() - cached.at < cacheMs) return cached.target;
    const target = await devServerFor(app).catch(() => null);
    if (target?.status === 'ready') resolved.set(key, { at: Date.now(), target });
    else resolved.delete(key);
    return target;
  }

  async function serveStatic(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, path: string, locked: boolean) {
    let directory: string;
    let asset: string;
    const cover = path.match(/^\/covers\/([^/]+)\.png$/);
    if (cover) { directory = join(root, 'covers'); asset = validateDeployKey(cover[1]) + '.png'; }
    else {
      const fixed = path.match(/^\/delivery\/([^/]+)\/([^/]+)(\/.*)?$/);
      const match = fixed ?? path.match(/^\/(preview|deploy)\/([^/]+)(\/.*)?$/);
      if (!match) { res.writeHead(404); res.end(); return; }
      const rest = match[3];
      const key = fixed ? fixed[1] : match[2];
      // 先校验标识再重定向，保持 deploy 与 preview 原有的 400 语义。
      const deployKey = !fixed && match[1] === 'deploy' ? validateDeployKey(key) : null;
      const app = deployKey === null ? appFromKey(key) : null;
      if (!rest) { res.writeHead(308, { Location: path + '/' }); res.end(); return; }
      if (deployKey !== null) {
        directory = join(root, 'deploy', deployKey);
      } else if (app && fixed) {
        // 固定交付路由：只看这一个不可变目录，不跟随指针。
        const fixedDelivery = await resolveDelivery({ app, deliveryId: fixed[2], runtimeRoot: root });
        if (!fixedDelivery) { res.writeHead(404, { 'Cache-Control': 'no-store' }); res.end('交付不存在'); return; }
        directory = fixedDelivery.directory;
      } else if (app) {
        // 预览入口：有指针就服务该交付；没有指针才回退旧 code_output（legacy），两者不混用。
        const pointer = await currentDelivery({ app, runtimeRoot: root });
        if (pointer) {
          const delivery = await resolveDelivery({ app, deliveryId: pointer.deliveryId, runtimeRoot: root });
          if (!delivery) { res.writeHead(404, { 'Cache-Control': 'no-store' }); res.end('交付不存在'); return; }
          directory = delivery.directory;
        } else directory = legacyDelivery(app, root).directory;
      } else throw new Error('应用标识不合法');
      asset = rest.slice(1) || 'index.html';
    }
    const segments = asset.split('/');
    if (segments.some(part => !part || part === '.' || part === '..' || part.startsWith('.') || part === 'node_modules')) throw new Error('路径被拒绝');
    const directoryReal = await realpath(directory);
    if (directoryReal !== directory) throw new Error('目录不允许软链接');
    let file = join(directory, asset);
    if (!contentType(file)) {
      if (extname(file)) { res.writeHead(404); res.end(); return; }
      file = join(directory, 'index.html');
    }
    const fileReal = await realpath(file);
    const rel = relative(directoryReal, fileReal);
    if (rel.startsWith('..') || isAbsolute(rel) || fileReal !== file) throw new Error('文件不允许软链接');
    const info = await lstat(file);
    if (!info.isFile() || info.size > 20 * 1024 * 1024) throw new Error('文件不合法');
    let contents = await readFile(file);
    if (extname(file) === '.html') contents = Buffer.from(injectBridge(contents.toString(), config.appOrigin, locked));
    res.writeHead(200, {
      'Content-Type': contentType(file) ?? 'application/octet-stream', 'Content-Length': contents.length, 'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' data: https://fonts.gstatic.com; img-src 'self' data: blob: https:; connect-src 'self'; worker-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'self'; frame-ancestors ${config.appOrigin}; sandbox allow-scripts allow-same-origin`,
    });
    res.end(req.method === 'HEAD' ? undefined : contents);
  }

  const server = createServer(async (req, res) => {
    try {
      if (!['GET', 'HEAD'].includes(req.method ?? '')) { res.writeHead(405); res.end(); return; }
      if (req.headers.host !== origin.host) { res.writeHead(403); res.end(); return; }
      const url = new URL(req.url ?? '/', config.previewOrigin);
      const path = decodeURIComponent(url.pathname);
      if (path.includes('\\') || path.includes('\0')) throw new Error('路径不合法');
      const preview = path.match(/^\/preview\/([^/]+)(\/.*)?$/);
      const previewApp = preview ? appFromKey(preview[1]) : null;
      if (preview && previewApp) {
        const rest = preview[2];
        if (!rest) { res.writeHead(308, { Location: url.pathname + '/' }); res.end(); return; }
        const dev = await devServerOf(previewApp);
        if (dev?.status === 'ready' && dev.port) {
          await proxyHttp(req, res, { port: dev.port, parentOrigin: config.appOrigin, locked: await writeAuthorityOf(previewApp).catch(() => false) });
          return;
        }
        if (dev && dev.status !== 'ready') { sendStatusPage(res, dev.status); return; }
      }
      // 静态回落只在预览入口需要判断只读；封面、部署与固定交付路由没有编辑桥接。
      const locked = previewApp ? await writeAuthorityOf(previewApp).catch(() => false) : false;
      await serveStatic(req, res, path, locked);
    } catch (error) {
      res.writeHead((error as NodeJS.ErrnoException).code === 'ENOENT' ? 404 : 400, { 'Cache-Control': 'no-store' });
      res.end('资源不可访问');
    }
  });

  // HMR websocket：只有 /preview/<key>/... 会被代理，其他升级请求直接断开。
  server.on('upgrade', (req, socket, head) => {
    try {
      if (req.headers.host !== origin.host) { socket.destroy(); return; }
      const path = decodeURIComponent(new URL(req.url ?? '/', config.previewOrigin).pathname);
      const preview = path.match(/^\/preview\/([^/]+)\//);
      if (!preview) { socket.destroy(); return; }
      const app = appFromKey(preview[1]);
      void devServerOf(app).then(target => {
        if (target?.status === 'ready' && target.port) proxyUpgrade(req, socket as import('node:net').Socket, head, target.port);
        else socket.destroy();
      }).catch(() => socket.destroy());
    } catch { socket.destroy(); }
  });
  return server;
}
