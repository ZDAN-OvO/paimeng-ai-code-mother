'use client';

import { useSyncExternalStore } from 'react';

const EVENT = 'paimeng:stored';
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  window.addEventListener('storage', listener);
  window.addEventListener(EVENT, listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', listener);
    window.removeEventListener(EVENT, listener);
  };
}

export function readStored(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeStored(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // 存不住也不影响本次操作。
  }
  listeners.forEach((listener) => listener());
}

/** 字符串偏好项。服务端按 fallback 渲染，水合后如果不是这个值会再渲一次。 */
export function useStoredValue(key: string, fallback: string): string {
  return useSyncExternalStore(
    subscribe,
    () => readStored(key) ?? fallback,
    () => fallback,
  );
}
