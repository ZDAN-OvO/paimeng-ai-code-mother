import { describe, expect, it } from 'vitest';
import { highlightCode, languageForFile } from './syntax';

describe('Shiki 代码高亮', () => {
  it('按文件扩展名识别语言，不支持的文件使用纯文本', () => {
    expect(languageForFile('app/page.tsx')).toBe('tsx');
    expect(languageForFile('next.config.mjs')).toBe('javascript');
    expect(languageForFile('styles.css')).toBe('css');
    expect(languageForFile('file.unknown')).toBe('text');
  });
  it('真实语法解析保留代码文本和空行，返回明暗主题颜色', async () => {
    const code = 'export const Page = () => <div>你好</div>;\n\n';
    const lines = await highlightCode(code, 'tsx');
    expect(lines.map((line) => line.map((token) => token.content).join('')).join('\n')).toBe(code);
    expect(lines.flat().some((token) => token.htmlStyle?.color)).toBe(true);
    expect(lines.flat().some((token) => token.htmlStyle?.['--shiki-dark'])).toBe(true);
  });
  it('切换不同语言时按需加载，不把源码当 HTML 执行', async () => {
    const [json, css] = await Promise.all([
      highlightCode('{"name":"test"}', 'json'),
      highlightCode('body { color: red; }', 'css'),
    ]);
    expect(
      json
        .flat()
        .map((token) => token.content)
        .join(''),
    ).toBe('{"name":"test"}');
    expect(
      css
        .flat()
        .map((token) => token.content)
        .join(''),
    ).toBe('body { color: red; }');
    const raw = await highlightCode('<script>alert(1)</script>', 'text');
    expect(
      raw
        .flat()
        .map((token) => token.content)
        .join(''),
    ).toContain('<script>');
  });
});
