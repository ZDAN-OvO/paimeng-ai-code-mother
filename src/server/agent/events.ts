import type { SseEvent } from '@/shared/api/schemas';

type Listener = (event: SseEvent) => void;
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

const listeners = new Map<string, Set<Listener>>();

export function subscribe(projectId: string, listener: Listener) {
  let set = listeners.get(projectId);
  if (!set) {
    set = new Set();
    listeners.set(projectId, set);
  }
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(projectId);
  };
}

export function publish(
  projectId: string,
  event: DistributiveOmit<SseEvent, 'seq'> & { seq?: number },
) {
  const value = { ...event, seq: event.seq ?? 0 } as SseEvent;
  for (const listener of listeners.get(projectId) ?? []) listener(value);
}
