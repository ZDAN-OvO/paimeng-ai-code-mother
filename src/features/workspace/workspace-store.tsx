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
import { useRouter } from 'next/navigation';
import type {
  ArchivedChatsResponse,
  ChatBundle,
  ChatRecord,
  ChatSummary,
  DesignContext,
  EnvVar,
  Message,
  Model,
  Part,
  Project,
  ProjectSummary,
  ProjectsResponse,
  RunAccepted,
  Skill,
  SseEvent,
  Template,
  TemplatesResponse,
  UndoChangeSetResponse,
} from '@/shared/api/schemas';
import { api, ApiRequestError, streamEvents } from '@/lib/api/client';

export type ImageAttachment = { url: string; name: string };

export type RunOptions = { selection?: DesignContext };

export type WorkspaceState = {
  /** 当前项目：当前文件、预览、改动记录都以它为准。 */
  project: Project | null;
  projects: ProjectSummary[];
  /** 当前项目下的对话，包含正在打开的这一条。 */
  chats: ChatRecord[];
  archived: ChatSummary[];
  skills: Skill[];
  models: Model[];
  templates: Template[];
};

export type WorkspaceStore = {
  state: WorkspaceState;
  hydrated: boolean;
  error: string | null;
  clearError: () => void;
  refresh: () => Promise<void>;
  sendMessage: (
    chatId: string,
    text: string,
    images?: ImageAttachment[],
    options?: RunOptions,
  ) => Promise<boolean>;
  stopGeneration: (chatId: string) => void;
  resolvePlan: (
    chatId: string,
    messageId: string,
    revision: number,
    decision: 'approved' | 'changes_requested' | 'rejected',
    feedback?: string,
  ) => void;
  undoChangeSet: (projectId: string, changeSetId: string) => Promise<void>;
  setModel: (chatId: string, modelId: string) => void;
  createChat: (projectId: string) => void;
  renameChat: (chatId: string, title: string) => Promise<void>;
  archiveChat: (chatId: string) => Promise<void>;
  restoreChat: (chatId: string) => Promise<void>;
  renameProject: (projectId: string, name: string) => void;
  deleteProject: (projectId: string) => void;
  setEnv: (projectId: string, env: EnvVar[]) => void;
};

const WorkspaceContext = createContext<WorkspaceStore | null>(null);

function emptyRecord(summary: ChatSummary): ChatRecord {
  return {
    ...summary,
    pendingPlan: summary.pendingPlan ?? null,
    messages: [],
  };
}

/** 当前对话一定在列表里，否则工作区找不到它。 */
function withCurrentChat(list: ChatSummary[], chat: ChatRecord | null): ChatRecord[] {
  const chats = list.map((summary) =>
    chat && summary.id === chat.id ? chat : emptyRecord(summary),
  );
  if (chat && !chats.some((item) => item.id === chat.id)) chats.unshift(chat);
  return chats;
}

function applyEventToMessage(message: Message, event: SseEvent): Message {
  if (event.type === 'part-added') {
    if (message.parts.some((part) => part.id === event.part.id)) return message;
    return { ...message, parts: [...message.parts, event.part] };
  }
  if (event.type === 'part-updated') {
    return {
      ...message,
      parts: message.parts.map((part) =>
        part.id === event.partId ? ({ ...part, ...event.patch } as Part) : part,
      ),
    };
  }
  if (event.type === 'text-delta') {
    return {
      ...message,
      parts: message.parts.map((part) =>
        part.id === event.partId && part.type === 'text'
          ? { ...part, text: part.text + event.delta }
          : part,
      ),
    };
  }
  if (event.type === 'finish') {
    return {
      ...message,
      streaming: false,
      status: event.status,
      completionReviewed: event.completionReviewed,
      changeSetId: event.changeSetId ?? undefined,
    };
  }
  return message;
}

