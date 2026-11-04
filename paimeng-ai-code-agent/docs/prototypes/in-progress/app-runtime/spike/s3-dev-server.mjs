import { createServer } from 'node:http';
import { writeFile } from 'node:fs/promises';

/** Spike 用的假 dev server：每 100ms 写一次心跳，供「冻结后不再写」检查。 */
const heartbeat = '/work/dev-heartbeat.txt';
let beats = 0;
setInterval(() => {
  beats += 1;
  writeFile(heartbeat, `${Date.now()} ${beats}\n`).catch(() => undefined);
}, 100);

createServer((req, res) => {
  if (req.url === '/ping') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end(`pong ${beats}`); return; }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(`<!doctype html><html><body><h1>spike dev</h1></body></html>`);
}).listen(5173, '127.0.0.1', () => console.log('dev-server-ready'));
