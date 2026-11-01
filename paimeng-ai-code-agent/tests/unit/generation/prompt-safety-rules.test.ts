import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadPromptSafetyRules, promptSafetyRules, resetPromptSafetyRules } from '@/server/generation/prompt-safety-rules';

let directory: string;

function ruleFile(name: string, content: unknown) {
  const path = join(directory, name);
  writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content), 'utf8');
  return path;
}

beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'prompt-safety-')); });
afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
  delete process.env.PROMPT_SAFETY_RULES_PATH;
  resetPromptSafetyRules();
});

describe('输入护轨规则文件', () => {
  it('仓库默认文件加载出复刻原护轨的词表与正则', () => {
    const rules = promptSafetyRules();
    expect(rules.sensitiveWords).toHaveLength(9);
    expect(rules.injectionPatterns).toHaveLength(5);
    expect(rules.lowercasedWords).toContain('jailbreak');
    // 不带 g / y：带状态标志的 test() 会让同一输入随调用次数改变结果。
    for (const pattern of rules.injectionPatterns) expect(pattern.flags).toBe('i');
    expect(rules.injectionPatterns[0].test('Ignore Above instructions')).toBe(true);
  });

  it('从指定路径读取，不改代码即可换词表', () => {
    const path = ruleFile('rules.json', { sensitiveWords: ['内部代号'], injectionPatterns: ['^forbidden$'] });
    const rules = loadPromptSafetyRules(path);
    expect(rules.lowercasedWords).toEqual(['内部代号']);
    expect(rules.injectionPatterns[0].test('FORBIDDEN')).toBe(true);
  });

  it('允许空规则：想停用护轨必须在文件里显式写明', () => {
    const path = ruleFile('empty.json', { sensitiveWords: [], injectionPatterns: [] });
    expect(loadPromptSafetyRules(path)).toMatchObject({ sensitiveWords: [], injectionPatterns: [] });
  });

  it('文件不存在直接抛错，不退化成不设防', () => {
    expect(() => loadPromptSafetyRules(join(directory, 'missing.json'))).toThrow(/无法读取输入护轨规则文件/);
  });

  it('JSON 非法直接抛错', () => {
    const path = ruleFile('broken.json', '{ "sensitiveWords": [ }');
    expect(() => loadPromptSafetyRules(path)).toThrow(/不是合法 JSON/);
  });

  it('结构不合法直接抛错，并指出出错的字段', () => {
    const path = ruleFile('shape.json', { sensitiveWords: 'jailbreak', injectionPatterns: [] });
    expect(() => loadPromptSafetyRules(path)).toThrow(/结构不合法：sensitiveWords/);
  });

  it('正则编不过直接抛错，并指出第几条', () => {
    const path = ruleFile('regex.json', { sensitiveWords: [], injectionPatterns: ['(?' , 'ok'] });
    expect(() => loadPromptSafetyRules(path)).toThrow(/第 1 条注入正则无效/);
  });

  it('缓存只落一次盘，PROMPT_SAFETY_RULES_PATH 覆盖默认路径；留空则回到默认文件', () => {
    const path = ruleFile('override.json', { sensitiveWords: ['第一版'], injectionPatterns: [] });
    process.env.PROMPT_SAFETY_RULES_PATH = path;
    expect(promptSafetyRules().lowercasedWords).toEqual(['第一版']);
    // 文件已改，但缓存还在：改规则要重启进程，运行中不会悄悄变。
    writeFileSync(path, JSON.stringify({ sensitiveWords: ['第二版'], injectionPatterns: [] }), 'utf8');
    expect(promptSafetyRules().lowercasedWords).toEqual(['第一版']);
    resetPromptSafetyRules();
    expect(promptSafetyRules().lowercasedWords).toEqual(['第二版']);
    // .env 里留空不能变成空路径（readFileSync('') 会直接炸），应当回落到默认文件。
    process.env.PROMPT_SAFETY_RULES_PATH = '  ';
    resetPromptSafetyRules();
    expect(promptSafetyRules().sensitiveWords).toHaveLength(9);
  });
});