export function WorkspaceProvider({ chatId, children }: { chatId: string; children: ReactNode }) {
  const router = useRouter();
  const [chat, setChat] = useState<ChatRecord | null>(null);
  const [project, setProject] = useState<Project | null>(null);
  const [chatList, setChatList] = useState<ChatSummary[]>([]);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [models, setModels] = useState<Model[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [projectList, setProjectList] = useState<ProjectSummary[]>([]);
  const [archived, setArchived] = useState<ChatSummary[]>([]);
  const [hydrated, setHydrated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const applyBundle = useCallback((bundle: ChatBundle) => {
    setProject(bundle.project);
    setChatList(bundle.chats);
    setSkills(bundle.skills);
    setModels(bundle.models);
    setChat({
      ...bundle.chat,
      pendingPlan: bundle.chat.pendingPlan ?? null,
      messages: bundle.messages,
    });
  }, []);

  const refresh = useCallback(
    async (target = chatId) => {
      try {
        const [bundle, allProjects, archivedList] = await Promise.all([
          api.get<ChatBundle>(`/api/chats/${target}`),
          api.get<ProjectsResponse>('/api/projects'),
          api.get<ArchivedChatsResponse>('/api/chats?archived=1'),
        ]);
        applyBundle(bundle);
        setProjectList(allProjects.projects);
        setArchived(archivedList.chats);
      } catch (cause) {
        if (cause instanceof ApiRequestError) setError(cause.message);
      } finally {
        setHydrated(true);
      }
    },
    [applyBundle, chatId],
  );

  const follow = useCallback(
    async (target: string) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        await streamEvents<SseEvent>(
          `/api/chats/${target}/events`,
          (event) => {
            if (event.type === 'snapshot') {
              if (!event.message) return;
              const message = event.message;
              setChat((current) =>
                current
                  ? {
                      ...current,
                      streaming: true,
                      messages: current.messages.some((item) => item.id === message.id)
                        ? current.messages.map((item) => (item.id === message.id ? message : item))
                        : [...current.messages, message],
                    }
                  : current,
              );
              return;
            }
            if (event.type === 'preview') {
              // 工具写入直接改项目共享文件；代码面板与预览跟着同一份内容走。
              setProject((current) =>
                current ? { ...current, files: event.files, site: event.site } : current,
              );
              return;
            }
            if (event.type === 'error') {
              setError(event.message);
              return;
            }
            if (event.type === 'finish') {
              // 事件流可能还会开着一会儿；先按 finish 收尾，避免界面一直以为在生成。
              setChat((current) =>
                current
                  ? {
                      ...current,
                      streaming: false,
                      messages: current.messages.map((item) =>
                        item.id === event.messageId ? applyEventToMessage(item, event) : item,
                      ),
                    }
                  : current,
              );
              void refresh(target);
              return;
            }
            setChat((current) =>
              current
                ? {
                    ...current,
                    messages: current.messages.map((item) =>
                      item.id === event.messageId ? applyEventToMessage(item, event) : item,
                    ),
                  }
                : current,
            );
          },
          controller.signal,
        );
      } catch (cause) {
        if (!controller.signal.aborted) {
          if (cause instanceof DOMException && cause.name === 'AbortError') return;
          setError(cause instanceof ApiRequestError ? cause.message : '生成过程连接中断');
        }
      } finally {
        if (!controller.signal.aborted) await refresh(target);
      }
    },
    [refresh],
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [bundle, catalog, allProjects, archivedList] = await Promise.all([
          api.get<ChatBundle>(`/api/chats/${chatId}`),
          api.get<TemplatesResponse>('/api/templates'),
          api.get<ProjectsResponse>('/api/projects'),
          api.get<ArchivedChatsResponse>('/api/chats?archived=1'),
        ]);
        if (cancelled) return;
        applyBundle(bundle);
        setTemplates(catalog.templates);
        setProjectList(allProjects.projects);
        setArchived(archivedList.chats);
        setHydrated(true);
        // 上一轮还没结束时进入工作区：接上这条事件流，预览继续跟着写。
        if (bundle.chat.streaming) void follow(chatId);
      } catch (cause) {
        if (cancelled) return;
        setError(cause instanceof ApiRequestError ? cause.message : '加载对话失败');
        setHydrated(true);
      }
    })();
    return () => {
      cancelled = true;
      abortRef.current?.abort();
    };
  }, [applyBundle, chatId, follow]);

  // 空闲对话也同步项目，才能发现其他窗口后来启动的任务；本对话运行时由 SSE 更新。
  useEffect(() => {
    if (!hydrated || chat?.streaming) return;
    const timer = window.setInterval(() => void refresh(), 1000);
    return () => window.clearInterval(timer);
  }, [refresh, hydrated, chat?.streaming]);

  const startRound = useCallback(
    async (run: Promise<RunAccepted>, target: string): Promise<boolean> => {
      setError(null);
      try {
        await run;
        void follow(target);
        return true;
      } catch (cause) {
        await refresh(target);
        setError(cause instanceof ApiRequestError ? cause.message : '请求失败');
        return false;
      }
    },
    [follow, refresh],
  );

  const sendMessage = useCallback(
    (target: string, text: string, images: ImageAttachment[] = [], options: RunOptions = {}) => {
      return startRound(
        api.post<RunAccepted>(`/api/chats/${target}/messages`, {
          text,
          attachments: images.map((image) => ({ name: image.name, dataUrl: image.url })),
          selection: options.selection,
        }),
        target,
      );
    },
    [startRound],
  );

  const resolvePlan = useCallback(
    (
      target: string,
      messageId: string,
      _revision: number,
      decision: 'approved' | 'changes_requested' | 'rejected',
      feedback?: string,
    ) => {
      void startRound(
        api.post<RunAccepted>(`/api/chats/${target}/plans/${messageId}`, { decision, feedback }),
        target,
      );
    },
    [startRound],
  );

  const stopGeneration = useCallback((target: string) => {
    void api.post(`/api/chats/${target}/stop`).catch(() => {});
  }, []);

  const undoChangeSet = useCallback(async (projectId: string, changeSetId: string) => {
    const result = await api.post<UndoChangeSetResponse>(
      `/api/projects/${projectId}/changesets/${changeSetId}/undo`,
    );
    setProject(result.project);
  }, []);

  const setModel = useCallback((target: string, modelId: string) => {
    setChat((current) => (current && current.id === target ? { ...current, modelId } : current));
    void api
      .patch(`/api/chats/${target}`, { modelId })
      .catch((cause: unknown) =>
        setError(cause instanceof ApiRequestError ? cause.message : '切换模型失败'),
      );
  }, []);

  const createChat = useCallback(
    (projectId: string) => {
      void api
        .post<ChatSummary>(`/api/projects/${projectId}/chats`, {})
        .then((created) => router.push(`/chat/${created.id}`))
        .catch((cause: unknown) =>
          setError(cause instanceof ApiRequestError ? cause.message : '新建对话失败'),
        );
    },
    [router],
  );

  const renameProject = useCallback((projectId: string, name: string) => {
    void api
      .patch<Project>(`/api/projects/${projectId}`, { name })
      .then((next) => {
        setProject((current) => (current?.id === next.id ? next : current));
        setProjectList((current) =>
          current.map((item) => (item.id === next.id ? { ...item, name: next.name } : item)),
        );
      })
      .catch((cause: unknown) =>
        setError(cause instanceof ApiRequestError ? cause.message : '重命名失败'),
      );
  }, []);

  const deleteProject = useCallback(
    (projectId: string) => {
      void api
        .delete(`/api/projects/${projectId}`)
        .then(() => router.push('/'))
        .catch((cause: unknown) =>
          setError(cause instanceof ApiRequestError ? cause.message : '删除项目失败'),
        );
    },
    [router],
  );

  const setEnv = useCallback((projectId: string, env: EnvVar[]) => {
    void api
      .put<Project>(`/api/projects/${projectId}/env`, { env })
      .then((next) => setProject((current) => (current?.id === next.id ? next : current)))
      .catch((cause: unknown) =>
        setError(cause instanceof ApiRequestError ? cause.message : '保存环境变量失败'),
      );
  }, []);

  const loadArchived = useCallback(async () => {
    const archivedData = await api.get<ArchivedChatsResponse>('/api/chats?archived=1');
    setArchived(archivedData.chats);
  }, []);

  const renameChat = useCallback(
    async (target: string, title: string) => {
      await api.patch(`/api/chats/${target}`, { title });
      await refresh(target === chatId ? target : undefined);
    },
    [chatId, refresh],
  );

  /** 归档不是删除：归档后还能在「对话 → 归档」里恢复。 */
  const archiveChat = useCallback(
    async (target: string) => {
      await api.post(`/api/chats/${target}/archive`, {});
      await loadArchived();
      if (target !== chatId) return;
      // 归档的正好是当前会话：优先跳到同项目里另一条，没有就回工作区空态。
      const next = chatList.find((item) => item.id !== target)?.id ?? null;
      router.push(next ? `/chat/${next}` : '/');
    },
    [chatId, chatList, loadArchived, router],
  );

  const restoreChat = useCallback(
    async (target: string) => {
      await api.post(`/api/chats/${target}/restore`, {});
      await loadArchived();
    },
    [loadArchived],
  );

  const state = useMemo<WorkspaceState>(
    () => ({
      project,
      projects: project
        ? [
            ...projectList.filter((item) => item.id !== project.id),
            {
              id: project.id,
              name: project.name,
              description: project.description,
              templateId: project.templateId,
              workspacePath: project.workspacePath,
              workspaceState: project.workspaceState,
              createdAt: project.createdAt,
              updatedAt: project.updatedAt,
              chatCount: chatList.length,
              changeCount: project.changeSets.length,
              lastChatId: chat?.id ?? null,
              thumb: project.site,
            },
          ].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        : projectList,
      chats: withCurrentChat(chatList, chat),
      archived,
      skills,
      models,
      templates,
    }),
    [archived, chat, chatList, models, project, projectList, skills, templates],
  );

  const value = useMemo<WorkspaceStore>(
    () => ({
      state,
      hydrated,
      error,
      clearError: () => setError(null),
      refresh: () => refresh(),
      sendMessage,
      stopGeneration,
      resolvePlan,
      undoChangeSet,
      setModel,
      createChat,
      renameChat,
      archiveChat,
      restoreChat,
      renameProject,
      deleteProject,
      setEnv,
    }),
    [
      state,
      hydrated,
      error,
      refresh,
      sendMessage,
      stopGeneration,
      resolvePlan,
      undoChangeSet,
      setModel,
      createChat,
      renameChat,
      archiveChat,
      restoreChat,
      renameProject,
      deleteProject,
      setEnv,
    ],
  );

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace(): WorkspaceStore {
  const store = useContext(WorkspaceContext);
  if (!store) throw new Error('useWorkspace 必须在 WorkspaceProvider 内使用');
  return store;
}
