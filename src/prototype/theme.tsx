'use client';

import { useEffect, useSyncExternalStore, type ReactNode } from 'react';

export type ThemeMode = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

const STORAGE_KEY = 'paimeng.theme';
const CHANGE_EVENT = 'paimeng:theme';

const modeListeners = new Set<() => void>();
const systemListeners = new Set<() => void>();

function readStoredMode(): ThemeMode {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === 'light' || stored === 'dark') return stored;
  } catch {
    // 原型不处理隐私模式下的存储异常。
  }
  return 'system';
}

export function setThemeMode(mode: ThemeMode) {
  try {
    if (mode === 'system') window.localStorage.removeItem(STORAGE_KEY);
    else window.localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // 存不住也不影响本次切换。
  }
  modeListeners.forEach((listener) => listener());
}

function subscribeMode(listener: () => void) {
  modeListeners.add(listener);
  window.addEventListener('storage', listener);
  window.addEventListener(CHANGE_EVENT, listener);
  return () => {
    modeListeners.delete(listener);
    window.removeEventListener('storage', listener);
    window.removeEventListener(CHANGE_EVENT, listener);
  };
}

function subscribeSystem(listener: () => void) {
  const query = window.matchMedia('(prefers-color-scheme: dark)');
  query.addEventListener('change', listener);
  systemListeners.add(listener);
  return () => {
    query.removeEventListener('change', listener);
    systemListeners.delete(listener);
  };
}

/** 首帧在浏览器读存储，服务端固定按「跟随系统」渲染，避免水合不一致。 */
export function useThemeMode(): ThemeMode {
  return useSyncExternalStore(subscribeMode, readStoredMode, () => 'system' as ThemeMode);
}

export function useSystemDark(): boolean {
  return useSyncExternalStore(
    subscribeSystem,
    () => window.matchMedia('(prefers-color-scheme: dark)').matches,
    () => false,
  );
}

export function useResolvedTheme(): ResolvedTheme {
  const mode = useThemeMode();
  const systemDark = useSystemDark();
  if (mode === 'system') return systemDark ? 'dark' : 'light';
  return mode;
}

export function useThemeMounted(): boolean {
  return useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );
}

function apply(theme: ResolvedTheme) {
  const root = document.documentElement;
  root.classList.toggle('dark', theme === 'dark');
  root.style.colorScheme = theme;
}

/** 原型自己的主题：只改 <html> 上的 dark 类，预览里的生成站点用自己的配色。 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const theme = useResolvedTheme();

  // 首帧由原型 layout 里的内联脚本负责，这里只处理之后的切换与系统变化。
  useEffect(() => {
    apply(theme);
  }, [theme]);

  return children;
}

/** 放在 <body> 顶部的内联脚本，避免刷新时先亮后暗。 */
export const THEME_SCRIPT = `try{var m=localStorage.getItem('${STORAGE_KEY}')||'system';var d=m==='dark'||(m==='system'&&window.matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.classList.toggle('dark',d);document.documentElement.style.colorScheme=d?'dark':'light';}catch(e){}`;
