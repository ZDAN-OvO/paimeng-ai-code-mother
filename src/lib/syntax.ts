import { createHighlighterCore } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';

const languages = {
  tsx: () => import('shiki/langs/tsx.mjs'),
  typescript: () => import('shiki/langs/typescript.mjs'),
  javascript: () => import('shiki/langs/javascript.mjs'),
  jsx: () => import('shiki/langs/jsx.mjs'),
  json: () => import('shiki/langs/json.mjs'),
  css: () => import('shiki/langs/css.mjs'),
  html: () => import('shiki/langs/html.mjs'),
  markdown: () => import('shiki/langs/markdown.mjs'),
  yaml: () => import('shiki/langs/yaml.mjs'),
  shellscript: () => import('shiki/langs/shellscript.mjs'),
  sql: () => import('shiki/langs/sql.mjs'),
};
export type CodeLanguage = keyof typeof languages | 'text';

const extensions: Record<string, CodeLanguage> = {
  tsx: 'tsx',
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'jsx',
  json: 'json',
  css: 'css',
  html: 'html',
  htm: 'html',
  md: 'markdown',
  mdx: 'markdown',
  yaml: 'yaml',
  yml: 'yaml',
  sh: 'shellscript',
  bash: 'shellscript',
  sql: 'sql',
};
export function languageForFile(filename: string): CodeLanguage {
  return extensions[filename.split('.').at(-1)?.toLowerCase() ?? ''] ?? 'text';
}

let highlighter: ReturnType<typeof createHighlighterCore> | undefined;
function getHighlighter() {
  highlighter ??= createHighlighterCore({
    themes: [import('shiki/themes/github-light.mjs'), import('shiki/themes/github-dark.mjs')],
    langs: [],
    engine: createJavaScriptRegexEngine(),
  }).catch((error) => {
    highlighter = undefined;
    throw error;
  });
  return highlighter;
}
const pending = new Map<string, Promise<void>>();
export async function highlightCode(code: string, language: CodeLanguage) {
  const instance = await getHighlighter();
  if (language !== 'text' && !instance.getLoadedLanguages().includes(language)) {
    let loading = pending.get(language);
    if (!loading) {
      loading = instance
        .loadLanguage(languages[language]())
        .finally(() => pending.delete(language));
      pending.set(language, loading);
    }
    await loading;
  }
  return instance.codeToTokens(code, {
    lang: language,
    themes: { light: 'github-light', dark: 'github-dark' },
  }).tokens;
}
