import type { CodeGenType } from '@/shared/contracts';

export type FixtureFile = { path: string; content: string };

export const fixtureReplyText = '文件已生成，正在验证与构建。此回复来自可控测试模型。';

export function fixtureSourcePath(type: CodeGenType) {
  return type === 'react_project' ? 'src/App.tsx' : type === 'vue_project' ? 'src/App.vue' : 'index.html';
}

/** React 厚架子（react-ts@2.0.0）的示例页面；夹具改这一页，保留模板的布局、令牌与路由。 */
export const THICK_REACT_PAGE = 'src/pages/home.tsx';

export function fixtureReadSteps(type: CodeGenType, thickReact = false): { tool: 'listFiles' | 'read'; path?: string }[] {
  return [{ tool: 'listFiles' }, { tool: 'read', path: 'AGENTS.md' }, { tool: 'read', path: thickReact && type === 'react_project' ? THICK_REACT_PAGE : fixtureSourcePath(type) }];
}

function fixtureTypedSource(type: CodeGenType, prompt: string): FixtureFile | undefined {
  if (type !== 'react_project' && type !== 'vue_project') return undefined;
  const source = fixtureFiles(type, prompt).find(file => file.path === fixtureSourcePath(type));
  if (!source) return undefined;
  const content = type === 'react_project'
    ? source.content.replace('useState(0)', 'useState<number>(0)')
    : source.content.replace('<script setup>', '<script setup lang="ts">');
  return { ...source, content };
}

/** 实时预览证据：`[live]` 前缀让夹具在同一轮里连续写两次同一页，第二次在等待之后。 */
export const LIVE_MARKER = '[live]';
/** 证据用例专用的长窗口版本：同一轮两次写入之间等 20 秒，用于在生成过程中操作排队/取消。 */
export const LIVE_LONG_MARKER = '[live-long]';
export function fixtureLive(prompt: string) {
  return prompt.startsWith(LIVE_MARKER) || prompt.startsWith(LIVE_LONG_MARKER);
}
/** 两次实时写入之间的等待：默认 8 秒；`[live-long]` 给需要更长确定窗口的用例。 */
export function fixtureLiveWindowMs(prompt: string) {
  return prompt.startsWith(LIVE_LONG_MARKER) ? 20_000 : 8_000;
}

export function thickReactPage(prompt: string, suffix = ''): FixtureFile {
  const title = prompt.replace(/[<>&"']/g, '').replace(LIVE_LONG_MARKER, '').replace(LIVE_MARKER, '').trim().slice(0, 80) + suffix;
  return {
    path: THICK_REACT_PAGE,
    content: `import { ArrowUpRight } from 'lucide-react';
import { Link } from 'react-router';
import { PageHeader } from '@/components/layout/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export function HomePage() {
  return (
    <div className="space-y-8">
      <PageHeader
        title="${title}"
        description="可控测试模型生成的示例页面：保留模板的布局、设计令牌与组件。"
        actions={
          <Button asChild>
            <Link to="/about">
              查看组件说明
              <ArrowUpRight className="size-4" aria-hidden />
            </Link>
          </Button>
        }
      />
      <Card>
        <CardHeader>
          <CardTitle>生成结果</CardTitle>
          <CardDescription>这一页来自本次生成的写入。</CardDescription>
        </CardHeader>
        <CardContent className="flex items-center gap-2 text-sm text-ink-muted">
          <Badge>来自夹具</Badge>
          <span>布局、令牌与卡片组件都来自 react-ts@2.0.0 模板。</span>
        </CardContent>
      </Card>
    </div>
  );
}
`,
  };
}

export function fixtureWriteSteps(type: CodeGenType, prompt: string, templated: boolean, thickReact = false): FixtureFile[] {
  if (type === 'react_project' && templated && thickReact) return [thickReactPage(prompt)];
  const project = type === 'react_project' || type === 'vue_project';
  const typed = templated && project ? fixtureTypedSource(type, prompt) : undefined;
  return typed ? [typed] : fixtureFiles(type, prompt);
}

export function fixtureFiles(type:CodeGenType,prompt:string):FixtureFile[]{
const title=prompt.replace(/[<>&"']/g,'').slice(0,80);
 if(type==='react_project')return [
  {path:'package.json',content:JSON.stringify({name:'generated-react',version:'1.0.0',private:true,type:'module',scripts:{build:'vite build'},dependencies:{react:'19.1.0','react-dom':'19.1.0'},devDependencies:{vite:'7.0.0','@vitejs/plugin-react':'4.6.0','@types/react':'19.1.8','@types/react-dom':'19.1.6',typescript:'5.9.3','@types/node':'22.15.32'}})},
  {path:'index.html',content:`<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>${title}</title></head><body><div id="root"></div><script type="module" src="/src/main.jsx"></script></body></html>`},
  {path:'vite.config.js',content:"import {defineConfig} from 'vite';import react from '@vitejs/plugin-react';export default defineConfig({plugins:[react()],base:'./'});"},
  {path:'src/main.jsx',content:"import {createRoot} from 'react-dom/client';import App from './App';createRoot(document.getElementById('root')).render(<App/>);"},
  {path:'src/App.tsx',content:`import {useState} from 'react';export default function App(){const [count,setCount]=useState(0);return <main><h1>${title}</h1><p>可控测试模型生成的 React 工程</p><button onClick={()=>setCount(count+1)}>点击 {count}</button></main>;}`}
 ];
 if(type==='vue_project')return [
  {path:'package.json',content:JSON.stringify({name:'generated-vue',version:'1.0.0',private:true,type:'module',scripts:{build:'vite build'},dependencies:{vue:'3.5.17'},devDependencies:{vite:'7.0.0','@vitejs/plugin-vue':'6.0.0'}})},
  {path:'index.html',content:'<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>生成应用</title></head><body><div id="app"></div><script type="module" src="/src/main.js"></script></body></html>'},
  {path:'vite.config.js',content:"import {defineConfig} from 'vite';import vue from '@vitejs/plugin-vue';export default defineConfig({plugins:[vue()],base:'./'});"},
  {path:'src/main.js',content:"import {createApp} from 'vue';import App from './App.vue';createApp(App).mount('#app');"},
  {path:'src/App.vue',content:`<script setup>import {ref} from 'vue';const count=ref(0);</script><template><main><h1>${title}</h1><p>可控测试模型生成的 Vue 工程</p><button @click="count++">点击 {{count}}</button></main></template><style>body{font-family:system-ui;background:#fff6f1}main{max-width:800px;margin:80px auto;padding:32px}button{padding:12px;background:#cb573e;color:white;border:0;border-radius:8px}</style>`}
 ];
 const files=[{path:'index.html',content:`<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>${type==='multi_file'?'<link rel="stylesheet" href="style.css">':'<style>body{font-family:system-ui;background:#fff6f1}main{max-width:800px;margin:80px auto;padding:32px}button{padding:12px;background:#cb573e;color:white;border:0;border-radius:8px}</style>'}</head><body><main><h1>${title}</h1><p>可控测试模型生成的应用</p><button id="action">开始体验</button></main>${type==='multi_file'?'<script src="script.js"></script>':''}</body></html>`}];
 if(type==='multi_file')files.push({path:'style.css',content:'body{font-family:system-ui;background:#fff6f1}main{max-width:800px;margin:80px auto;padding:32px}'},{path:'script.js',content:"document.querySelector('#action').addEventListener('click',()=>{document.querySelector('p').textContent='交互成功'})"});return files;
}
