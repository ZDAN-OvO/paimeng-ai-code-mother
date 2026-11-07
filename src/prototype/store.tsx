'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  MODELS,
  buildSite,
  deriveProjectName,
  nowIso,
  resolveTemplate,
  seedProjects,
  uid,
} from './mock-data';
import { changedPaths } from './diff';
import { finishRound, skillKey } from './flow';
import { runPrototypeRound } from './runner';
import type {
  Chat,
  Deploy,
  DemoIntent,
  EnvVar,
  Message,
  Part,
  Project,
  Skill,
  Version,
  RunOptions,
  RunStatus,
} from './types';

const STORAGE_KEY = 'paimeng.prototype.v1';

export type PrototypeState = { projects: Project[]; chats: Chat[]; skills: Skill[] };

type CreateProjectInput = { prompt: string; name?: string; templateId: string; modelId: string };
type ImageAttachment = { url: string; name: string };

type Store = {
  state: PrototypeState;
  hydrated: boolean;
  intent: DemoIntent;
  intentAt: number;
  setIntent: (intent: DemoIntent) => void;
  clearIntent: () => void;
  /** 草稿或其他页面带过来的预填文本，只落一次输入框，不写进 localStorage。 */
  pendingPrompt: string | null;
  setPendingPrompt: (text: string | null) => void;

  createProject: (input: CreateProjectInput) => { projectId: string; chatId: string };
  sendMessage: (
    chatId: string,
    text: string,
    images?: ImageAttachment[],
    options?: RunOptions,
  ) => void;
  resolvePlan: (
    chatId: string,
    messageId: string,
    revision: number,
    decision: 'approved' | 'changes_requested' | 'rejected',
    feedback?: string,
  ) => void;
  stopGeneration: (chatId: string) => void;
  rollbackTo: (chatId: string, versionId: string) => void;
  setViewVersion: (chatId: string, versionId: string) => void;
  setModel: (chatId: string, modelId: string) => void;
  createChat: (projectId: string) => string;

  renameProject: (projectId: string, name: string) => void;
  deleteProject: (projectId: string) => void;
  setEnv: (projectId: string, env: EnvVar[]) => void;
  recordDeploy: (projectId: string, versionId: string) => Deploy;
  findDeploy: (deployKey: string) => { project: Project; deploy: Deploy; version?: Version } | null;
  findProjectByChat: (chatId: string) => Project | undefined;

  setSkill: (slug: string, patch: Partial<Skill>) => void;
  importSkill: (
    slug: string,
    description: string,
    files?: string[],
    contents?: Record<string, string>,
  ) => void;
  removeSkill: (slug: string) => void;

  resetDemo: () => void;
};

const StoreContext = createContext<Store | null>(null);

function seed(): PrototypeState {
  const { projects, chats, skills } = seedProjects();
  return { projects, chats, skills };
}

function latestVersion(chat: Chat): Version | undefined {
  return chat.versions[chat.versions.length - 1];
}

