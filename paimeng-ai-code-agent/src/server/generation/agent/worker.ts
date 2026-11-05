import 'server-only';
import { startAgentWorld, stopAgentWorld } from './world';

const world = await startAgentWorld();
console.log(
  JSON.stringify({ event: 'agent-world-started', pid: process.pid, spec: world.specVersion }),
);

let closing = false;
async function shutdown(signal: string) {
  if (closing) return;
  closing = true;
  console.log(JSON.stringify({ event: 'agent-world-closing', signal, pid: process.pid }));
  await stopAgentWorld();
  process.exit(0);
}
for (const signal of ['SIGTERM', 'SIGINT'] as const)
  process.on(signal, () => {
    void shutdown(signal);
  });
