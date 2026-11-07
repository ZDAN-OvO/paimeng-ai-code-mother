'use client';

import { useRef, useState } from 'react';
import Link from 'next/link';
import {
  ArrowLeft,
  BookLock,
  Check,
  ChevronDown,
  FolderOpen,
  Loader2,
  Plus,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Trash2,
  Upload,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { usePrototype } from '@/prototype/store';
import type { Skill } from '@/prototype/types';

const MOCK_IMPORT_CONTENTS: Record<string, string> = {
  'SKILL.md': `---
name: brand-voice-2
description: 把品牌语气约束成一份可复用的写作规则。
---

这是 mock 示例技能，只用于本地原型演示。
写文案时先读 references/tone.md 和 references/examples.md。
如需检查，可请求 scripts/check.ts；原型不会实际执行脚本。`,
  'references/tone.md': '短句，结论先行，不写营销套话，不用感叹号。',
  'references/examples.md': '示例：把「赋能业务增长」改成「减少重复录入」。',
  'scripts/check.ts': '// Mock 示例：仅保存为文本，浏览器不会执行。\nconsole.log("检查品牌语气");',
};

const WEEKLY_SKILL_DESCRIPTION = '把零散记录整理成固定结构的周报，结论先行，风险单列。';
const WEEKLY_SKILL_CONTENT = `---
name: weekly-report-format
description: ${WEEKLY_SKILL_DESCRIPTION}
---

## 什么时候用
用户要写、整理或改写周报时。

## 结构
1. 一句话结论
2. 本周完成（三条以内，写结果不写过程）
3. 数据变化（只放真的数字）
4. 风险与求助（没有就写没有）

## 语气
短句，不用感叹号，不写「赋能」「闭环」这类词。`;

export default function SkillsPage() {
  const { state, setSkill, importSkill, removeSkill, hydrated } = usePrototype();
  const [importOpen, setImportOpen] = useState(false);
  const [creatorOpen, setCreatorOpen] = useState(false);

  const builtin = state.skills.filter((skill) => skill.source === 'builtin');
  const user = state.skills.filter((skill) => skill.source === 'user');
  const enabled = state.skills.filter((skill) => skill.enabled).length;
  const chat = state.chats[0];

  return (
    <div className="min-h-dvh bg-muted/40">
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex h-14 max-w-4xl items-center gap-2 px-5">
          <Link
            href="/prototype"
            className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <ArrowLeft className="size-4" />
          </Link>
          <span className="text-[13.5px] font-semibold text-foreground">技能</span>
          <span className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">
            M4 · 不在 13 条内
          </span>
          <div className="ml-auto flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              data-testid="skill-import"
              className="h-8 gap-1.5 text-[11.5px]"
              onClick={() => setImportOpen(true)}
            >
              <Upload className="size-3.5" />
              导入技能
            </Button>
            <Button
              size="sm"
              data-testid="skill-creator"
              className="h-8 gap-1.5 text-[11.5px]"
              onClick={() => setCreatorOpen(true)}
            >
              <Sparkles className="size-3.5" />
              帮我制作 · mock
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-4xl px-5 py-8">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          技能决定这一轮怎么做
        </h1>
        <p className="mt-1.5 max-w-2xl text-[12.5px] leading-6 text-muted-foreground">
          技能是一个带 frontmatter 的目录：
          <code className="rounded bg-muted px-1">SKILL.md</code> 、可选的 references 与
          scripts。当前是本地原型：文件与设置只保存在浏览器 localStorage，
          不调用模型、不写入磁盘，也不执行脚本。
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-3 text-[11.5px] leading-5 text-muted-foreground">
          <p>
            启用技能后，在 Chat 的下一轮输入它的 slug（如 frontend-design），即可查看模拟的{' '}
            <code className="rounded bg-muted px-1">load_skill</code> 加载过程。
            启用但未信任的技能，其脚本请求会显示拒绝状态。
          </p>
          <Link
            href={chat ? `/prototype/c/${chat.id}` : '/prototype'}
            className="font-medium text-foreground underline underline-offset-4"
            data-testid="skill-open-chat"
          >
            {chat ? '去 Chat 验证技能' : '去创建 Chat 验证技能'}
          </Link>
        </div>

        <div className="mt-5 grid gap-2 sm:grid-cols-3">
          {[
            { label: '已启用', value: `${enabled} / ${state.skills.length}` },
            { label: '内置技能', value: String(builtin.length) },
            { label: '用户技能', value: String(user.length) },
          ].map((item) => (
            <div key={item.label} className="rounded-lg border border-border bg-card px-3 py-2.5">
              <div className="text-[10.5px] text-muted-foreground/70">{item.label}</div>
              <div className="mt-0.5 text-[15px] font-medium text-foreground">{item.value}</div>
            </div>
          ))}
        </div>

        <section className="mt-8">
          <div className="flex items-center gap-2">
            <h2 className="text-[13px] font-semibold text-foreground">内置技能</h2>
            <span className="text-[10.5px] text-muted-foreground/70">只读，随仓库发布</span>
          </div>
          <div className="mt-2 overflow-hidden rounded-lg border border-border bg-card">
            {hydrated
              ? builtin.map((skill) => (
                  <SkillRow
                    key={`${skill.source}:${skill.slug}`}
                    skill={skill}
                    onToggle={(value) =>
                      setSkill(`${skill.source}:${skill.slug}`, { enabled: value })
                    }
                  />
                ))
              : null}
          </div>
        </section>

        <section className="mt-8">
          <div className="flex items-center gap-2">
            <h2 className="text-[13px] font-semibold text-foreground">用户技能</h2>
            <span className="text-[10.5px] text-muted-foreground/70">
              仅保存在此浏览器的 localStorage
            </span>
          </div>
          <div className="mt-2 overflow-hidden rounded-lg border border-border bg-card">
            {user.length === 0 ? (
              <p className="px-3 py-6 text-center text-[11.5px] text-muted-foreground">
                还没有用户技能。导入本地文件，或者体验 mock 技能草稿。
              </p>
            ) : (
              user.map((skill) => (
                <SkillRow
                  key={`${skill.source}:${skill.slug}`}
                  skill={skill}
                  onToggle={(value) =>
                    setSkill(`${skill.source}:${skill.slug}`, { enabled: value })
                  }
                  onTrust={(value) => {
                    setSkill(`${skill.source}:${skill.slug}`, {
                      trusted: value,
                      enabled: value,
                    });
                    toast[value ? 'success' : 'info'](
                      value ? `已信任「${skill.name}」` : `已取消信任「${skill.name}」`,
                      {
                        description: value
                          ? '本地原型已记录信任并启用；脚本仍仅模拟，不会实际执行。'
                          : '已停用；再次启用后，脚本请求仍会被拒绝。',
                      },
                    );
                  }}
                  onRemove={() => {
                    removeSkill(`${skill.source}:${skill.slug}`);
                    toast.success(`已删除「${skill.name}」`);
                  }}
                />
              ))
            )}
          </div>
        </section>

        <div className="mt-5 flex gap-2 rounded-lg border border-amber-200 bg-amber-50/70 p-3 text-[11px] leading-5 text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          <ShieldAlert className="mt-0.5 size-3.5 shrink-0" />
          <div>
            <p className="font-medium">信任是导入时的一次显式确认</p>
            <p>
              未信任的技能可以启用并加载正文，但脚本请求会显示拒绝。
              信任状态只用于演示权限判断，本地原型不会执行任何技能脚本，
              也不会把文件上传或挂载到沙箱。请先核对导入清单。
            </p>
          </div>
        </div>
      </main>

      <ImportSkillDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        onImport={(slug, description, trusted, files, contents) => {
          importSkill(slug, description, files, contents);
          if (trusted) setSkill(`user:${slug}`, { trusted: true, enabled: true });
          toast.success(`已导入「${slug}」`, {
            description: trusted
              ? '已保存在此浏览器，标记为信任并启用；不会实际执行脚本。'
              : '已保存在此浏览器；请启用后去 Chat 验证，脚本请求将被拒绝。',
          });
        }}
        existing={user.map((skill) => skill.slug)}
      />

      <SkillCreatorDialog
        open={creatorOpen}
        onOpenChange={setCreatorOpen}
        onSave={(slug, description) => {
          importSkill(slug, description, ['SKILL.md'], { 'SKILL.md': WEEKLY_SKILL_CONTENT });
          toast.success(`技能「${slug}」已保存到本地原型`, {
            description: '仅保存在此浏览器，默认未信任；启用后可在下一轮 Chat 输入 slug 验证。',
          });
        }}
        existing={user.map((skill) => skill.slug)}
      />
    </div>
  );
}

function SkillRow({
  skill,
  onToggle,
  onTrust,
  onRemove,
}: {
  skill: Skill;
  onToggle: (value: boolean) => void;
  onTrust?: (value: boolean) => void;
  onRemove?: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div
      data-skill-key={`${skill.source}:${skill.slug}`}
      className="border-b border-border/60 last:border-b-0"
    >
      <div className="flex items-start gap-2.5 px-3 py-2.5">
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          className="min-w-0 flex-1 text-left"
        >
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-mono text-[11.5px] font-medium text-foreground">
              {skill.slug}
            </span>
            {skill.source === 'user' ? (
              <span
                className={cn(
                  'flex items-center gap-0.5 rounded px-1 py-0.5 text-[9px]',
                  skill.trusted
                    ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300'
                    : 'bg-amber-50 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300',
                )}
              >
                {skill.trusted ? (
                  <ShieldCheck className="size-2.5" />
                ) : (
                  <ShieldAlert className="size-2.5" />
                )}
                {skill.trusted ? '已信任' : '未信任'}
              </span>
            ) : (
              <span className="rounded bg-muted px-1 py-0.5 text-[9px] text-muted-foreground">
                内置
              </span>
            )}
            <ChevronDown
              className={cn(
                'size-3 text-muted-foreground/40 transition-transform',
                open && 'rotate-180',
              )}
            />
          </div>
          <p className="mt-0.5 text-[11px] leading-4 text-muted-foreground">{skill.description}</p>
          {open ? (
            <div className="mt-1.5 space-y-1 rounded border border-border/60 bg-muted/40 p-2">
              <div className="flex items-center gap-1 text-[10px] text-muted-foreground/70">
                <FolderOpen className="size-3" />
                {skill.source === 'builtin' ? '内置示例' : '浏览器本地'} · {skill.slug}/
              </div>
              {skill.files.map((file) => (
                <div
                  key={file}
                  className="flex items-center gap-1.5 font-mono text-[10.5px] text-muted-foreground"
                >
                  <BookLock className="size-3 text-muted-foreground/70" />
                  {file}
                </div>
              ))}
              <p className="pt-0.5 text-[10px] leading-4 text-muted-foreground/70">
                启用后在下一轮 Chat 输入 {skill.slug}，查看模拟加载；脚本不实际执行。
              </p>
            </div>
          ) : null}
        </button>

        <div className="flex shrink-0 items-center gap-2 pt-0.5">
          {onTrust ? (
            <button
              type="button"
              onClick={() => onTrust(!skill.trusted)}
              className={cn(
                'rounded border px-1.5 py-0.5 text-[9.5px]',
                skill.trusted
                  ? 'border-border text-muted-foreground hover:bg-muted/40'
                  : 'border-amber-300 bg-amber-50 text-amber-800 hover:bg-amber-100 dark:border-amber-800 dark:bg-amber-950/50 dark:text-amber-200 dark:hover:bg-amber-950',
              )}
            >
              {skill.trusted ? '取消信任' : '信任并启用'}
            </button>
          ) : null}
          <Switch checked={skill.enabled} onCheckedChange={onToggle} />
          {onRemove ? (
            <button
              type="button"
              onClick={onRemove}
              className="rounded p-1 text-muted-foreground/70 hover:bg-muted hover:text-red-600 dark:hover:text-red-400"
            >
              <Trash2 className="size-3.5" />
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function ImportSkillDialog({
  open,
  onOpenChange,
  onImport,
  existing,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImport: (
    slug: string,
    description: string,
    trusted: boolean,
    files: string[],
    contents: Record<string, string>,
  ) => void;
  existing: string[];
}) {
  const [slug, setSlug] = useState('brand-voice-2');
  const [description, setDescription] = useState('把品牌语气约束成一份可复用的写作规则。');
  const [trusted, setTrusted] = useState(false);
  const [contents, setContents] = useState<Record<string, string>>(MOCK_IMPORT_CONTENTS);
  const [source, setSource] = useState<'mock' | 'files'>('mock');
  const [reading, setReading] = useState(false);
  const [fileError, setFileError] = useState('');
  const selection = useRef(0);
  const duplicate = existing.includes(slug.trim());
  const files = Object.keys(contents);
  const validSlug = /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug.trim());

  async function readFiles(selected: FileList | null) {
    if (!selected?.length) return;
    const request = ++selection.current;
    setReading(true);
    setFileError('');
    setTrusted(false);
    setSource('files');
    setContents({});
    try {
      const chosen = Array.from(selected);
      if (
        chosen.length > 100 ||
        chosen.reduce((total, file) => total + file.size, 0) > 512 * 1024
      ) {
        throw new Error('本地原型最多导入 100 个文本文件，总大小不超过 512 KB。');
      }
      const paths = chosen.map((file) => file.webkitRelativePath || file.name);
      const root = paths[0].includes('/') ? paths[0].split('/')[0] + '/' : '';
      const relativePaths = paths.map((path) =>
        root && path.startsWith(root) ? path.slice(root.length) : path,
      );
      if (new Set(relativePaths).size !== relativePaths.length) {
        throw new Error('所选文件存在重名；请使用目录选择，以保留子目录路径。');
      }
      if (
        relativePaths.some((path) =>
          path.split('/').some((part) => !part || part === '.' || part === '..'),
        )
      ) {
        throw new Error('文件路径无效，请重新选择技能目录。');
      }
      if (!relativePaths.includes('SKILL.md')) {
        throw new Error('请选择包含根目录 SKILL.md 的技能文件；支持同时选择多个文本文件。');
      }
      const entries = await Promise.all(
        chosen.map(async (file, index) => {
          const text = await file.text();
          if (text.includes('\u0000')) throw new Error('只支持文本文件，请移除二进制文件后重试。');
          return [relativePaths[index], text] as const;
        }),
      );
      if (request !== selection.current) return;
      setContents(Object.fromEntries(entries));
      if (root) setSlug(root.slice(0, -1));
    } catch (error) {
      if (request === selection.current) {
        setFileError(error instanceof Error ? error.message : '文件读取失败，请重新选择。');
      }
    } finally {
      if (request === selection.current) setReading(false);
    }
  }

  function useMockFiles() {
    selection.current += 1;
    setReading(false);
    setFileError('');
    setSource('mock');
    setContents(MOCK_IMPORT_CONTENTS);
    setSlug('brand-voice-2');
    setDescription('把品牌语气约束成一份可复用的写作规则。');
    setTrusted(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-base">导入技能</DialogTitle>
          <DialogDescription className="text-xs">
            选择本地文本文件或使用 mock 示例。只在浏览器读取并保存到 localStorage，不上传、不执行。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-2 rounded-md border border-border p-2.5">
            <label className="block text-[11px] text-muted-foreground" htmlFor="skill-files">
              多选技能文件（含 SKILL.md，平铺文件名）
            </label>
            <input
              id="skill-files"
              data-testid="skill-file-input"
              type="file"
              multiple
              className="block w-full text-[11px] text-muted-foreground file:mr-2 file:rounded file:border file:border-border file:bg-muted file:px-2 file:py-1 file:text-foreground"
              onChange={(event) => {
                void readFiles(event.target.files);
                event.target.value = '';
              }}
            />
            <label className="block text-[11px] text-muted-foreground" htmlFor="skill-directory">
              或选择整个技能目录（保留 references / scripts 路径）
            </label>
            <input
              id="skill-directory"
              data-testid="skill-directory-input"
              type="file"
              multiple
              ref={(input) => {
                input?.setAttribute('webkitdirectory', '');
              }}
              className="block w-full text-[11px] text-muted-foreground file:mr-2 file:rounded file:border file:border-border file:bg-muted file:px-2 file:py-1 file:text-foreground"
              onChange={(event) => {
                void readFiles(event.target.files);
                event.target.value = '';
              }}
            />
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-[10.5px]"
              onClick={useMockFiles}
            >
              使用示例目录 · mock
            </Button>
            <p className="text-[10px] leading-4 text-muted-foreground/70">
              {reading
                ? '正在浏览器中读取…'
                : source === 'mock'
                  ? '当前清单为内置 mock 示例，并非你磁盘上的文件。'
                  : '当前清单来自你选择的本地文件；slug 与描述可在下方填写。'}{' '}
              最多 100 个文本文件、合计 512 KB。
            </p>
            {fileError ? (
              <p role="alert" className="text-[10.5px] text-red-600 dark:text-red-400">
                {fileError}
              </p>
            ) : null}
          </div>
          <div className="space-y-1.5">
            <label className="text-[11px] text-muted-foreground" htmlFor="skill-slug">
              slug
            </label>
            <Input
              id="skill-slug"
              value={slug}
              onChange={(event) => setSlug(event.target.value)}
              className="h-8 font-mono text-[11.5px]"
            />
            {duplicate ? (
              <p className="text-[10.5px] text-red-600 dark:text-red-400">
                用户技能中已存在这个 slug；与内置技能同名可以导入。
              </p>
            ) : null}
            {slug.trim() && !validSlug ? (
              <p className="text-[10.5px] text-red-600 dark:text-red-400">
                slug 仅使用小写字母、数字和单个连字符。
              </p>
            ) : null}
          </div>
          <div className="space-y-1.5">
            <label className="text-[11px] text-muted-foreground" htmlFor="skill-desc">
              描述（会进系统提示）
            </label>
            <Textarea
              id="skill-desc"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              className="min-h-16 text-[12px]"
            />
          </div>

          <div className="rounded-md border border-border">
            <div className="flex items-center gap-1.5 border-b border-border/60 bg-muted/40 px-2.5 py-1.5 text-[10px] text-muted-foreground">
              <FolderOpen className="size-3" />
              将保存到此浏览器 · {slug || '…'}/ · {files.length} 个文件
            </div>
            <div className="max-h-36 space-y-1 overflow-auto p-2">
              {files.map((file) => (
                <div
                  key={file}
                  className="flex items-center gap-1.5 font-mono text-[10.5px] text-muted-foreground"
                >
                  {file.endsWith('SKILL.md') ? (
                    <BookLock className="size-3 text-muted-foreground/70" />
                  ) : (
                    <FolderOpen className="size-3 text-muted-foreground/70" />
                  )}
                  {file}
                </div>
              ))}
            </div>
          </div>

          <label className="flex items-start gap-2 rounded-md border border-border p-2.5">
            <input
              type="checkbox"
              checked={trusted}
              onChange={(event) => setTrusted(event.target.checked)}
              className="mt-0.5 size-3.5 accent-stone-900"
            />
            <span className="text-[11px] leading-4 text-muted-foreground">
              我确认信任并启用这个技能（仅记录本地原型状态）。未勾选仍可启用并读正文，但脚本请求会被拒绝；勾选也不会实际执行脚本。
            </span>
          </label>
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button
            size="sm"
            data-testid="skill-import-confirm"
            disabled={
              !validSlug || duplicate || reading || !!fileError || !files.includes('SKILL.md')
            }
            onClick={() => {
              onImport(slug.trim(), description, trusted, files, contents);
              onOpenChange(false);
            }}
          >
            导入
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function SkillCreatorDialog({
  open,
  onOpenChange,
  onSave,
  existing,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (slug: string, description: string) => void;
  existing: string[];
}) {
  const [prompt, setPrompt] = useState(
    '帮我做一个技能：把每天的周报整理成固定结构，先写结论再写风险。',
  );
  const [phase, setPhase] = useState<'idle' | 'writing' | 'ready'>('idle');
  const slug = 'weekly-report-format';

  function generate() {
    setPhase('writing');
    window.setTimeout(() => setPhase('ready'), 900);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        onOpenChange(value);
        if (!value) setPhase('idle');
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <Sparkles className="size-4" />
            帮我制作技能 · mock
          </DialogTitle>
          <DialogDescription className="text-xs">
            本地原型展示固定的周报技能草稿，不调用模型，也不会按输入生成新内容。保存仅写入此浏览器的
            localStorage。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <Textarea
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            className="min-h-20 text-[12.5px]"
          />
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              data-testid="skill-generate"
              className="h-8 gap-1.5 text-[11.5px]"
              onClick={generate}
              disabled={phase === 'writing'}
            >
              {phase === 'writing' ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Sparkles className="size-3.5" />
              )}
              {phase === 'writing' ? '演示生成中…' : '查看 mock 草稿'}
            </Button>
            <span className="text-[10.5px] text-muted-foreground/70">
              固定示例，不连接模型或本地网关
            </span>
          </div>

          {phase === 'ready' ? (
            <div className="space-y-2">
              <div className="overflow-hidden rounded-md border border-border">
                <div className="flex items-center gap-1.5 border-b border-border/60 bg-muted/40 px-2.5 py-1.5 font-mono text-[10.5px] text-muted-foreground">
                  {slug}/SKILL.md
                </div>
                <pre className="max-h-56 overflow-auto p-2.5 font-mono text-[10.5px] leading-4 whitespace-pre-wrap text-foreground/90">
                  {WEEKLY_SKILL_CONTENT}
                </pre>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  className="h-8 gap-1.5 text-[11.5px]"
                  disabled={existing.includes(slug)}
                  onClick={() => {
                    if (!existing.includes(slug)) {
                      onSave(slug, WEEKLY_SKILL_DESCRIPTION);
                    }
                    onOpenChange(false);
                    setPhase('idle');
                  }}
                >
                  <Check className="size-3.5" />
                  {existing.includes(slug) ? '用户技能已存在' : '保存到本地原型'}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 text-[11.5px]"
                  onClick={generate}
                >
                  重新演示
                </Button>
              </div>
            </div>
          ) : null}

          {phase === 'idle' ? (
            <div className="flex items-start gap-2 rounded-md border border-border bg-muted/40 p-2.5 text-[10.5px] leading-4 text-muted-foreground">
              <Plus className="mt-0.5 size-3" />
              保存后出现在用户技能里，默认未信任。启用后在下一轮 Chat 输入 weekly-report-format，
              即可查看模拟 load_skill；不会调用模型或写入磁盘。
            </div>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
