import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Markdown } from '@/features/chat/markdown';

const render = (text: string) => renderToStaticMarkup(createElement(Markdown, { text }));

describe('助手 Markdown', () => {
  it('渲染表格、任务列表和代码块', () => {
    const html = render(
      '| 名称 | 结果 |\n| --- | --- |\n| 构建 | 通过 |\n\n- [x] 完成\n\n```ts\nconst ok = true;\n```',
    );
    expect(html).toContain('<table');
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('language-ts');
    expect(html).toContain('const ok = true;');
  });
  it('流式输出未闭合的代码块仍能显示，补全后保持内容', () => {
    const incomplete = '开始\n\n```tsx\n<div>你好';
    expect(render(incomplete)).toContain('&lt;div&gt;你好');
    expect(render(`${incomplete}</div>\n\`\`\``)).toContain('&lt;div&gt;你好&lt;/div&gt;');
  });
  it('不渲染原始 HTML，不生成危险协议链接', () => {
    const html = render(
      '<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n[链接](javascript:alert%281%29)',
    );
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('href="javascript:');
  });
});
