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
  ChatBundle,
  ChatRecord,
  ChatSummary,
  DeployRequest,
  DeployResponse,
  DesignContext,
  EnvVar,
  Message,
  Model,
  Part,
  PromoteDraftResponse,
  ArchivedChatsResponse,
  DraftsResponse,
  Template,
  TemplatesResponse,
  Project,
  ProjectsResponse,
  RunAccepted,
  Skill,
  SseEvent,
} from '@/shared/api/schemas';
import { api, ApiRequestError, streamEvents } from '@/lib/api/client';

export type ImageAttachment = { url: string; name: string };

export type RunOptions = { selection?: DesignContext };

export type WorkspaceStore = {
  /** 兼容工作区组件的读取形状：当前项目、当前对话、同项目其他对话。 */
  state: {
    projects: Project[];
    chats: ChatRecord[];
    /** 还没决定变成项目的会话。 */
    drafts: ChatSummary[];
    /** 归档的会话：不出现在默认列表里，只在这里。 */
    archived: ChatSummary[];
    skills: Skill[];
    models: Model[];
    templates: Template[];
  };
  hydrated: boolean;
  error: string | null;
  clearError: () => void;
  refresh: () => Promise<void>;
  sendMessage: (
    chatId: string,
    text: string,
    images?: ImageAttachment[],
    options?: RunOptions,
  ) => void;
  stopGeneration: (chatId: string) => void;
  resolvePlan: (
    chatId: string,
    messageId: string,
    revision: number,
    decision: 'approved' | 'changes_requested' | 'rejected',
    feedback?: string,
  ) => void;
  rollbackTo: (chatId: string, versionId: string) => void;
  setViewVersion: (chatId: string, versionId: string) => void;
  setModel: (chatId: string, modelId: string) => void;
  createChat: (projectId: string) => void;
  promoteDraft: (chatId: string) => Promise<void>;
  renameChat: (chatId: string, title: string) => Promise<void>;
  archiveChat: (chatId: string) => Promise<void>;
  restoreChat: (chatId: string) => Promise<void>;
  renameProject: (projectId: string, name: string) => void;
  deleteProject: (projectId: string) => void;
  setEnv: (projectId: string, env: EnvVar[]) => void;
  recordDeploy: (projectId: string, versionId: string) => Promise<DeployResponse>;
};

const WorkspaceContext = createContext<WorkspaceStore | null>(null);

/** 草稿的 chats 是空列表，但当前会话本身一定要在里面，否则工作区找不到它。 */
function withCurrentChat(list: ChatSummary[], chat: ChatRecord | null): ChatRecord[] {
  const chats = list.map((summary) =>
    chat && summary.id === chat.id ? chat : emptyRecord(summary),
  );
  if (chat && !chats.some((item) => item.id === chat.id)) chats.unshift(chat);
  return chats;
}

