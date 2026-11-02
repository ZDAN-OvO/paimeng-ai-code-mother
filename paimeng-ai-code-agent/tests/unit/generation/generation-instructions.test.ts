import { describe, expect, it } from 'vitest';
import { generationInstructions, staticPathHint, typeRules } from '@/server/generation/prompts/generation-instructions';
import { BUILD_DEPENDENCIES, REACT_DEPENDENCIES } from '@/server/delivery/build-contract';
import type { CodeGenType } from '@/shared/contracts';

function instructions(type: CodeGenType, template = false) {
  return generationInstructions({ app: { codeGenType: type, initPrompt: '需求标题' }, template: template ? { id: type === 'multi_file' ? 'multi-file' : 'html', version: '1.0.0' } : null, entry: template ? 'index.html' : null, webInstruction: '联网素材需署名。' });
}

describe('按应用类型生成指令', () => {
  it('HTML 旧应用（没有模板）禁止工程脚手架并直接静态托管', () => {
    const value = instructions('html');
    expect(value).toContain('只写 index.html');
    expect(value).toMatch(/禁止[^。]*package\.json/);
    expect(value).toContain('assets/');
    expect(value).not.toContain('Vue 工程必须使用 Vue');
    expect(value).not.toMatch(/必须包含 package\.json/);
    expect(value).not.toContain('vite.config.js 和 src/main.js');
    expect(value).not.toContain('自动构建前端工程');
    expect(value).toContain('没有构建步骤');
    expect(value).toContain('所有读写必须使用工具');
    expect(value).toContain('工具返回错误时根据错误修正并重试');
    expect(value).toContain('联网素材需署名');
  });

  it('多文件约定与工具描述不要求 Vue 工程', () => {
    const value = instructions('multi_file');
    for (const directory of ['css/', 'js/', 'assets/']) expect(value).toContain(directory);
    expect(value).toMatch(/禁止[^。]*package\.json/);
    expect(value).not.toContain('Vue 工程必须使用 Vue');
    expect(value).not.toMatch(/必须包含 package\.json/);
    expect(value).not.toContain('自动构建前端工程');
    expect(staticPathHint('multi_file')).toContain('css/');
    expect(staticPathHint('html')).not.toContain('Vue 或 React 工程使用');
  });

  it.each(['vue_project', 'react_project'] as const)('%s 的旧应用（没有模板）保留类型规则与依赖精确版本', type => {
    const value = instructions(type);
    expect(value).toContain(type === 'vue_project' ? 'Vue 工程必须使用 Vue' : 'React 工程必须使用 React');
    expect(value).toContain('必须包含 package.json');
    expect(value).toContain(JSON.stringify(type === 'vue_project' ? BUILD_DEPENDENCIES : REACT_DEPENDENCIES));
    expect(value).toContain('禁止 ^、~、latest');
    expect(value).toContain('自动构建前端工程');
    expect(value).not.toContain('只写 index.html');
    expect(typeRules[type]).toContain("base './'");
  });

  it('模板应用用模板内容、入口和组件复用说明取代四套类型规则', () => {
    const value = generationInstructions({
      app: { codeGenType: 'react_project', initPrompt: '做一个后台' },
      template: { id: 'react-ts', version: '2.0.0' },
      entry: 'src/main.tsx',
      files: ['package.json', 'src/main.tsx', 'src/App.tsx', 'src/components/ui/button.tsx', 'src/index.css'],
      webInstruction: '',
    });
    expect(value).toContain('从 react-ts@2.0.0 模板初始化');
    expect(value).toContain('入口 src/main.tsx');
    expect(value).toContain('src/components/ui/button.tsx');
    expect(value).toContain('src/index.css');
    expect(value).toContain('优先复用');
    expect(value).toContain('依赖与锁文件由模板版本固定');
    // 产品面的四套类型规则不再拼进模板应用提示词。
    expect(value).not.toContain('React 工程必须使用 React');
    expect(value).not.toContain(JSON.stringify(REACT_DEPENDENCIES));
    expect(value).not.toContain('禁止 ^、~、latest');
    // 常驻 runtime 的 shell 尚未落地，提示词不能提前宣称。
    expect(value).toContain('禁止安装脚本和任意 shell');
    expect(value).not.toMatch(/shell 工具|用 shell 安装|通过 shell 安装|使用 shell 执行/);
  });

  it('轻量静态模板同样以模板说明代替类型规则', () => {
    const value = instructions('html', true);
    expect(value).toContain('从 html@1.0.0 模板初始化');
    expect(value).not.toContain('只写 index.html');
  });

  it('harness 引擎（只有文件工具）不提 buildPreview', () => {
    const value = generationInstructions({ app: { codeGenType: 'html', initPrompt: '需求' }, template: null, entry: null, webInstruction: '', previewTool: false });
    expect(value).not.toContain('buildPreview');
    expect(value).toContain('本轮只有文件工具');
    expect(value).toContain('所有读写必须使用工具');
  });

  it('静态模板与旧应用使用各自开场白，工程模板保留 TypeScript 入口', () => {
    expect(instructions('html', true)).toContain('从 html@1.0.0 模板初始化，骨架可直接使用或改写');
    expect(instructions('html')).toContain('HTML 与多文件应用必须有 index.html，只写静态文件');
    const value = generationInstructions({ app: { codeGenType: 'vue_project', initPrompt: '需求' }, template: { id: 'vue-ts', version: '1.0.0' }, entry: 'src/main.ts', webInstruction: '' });
    expect(value).toContain('保留 TypeScript 入口 src/main.ts 和 vite.config.ts');
    expect(value).not.toContain('必须包含 package.json、index.html、vite.config.js');
  });
});