export function PrototypeProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<PrototypeState>(() => seed());
  const stateRef = useRef(state);
  const [intent, setIntentState] = useState<DemoIntent>(null);
  const [intentAt, setIntentAt] = useState(0);
  const [pendingPrompt, setPendingPrompt] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const runs = useRef(new Map<string, { aborted: boolean }>());

  /** 同步写入 ref，让流式生成可以立刻读到刚创建的项目与聊天。 */
  const set = useCallback((updater: (current: PrototypeState) => PrototypeState) => {
    const next = updater(stateRef.current);
    stateRef.current = next;
    setState(next);
  }, []);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as PrototypeState;
        if (
          Array.isArray(parsed.projects) &&
          Array.isArray(parsed.chats) &&
          Array.isArray(parsed.skills)
        ) {
          const restored: PrototypeState = {
            projects: parsed.projects,
            skills: parsed.skills
              .map((skill) =>
                skill.source !== 'builtin'
                  ? skill
                  : {
                      ...skill,
                      slug:
                        skill.slug === 'shadcn-ui'
                          ? 'shadcn'
                          : skill.slug === 'nextjs-app-router'
                            ? 'nextjs'
                            : skill.slug,
                    },
              )
              .concat(
                seed().skills.filter(
                  (skill) =>
                    skill.source === 'builtin' &&
                    skill.slug === 'debug-and-verify' &&
                    !parsed.skills.some((old) => old.slug === skill.slug),
                ),
              ),
            chats: parsed.chats.map((chat) => {
              const project = parsed.projects.find((item) => item.id === chat.projectId);
              let restoredChat = chat;
              for (const message of chat.messages.filter(
                (item) => item.streaming || item.status === 'running',
              )) {
                restoredChat = finishRound(
                  restoredChat,
                  message.id,
                  'stopped',
                  '刷新中断；保留本地工作，等待手动重试。',
                  buildSite(project?.templateId ?? 'landing', project?.name ?? '示例项目', 1),
                  uid('ver'),
                  nowIso(),
                );
              }
              return {
                ...restoredChat,
                streaming: false,
                messages: restoredChat.messages.map((message) => ({
                  ...message,
                  streaming: false,
                })),
              };
            }),
          };
          stateRef.current = restored;
          // 演示数据来自 localStorage，第一次挂载后替换种子状态是这里唯一正确的同步点。
          // eslint-disable-next-line react-hooks/set-state-in-effect
          setState(restored);
        }
      }
    } catch {
      // 原型不处理损坏的演示数据，直接回落到种子。
    }
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    const timer = window.setTimeout(() => {
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      } catch {
        // 忽略配额错误：原型不依赖持久化。
      }
    }, 300);
    return () => window.clearTimeout(timer);
  }, [state, hydrated]);

  const setIntent = useCallback((next: DemoIntent) => {
    setIntentState(next);
    setIntentAt((value) => value + 1);
  }, []);

  const clearIntent = useCallback(() => setIntentState(null), []);

  const patchChat = useCallback(
    (chatId: string, fn: (chat: Chat) => Chat) => {
      set((current) => ({
        ...current,
        chats: current.chats.map((chat) => (chat.id === chatId ? fn(chat) : chat)),
      }));
    },
    [set],
  );

  const patchMessage = useCallback(
    (chatId: string, messageId: string, fn: (message: Message) => Message) => {
      patchChat(chatId, (chat) => ({
        ...chat,
        messages: chat.messages.map((message) =>
          message.id === messageId ? fn(message) : message,
        ),
      }));
    },
    [patchChat],
  );

  const pushPart = useCallback(
    (chatId: string, messageId: string, part: Part): number => {
      let index = 0;
      patchMessage(chatId, messageId, (message) => {
        index = message.parts.length;
        return { ...message, parts: [...message.parts, part] };
      });
      return index;
    },
    [patchMessage],
  );

  const finish = useCallback(
    (chatId: string, messageId: string, status: RunStatus, summary: string) => {
      const chat = stateRef.current.chats.find((item) => item.id === chatId);
      const project = stateRef.current.projects.find((item) => item.id === chat?.projectId);
      if (!chat || !project) return;
      patchMessage(chatId, messageId, (message) => ({
        ...message,
        parts: [
          ...message.parts.filter((part) => part.type !== 'text'),
          { type: 'text', text: summary },
        ],
      }));
      patchChat(chatId, (current) =>
        finishRound(
          current,
          messageId,
          status,
          summary,
          buildSite(project.templateId, project.name, 1),
          uid('ver'),
          nowIso(),
        ),
      );
    },
    [patchChat, patchMessage],
  );

  const proposePlan = useCallback(
    (chatId: string, prompt: string, revision = 1, feedback = '') => {
      const messageId = uid('msg');
      const plan: Part = {
        type: 'plan',
        revision,
        title: prompt,
        steps: [
          '只读检查当前项目与相关技能，明确改动范围。',
          feedback ? `按反馈调整方案：${feedback}` : '保留现有视觉，修改必要组件与文案。',
          '模拟验证当前修订，再核对完成条件；未经批准不写入文件。',
        ],
        status: 'pending',
      };
      patchChat(chatId, (chat) => ({
        ...chat,
        pendingPlan: { messageId, revision, prompt },
        messages: [
          ...chat.messages,
          {
            id: messageId,
            role: 'assistant',
            parts: [plan],
            createdAt: nowIso(),
            streaming: false,
            status: 'awaiting_approval',
          },
        ],
      }));
      finish(
        chatId,
        messageId,
        'awaiting_approval',
        '方案已提交，等待你批准、要求修改或拒绝。当前未修改项目文件。',
      );
    },
    [finish, patchChat],
  );

  const runGeneration = useCallback(
    async (chatId: string, options: RunOptions = {}) => {
      const chat = stateRef.current.chats.find((item) => item.id === chatId);
      const project = stateRef.current.projects.find((item) => item.id === chat?.projectId);
      if (!chat || !project || chat.streaming || chat.pendingPlan) return;
      const lastUser = [...chat.messages].reverse().find((item) => item.role === 'user');
      const prompt =
        lastUser?.parts
          .filter((part) => part.type === 'text')
          .map((part) => part.text)
          .join('') ?? '';
      if (
        !options.skipPlan &&
        (options.plan || /先规划|先做计划|先出方案|不要.*写代码/.test(prompt))
      ) {
        proposePlan(chatId, prompt);
        return;
      }
      const previous = latestVersion(chat);
      const run = { aborted: false };
      const messageId = uid('msg');
      runs.current.set(chatId, run);
      patchChat(chatId, (current) => ({
        ...current,
        streaming: true,
        updatedAt: nowIso(),
        liveFiles: { ...(previous?.files ?? {}) },
        liveSite: previous?.site,
        messages: [
          ...current.messages,
          {
            id: messageId,
            role: 'assistant',
            parts: [],
            createdAt: nowIso(),
            streaming: true,
            status: 'running',
          },
        ],
      }));
      try {
        const result = await runPrototypeRound({
          chat,
          project,
          prompt,
          options,
          run,
          skills: stateRef.current.skills,
          getChat: () => stateRef.current.chats.find((item) => item.id === chatId),
          patchChat: (update) => patchChat(chatId, update),
          patchMessage: (update) => patchMessage(chatId, messageId, update),
          push: (part) => pushPart(chatId, messageId, part),
        });
        const textIndex = pushPart(chatId, messageId, { type: 'text', text: '' });
        for (let offset = 0; offset < result.summary.length && !run.aborted; offset += 4) {
          const text = result.summary.slice(0, offset + 4);
          patchMessage(chatId, messageId, (message) => ({
            ...message,
            parts: message.parts.map((part, index) =>
              index === textIndex ? { type: 'text', text } : part,
            ),
          }));
          await new Promise<void>((resolve) => setTimeout(resolve, 18));
        }
        finish(
          chatId,
          messageId,
          run.aborted ? 'stopped' : result.status,
          run.aborted ? '已停止。已完成的本地工作已保留为版本。' : result.summary,
        );
      } catch {
        finish(chatId, messageId, 'failed', '前端演示遇到异常。已保留本轮工作，没有标记成功。');
      } finally {
        if (runs.current.get(chatId) === run) runs.current.delete(chatId);
      }
    },
    [finish, patchChat, patchMessage, proposePlan, pushPart],
  );

  const resolvePlan = useCallback(
    (
      chatId: string,
      messageId: string,
      revision: number,
      decision: 'approved' | 'changes_requested' | 'rejected',
      feedback = '',
    ) => {
      const chat = stateRef.current.chats.find((item) => item.id === chatId);
      const pending = chat?.pendingPlan;
      if (
        !chat ||
        chat.streaming ||
        !pending ||
        pending.messageId !== messageId ||
        pending.revision !== revision
      )
        return;
      if (decision === 'changes_requested' && !feedback.trim()) return;
      patchChat(chatId, (current) => ({
        ...current,
        pendingPlan: undefined,
        messages: current.messages.map((message) =>
          message.id !== messageId
            ? message
            : {
                ...message,
                status: decision === 'rejected' ? 'rejected' : 'succeeded',
                parts: message.parts.map((part) =>
                  part.type === 'plan'
                    ? { ...part, status: decision, feedback: feedback.trim() || undefined }
                    : part,
                ),
              },
        ),
      }));
      if (decision === 'changes_requested')
        proposePlan(chatId, pending.prompt, revision + 1, feedback.trim());
      if (decision === 'approved') void runGeneration(chatId, { skipPlan: true });
    },
    [patchChat, proposePlan, runGeneration],
  );

  const createProject = useCallback(
    (input: CreateProjectInput) => {
      const projectId = uid('proj');
      const chatId = uid('chat');
      const name = input.name?.trim() || deriveProjectName(input.prompt);
      const templateId = resolveTemplate(input.templateId, input.prompt);
      const createdAt = nowIso();
      const project: Project = {
        id: projectId,
        name,
        prompt: input.prompt,
        templateId,
        createdAt,
        updatedAt: createdAt,
        env: [],
        deployKey: null,
        deploys: [],
      };
      const chat: Chat = {
        id: chatId,
        projectId,
        title: name,
        modelId: input.modelId || MODELS[0].id,
        createdAt,
        updatedAt: createdAt,
        messages: [
          {
            id: uid('msg'),
            role: 'user',
            parts: [{ type: 'text', text: input.prompt }],
            createdAt,
          },
        ],
        versions: [],
        activeVersionId: null,
        viewVersionId: null,
        streaming: false,
      };
      set((current) => ({
        ...current,
        projects: [project, ...current.projects],
        chats: [chat, ...current.chats],
      }));
      void runGeneration(chatId);
      return { projectId, chatId };
    },
    [runGeneration, set],
  );

  const sendMessage = useCallback(
    (chatId: string, text: string, images: ImageAttachment[] = [], options: RunOptions = {}) => {
      const chat = stateRef.current.chats.find((item) => item.id === chatId);
      if (!chat || chat.streaming || chat.pendingPlan) return;
      const parts: Part[] = [
        ...images.map((image) => ({ type: 'image' as const, url: image.url, name: image.name })),
        ...(text.trim() ? [{ type: 'text' as const, text }] : []),
        ...(options.selection
          ? [{ type: 'selection' as const, selection: options.selection }]
          : []),
      ];
      patchChat(chatId, (current) => ({
        ...current,
        messages: [
          ...current.messages,
          { id: uid('msg'), role: 'user', parts, createdAt: nowIso() },
        ],
      }));
      void runGeneration(chatId, options);
    },
    [patchChat, runGeneration],
  );

  const stopGeneration = useCallback((chatId: string) => {
    const run = runs.current.get(chatId);
    if (run) run.aborted = true;
  }, []);

  const rollbackTo = useCallback(
    (chatId: string, versionId: string) => {
      const chat = stateRef.current.chats.find((item) => item.id === chatId);
      const target = chat?.versions.find((version) => version.id === versionId);
      if (!chat || !target || chat.streaming || chat.pendingPlan) return;
      const active = latestVersion(chat);
      const seq = chat.versions.length + 1;
      const newId = uid('ver');
      const createdAt = nowIso();
      const changed = changedPaths(active?.files ?? {}, target.files);
      const messageId = uid('msg');
      const version: Version = {
        id: newId,
        seq,
        chatId,
        messageId,
        label: `v${seq} · 回滚到 v${target.seq}`,
        summary: `工作区已恢复成 v${target.seq} 的源码树，并追加为 v${seq}。历史保持线性，随时可以再滚回来。`,
        createdAt,
        files: target.files,
        site: target.site,
        changedFiles: changed,
        restoredFrom: target.seq,
      };
      patchChat(chatId, (current) => ({
        ...current,
        updatedAt: createdAt,
        versions: [...current.versions, version],
        activeVersionId: newId,
        viewVersionId: newId,
        messages: [
          ...current.messages,
          {
            id: messageId,
            role: 'assistant',
            parts: [
              {
                type: 'text',
                text: `已把工作区回滚到 v${target.seq}，并追加为新版本 v${seq}。预览已经切到旧源码树，改过的文件也可以在 diff 里对比。`,
              },
            ],
            createdAt,
            finishedAt: createdAt,
            versionId: newId,
          },
        ],
      }));
    },
    [patchChat],
  );

  const setViewVersion = useCallback(
    (chatId: string, versionId: string) => {
      patchChat(chatId, (chat) => ({ ...chat, viewVersionId: versionId }));
    },
    [patchChat],
  );

  const setModel = useCallback(
    (chatId: string, modelId: string) => {
      patchChat(chatId, (chat) => ({ ...chat, modelId }));
    },
    [patchChat],
  );

  const createChat = useCallback(
    (projectId: string) => {
      const project = stateRef.current.projects.find((item) => item.id === projectId);
      const siblingChats = stateRef.current.chats.filter((chat) => chat.projectId === projectId);
      const latest = siblingChats
        .flatMap((chat) => chat.versions)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      const chatId = uid('chat');
      const createdAt = nowIso();
      const baseline: Version | null = latest
        ? {
            id: uid('ver'),
            seq: 1,
            chatId,
            messageId: null,
            label: 'v1 · 起点',
            summary: '新对话从项目当前源码树开始，历史消息不会带过来。',
            createdAt,
            files: latest.files,
            site: latest.site,
            changedFiles: [],
          }
        : null;
      set((current) => ({
        ...current,
        chats: [
          {
            id: chatId,
            projectId,
            title: `${project?.name ?? '新对话'} · 新对话`,
            modelId: siblingChats[0]?.modelId ?? MODELS[0].id,
            createdAt,
            updatedAt: createdAt,
            messages: [],
            versions: baseline ? [baseline] : [],
            activeVersionId: baseline?.id ?? null,
            viewVersionId: baseline?.id ?? null,
            streaming: false,
          },
          ...current.chats,
        ],
      }));
      return chatId;
    },
    [set],
  );

  const renameProject = useCallback(
    (projectId: string, name: string) => {
      set((current) => ({
        ...current,
        projects: current.projects.map((item) =>
          item.id === projectId ? { ...item, name, updatedAt: nowIso() } : item,
        ),
      }));
    },
    [set],
  );

  const deleteProject = useCallback(
    (projectId: string) => {
      set((current) => ({
        ...current,
        projects: current.projects.filter((item) => item.id !== projectId),
        chats: current.chats.filter((chat) => chat.projectId !== projectId),
      }));
    },
    [set],
  );

  const setEnv = useCallback(
    (projectId: string, env: EnvVar[]) => {
      set((current) => ({
        ...current,
        projects: current.projects.map((item) =>
          item.id === projectId ? { ...item, env, updatedAt: nowIso() } : item,
        ),
      }));
    },
    [set],
  );

  const recordDeploy = useCallback(
    (projectId: string, versionId: string): Deploy => {
      const project = stateRef.current.projects.find((item) => item.id === projectId);
      const version = stateRef.current.chats
        .flatMap((chat) => chat.versions)
        .find((item) => item.id === versionId);
      const deployKey =
        project?.deployKey ??
        `p-${Math.random().toString(36).slice(2, 8)}${Math.random().toString(36).slice(2, 6)}`;
      const deploy: Deploy = {
        id: uid('deploy'),
        deployKey,
        versionId,
        versionSeq: version?.seq ?? 0,
        state: 'ready',
        createdAt: nowIso(),
      };
      set((current) => ({
        ...current,
        projects: current.projects.map((item) =>
          item.id === projectId
            ? {
                ...item,
                deployKey,
                deploys: [deploy, ...item.deploys.filter((entry) => entry.versionId !== versionId)],
                updatedAt: nowIso(),
              }
            : item,
        ),
      }));
      return deploy;
    },
    [set],
  );

  const findDeploy = useCallback((deployKey: string) => {
    const project = stateRef.current.projects.find((item) => item.deployKey === deployKey);
    const deploy = project?.deploys.find((item) => item.deployKey === deployKey);
    if (!project || !deploy) return null;
    const version = stateRef.current.chats
      .flatMap((chat) => chat.versions)
      .find((item) => item.id === deploy.versionId);
    return { project, deploy, version };
  }, []);

  const findProjectByChat = useCallback(
    (chatId: string) =>
      stateRef.current.projects.find(
        (project) =>
          project.id === stateRef.current.chats.find((chat) => chat.id === chatId)?.projectId,
      ),
    [],
  );

  const setSkill = useCallback(
    (slug: string, patch: Partial<Skill>) => {
      set((current) => ({
        ...current,
        skills: current.skills.map((skill) =>
          skillKey(skill) === slug ? { ...skill, ...patch } : skill,
        ),
      }));
    },
    [set],
  );

  const importSkill = useCallback(
    (
      slug: string,
      description: string,
      files: string[] = ['SKILL.md'],
      contents?: Record<string, string>,
    ) => {
      if (stateRef.current.skills.some((skill) => skill.source === 'user' && skill.slug === slug))
        return;
      set((current) => ({
        ...current,
        skills: [
          ...current.skills,
          {
            slug,
            name: slug,
            description,
            source: 'user' as const,
            trusted: false,
            enabled: false,
            files: [...files],
            contents,
          },
        ],
      }));
    },
    [set],
  );

  const removeSkill = useCallback(
    (slug: string) => {
      set((current) => ({
        ...current,
        skills: current.skills.filter(
          (skill) => skillKey(skill) !== slug || skill.source === 'builtin',
        ),
      }));
    },
    [set],
  );

  const resetDemo = useCallback(() => {
    runs.current.forEach((run) => {
      run.aborted = true;
    });
    runs.current.clear();
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      // ignore
    }
    const fresh = seed();
    stateRef.current = fresh;
    setState(fresh);
    setIntentState(null);
  }, []);

  const value = useMemo<Store>(
    () => ({
      state,
      hydrated,
      intent,
      intentAt,
      setIntent,
      clearIntent,
      pendingPrompt,
      setPendingPrompt,
      createProject,
      sendMessage,
      resolvePlan,
      stopGeneration,
      rollbackTo,
      setViewVersion,
      setModel,
      createChat,
      renameProject,
      deleteProject,
      setEnv,
      recordDeploy,
      findDeploy,
      findProjectByChat,
      setSkill,
      importSkill,
      removeSkill,
      resetDemo,
    }),
    [
      state,
      hydrated,
      intent,
      intentAt,
      setIntent,
      clearIntent,
      pendingPrompt,
      setPendingPrompt,
      createProject,
      sendMessage,
      resolvePlan,
      stopGeneration,
      rollbackTo,
      setViewVersion,
      setModel,
      createChat,
      renameProject,
      deleteProject,
      setEnv,
      recordDeploy,
      findDeploy,
      findProjectByChat,
      setSkill,
      importSkill,
      removeSkill,
      resetDemo,
    ],
  );

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function usePrototype(): Store {
  const store = useContext(StoreContext);
  if (!store) throw new Error('usePrototype must be used inside PrototypeProvider');
  return store;
}