function emptyRecord(summary: ChatSummary): ChatRecord {
  return {
    ...summary,
    pendingPlan: summary.pendingPlan ?? null,
    messages: [],
    versions: [],
  };
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
    return { ...message, streaming: false, status: event.status };
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
  const [drafts, setDrafts] = useState<ChatSummary[]>([]);
  const [projectList, setProjectList] = useState<Project[]>([]);
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
      versions: bundle.versions,
    });
  }, []);

  const refresh = useCallback(
    async (target = chatId) => {
      try {
        const [bundle, draftList, allProjects, archivedList] = await Promise.all([
          api.get<ChatBundle>(`/api/chats/${target}`),
          api.get<DraftsResponse>('/api/drafts'),
          api.get<ProjectsResponse>('/api/projects'),
          api.get<ArchivedChatsResponse>('/api/chats?archived=1'),
        ]);
        applyBundle(bundle);
        setDrafts(draftList.chats);
        setProjectList(allProjects.projects);
        setArchived(archivedList.chats);
        setError(null);
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
              setChat((current) =>
                current ? { ...current, liveSite: event.site, liveFiles: event.files } : current,
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
                      liveFiles: undefined,
                      liveSite: undefined,
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
        const [bundle, catalog, draftList, allProjects, archivedList] = await Promise.all([
          api.get<ChatBundle>(`/api/chats/${chatId}`),
          api.get<TemplatesResponse>('/api/templates'),
          api.get<DraftsResponse>('/api/drafts'),
          api.get<ProjectsResponse>('/api/projects'),
          api.get<ArchivedChatsResponse>('/api/chats?archived=1'),
        ]);
        if (cancelled) return;
        applyBundle(bundle);
        setTemplates(catalog.templates);
        setDrafts(draftList.chats);
        setProjectList(allProjects.projects);
        setArchived(archivedList.chats);
        setHydrated(true);
        // 首页建项目会立刻开始第一轮；进入工作区时要接上这条事件流。
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

  const startRound = useCallback(
    async (run: Promise<RunAccepted>, target: string) => {
      try {
        await run;
        await follow(target);
      } catch (cause) {
        setError(cause instanceof ApiRequestError ? cause.message : '请求失败');
        await refresh(target);
      }
    },
    [follow, refresh],
  );

  const sendMessage = useCallback(
    (target: string, text: string, images: ImageAttachment[] = [], options: RunOptions = {}) => {
      void startRound(
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

  const rollbackTo = useCallback(
    (target: string, versionId: string) => {
      void api
        .post(`/api/chats/${target}/versions/${versionId}/rollback`)
        .then(() => refresh(target))
        .catch((cause: unknown) =>
          setError(cause instanceof ApiRequestError ? cause.message : '回滚失败'),
        );
    },
    [refresh],
  );

  const setViewVersion = useCallback((target: string, versionId: string) => {
    setChat((current) =>
      current && current.id === target ? { ...current, viewVersionId: versionId } : current,
    );
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
      .then((next) => setProject(next))
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
      .then((next) => setProject(next))
      .catch((cause: unknown) =>
        setError(cause instanceof ApiRequestError ? cause.message : '保存环境变量失败'),
      );
  }, []);

  const recordDeploy = useCallback(async (projectId: string, versionId: string) => {
    const body: DeployRequest = { versionId };
    const result = await api.post<DeployResponse>(`/api/projects/${projectId}/deploys`, body);
    const next = await api.get<Project>(`/api/projects/${projectId}`);
    setProject(next);
    return result;
  }, []);

  const loadDrafts = useCallback(async () => {
    const [draftsData, archivedData] = await Promise.all([
      api.get<DraftsResponse>('/api/drafts'),
      api.get<ArchivedChatsResponse>('/api/chats?archived=1'),
    ]);
    setDrafts(draftsData.chats);
    setArchived(archivedData.chats);
  }, []);

  /** 改名：草稿与项目会话共用 PATCH。 */
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
      await loadDrafts();
      if (target !== chatId) return;
      // 归档的正好是当前会话：优先跳到同项目里另一条，其次草稿，都没有才回首页。
      const siblings = chatList.filter((item) => item.id !== target);
      const next = siblings[0]?.id ?? drafts.find((item) => item.id !== target)?.id ?? null;
      router.push(next ? `/chat/${next}` : '/');
    },
    [chatId, chatList, drafts, loadDrafts, router],
  );

  const restoreChat = useCallback(
    async (target: string) => {
      await api.post(`/api/chats/${target}/restore`, {});
      await loadDrafts();
    },
    [loadDrafts],
  );

  /** 草稿转项目：同一个会话就地转正，不复制、不部署。 */
  const promoteDraft = useCallback(
    async (target: string) => {
      await api.post<PromoteDraftResponse>(`/api/chats/${target}/project`, {});
      await refresh(target);
      await loadDrafts();
    },
    [refresh, loadDrafts],
  );

  const state = useMemo(
    () => ({
      // 侧栏要列出全部项目，草稿态也一样；当前项目以 bundle 里的最新值为准。
      projects: project
        ? [project, ...projectList.filter((item) => item.id !== project.id)]
        : projectList,
      chats: withCurrentChat(chatList, chat),
      drafts,
      archived,
      skills,
      models,
      templates,
    }),
    [archived, chat, chatList, drafts, models, project, projectList, skills, templates],
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
      rollbackTo,
      setViewVersion,
      setModel,
      createChat,
      promoteDraft,
      renameChat,
      archiveChat,
      restoreChat,
      renameProject,
      deleteProject,
      setEnv,
      recordDeploy,
    }),
    [
      state,
      hydrated,
      error,
      refresh,
      sendMessage,
      stopGeneration,
      resolvePlan,
      rollbackTo,
      setViewVersion,
      setModel,
      createChat,
      promoteDraft,
      renameChat,
      archiveChat,
      restoreChat,
      renameProject,
      deleteProject,
      setEnv,
      recordDeploy,
    ],
  );

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace(): WorkspaceStore {
  const store = useContext(WorkspaceContext);
  if (!store) throw new Error('useWorkspace 必须在 WorkspaceProvider 内使用');
  return store;
}
