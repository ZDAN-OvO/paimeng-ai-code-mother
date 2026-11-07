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
  Project,
  RunAccepted,
  Skill,
  SseEvent,
} from '@/shared/api/schemas';
import { api, ApiRequestError, streamEvents } from '@/lib/api/client';

export type ImageAttachment = { url: string; name: string };

export type RunOptions = { plan?: boolean; selection?: DesignContext };

export type WorkspaceStore = {
  /** 兼容工作区组件的读取形状：当前项目、当前对话、同项目其他对话。 */
  state: { projects: Project[]; chats: ChatRecord[]; skills: Skill[]; models: Model[] };
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
  renameProject: (projectId: string, name: string) => void;
  deleteProject: (projectId: string) => void;
  setEnv: (projectId: string, env: EnvVar[]) => void;
  recordDeploy: (projectId: string, versionId: string) => Promise<DeployResponse>;
};

const WorkspaceContext = createContext<WorkspaceStore | null>(null);

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
        const bundle = await api.get<ChatBundle>(`/api/chats/${target}`);
        applyBundle(bundle);
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
        const bundle = await api.get<ChatBundle>(`/api/chats/${chatId}`);
        if (cancelled) return;
        applyBundle(bundle);
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
          plan: options.plan,
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

  const state = useMemo(
    () => ({
      projects: project ? [project] : [],
      chats: chatList.map((summary) =>
        chat && summary.id === chat.id ? chat : emptyRecord(summary),
      ),
      skills,
      models,
    }),
    [chat, chatList, models, project, skills],
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
