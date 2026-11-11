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
import { api, ApiRequestError, streamEvents } from '@/lib/api/client';
import { errorMessage } from '@/lib/errors';
import type {
  ArchivedChatsResponse,
  ChatBundle,
  ChatSummary,
  CreateChatRequest,
  Message,
  Model,
  OpenProjectRequest,
  OpenProjectResponse,
  Part,
  Project,
  ProjectDetail,
  ProjectSummary,
  RunStatus,
  SseEvent,
} from '@/shared/api/schemas';
import {
  archivedChatsResponseSchema,
  chatBundleSchema,
  projectDetailSchema,
  projectsResponseSchema,
} from '@/shared/api/schemas';

export type RunState = { id: string; status: RunStatus; messageId: string } | null;
export type ConnectionState = 'idle' | 'connecting' | 'live' | 'reconnecting';

type WorkspaceContextValue = {
  bundle: ChatBundle | null;
  messages: Message[];
  chats: ChatSummary[];
  projects: ProjectSummary[];
  archived: ChatSummary[];
  models: Model[];
  run: RunState;
  summaries: Record<string, string>;
  connection: ConnectionState;
  filesVersion: number;
  loading: boolean;
  error: string | null;
  stopping: boolean;
  refresh: () => Promise<void>;
  sendMessage: (text: string) => Promise<boolean>;
  stopRun: () => Promise<void>;
  decideApproval: (approvalId: string, decision: 'approved' | 'rejected') => Promise<void>;
  createChat: (projectId: string) => Promise<ChatSummary | null>;
  renameChat: (chatId: string, title: string) => Promise<void>;
  archiveChat: (chatId: string) => Promise<boolean>;
  restoreChat: (chatId: string) => Promise<void>;
  renameProject: (name: string) => Promise<void>;
  setModel: (modelId: string) => Promise<void>;
  refreshFiles: () => Promise<void>;
  notifyFilesChanged: () => void;
  openProject: (workspacePath: string) => Promise<OpenProjectResponse>;
};

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

function withSince(eventsUrl: string, since: number): string {
  return `${eventsUrl}${eventsUrl.includes('?') ? '&' : '?'}since=${since}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function replacePart(parts: Part[], partId: string, update: (part: Part) => Part): Part[] {
  return parts.map((part) => (part.id === partId ? update(part) : part));
}

function updateMessage(
  messages: Message[],
  messageId: string,
  update: (message: Message) => Message,
): Message[] {
  return messages.map((message) => (message.id === messageId ? update(message) : message));
}

function patchChatInList(
  chats: ChatSummary[],
  chatId: string,
  update: (chat: ChatSummary) => ChatSummary,
): ChatSummary[] {
  return chats.map((chat) => (chat.id === chatId ? update(chat) : chat));
}

export function WorkspaceProvider({ chatId, children }: { chatId: string; children: ReactNode }) {
  const [bundle, setBundle] = useState<ChatBundle | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [archived, setArchived] = useState<ChatSummary[]>([]);
  const [run, setRun] = useState<RunState>(null);
  const [summaries, setSummaries] = useState<Record<string, string>>({});
  const [connection, setConnection] = useState<ConnectionState>('idle');
  const [filesVersion, setFilesVersion] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);

  const bundleRef = useRef<ChatBundle | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const lastSeqRef = useRef(0);
  const finishedRef = useRef(false);
  const filesTimerRef = useRef<number | null>(null);
  const followGenerationRef = useRef(0);
  const followRef = useRef<(() => Promise<void>) | null>(null);

  const loadBundle = useCallback(async (): Promise<ChatBundle | null> => {
    try {
      const next = await api.get<ChatBundle>(`/api/chats/${chatId}`, chatBundleSchema);
      bundleRef.current = next;
      setBundle(next);
      setMessages(next.messages);
      setChats(next.chats);
      return next;
    } catch (cause) {
      setError(errorMessage(cause));
      return null;
    }
  }, [chatId]);

  const loadProjects = useCallback(async () => {
    try {
      const result = await api.get<{ projects: ProjectSummary[] }>(
        '/api/projects',
        projectsResponseSchema,
      );
      setProjects(result.projects);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }, []);

  const loadArchived = useCallback(async () => {
    try {
      const result = await api.get<ArchivedChatsResponse>(
        '/api/chats?archived=1',
        archivedChatsResponseSchema,
      );
      setArchived(result.chats);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }, []);

  const refreshFiles = useCallback(async () => {
    const projectId = bundleRef.current?.project.id;
    if (!projectId) return;
    try {
      const detail = await api.get<ProjectDetail>(
        `/api/projects/${projectId}`,
        projectDetailSchema,
      );
      if (bundleRef.current) {
        bundleRef.current = { ...bundleRef.current, project: detail.project };
      }
      setBundle((current) => (current ? { ...current, project: detail.project } : current));
      setChats(detail.chats);
      setFilesVersion((value) => value + 1);
    } catch {
      // 文件索引刷新失败不打断对话；下一次改动或撤销会再试。
    }
  }, []);

  const scheduleFilesRefresh = useCallback(() => {
    setFilesVersion((value) => value + 1);
    if (filesTimerRef.current) window.clearTimeout(filesTimerRef.current);
    filesTimerRef.current = window.setTimeout(() => {
      filesTimerRef.current = null;
      void refreshFiles();
    }, 250);
  }, [refreshFiles]);

  const handleEvent = useCallback(
    (event: SseEvent) => {
      lastSeqRef.current = Math.max(lastSeqRef.current, event.seq);
      if (event.type === 'snapshot') {
        const snapshotMessage = event.message;
        if (snapshotMessage) {
          setMessages((current) => {
            const exists = current.some((message) => message.id === snapshotMessage.id);
            if (!exists) return [...current, snapshotMessage];
            return current.map((message) =>
              message.id === snapshotMessage.id ? snapshotMessage : message,
            );
          });
        }
        setRun(event.run);
        const streaming =
          event.run?.status === 'running' || event.run?.status === 'awaiting_approval';
        setChats((current) =>
          patchChatInList(current, chatId, (chat) => ({
            ...chat,
            streaming,
            pendingApproval: event.run?.status === 'awaiting_approval',
          })),
        );
        setBundle((current) =>
          current
            ? {
                ...current,
                chat: {
                  ...current.chat,
                  streaming,
                  pendingApproval: event.run?.status === 'awaiting_approval',
                },
              }
            : current,
        );
        if (!event.run) finishedRef.current = true;
        return;
      }

      if (event.type === 'part-added') {
        setMessages((current) =>
          updateMessage(current, event.messageId, (message) => {
            if (message.parts.some((part) => part.id === event.part.id)) return message;
            return { ...message, parts: [...message.parts, event.part] };
          }),
        );
        return;
      }

      if (event.type === 'part-updated') {
        setMessages((current) =>
          updateMessage(current, event.messageId, (message) => ({
            ...message,
            parts: replacePart(message.parts, event.partId, (part) => {
              if (part.type === 'approval' && event.patch.approvalStatus) {
                return { ...part, status: event.patch.approvalStatus };
              }
              if (part.type === 'tool') {
                return {
                  ...part,
                  state: event.patch.state ?? part.state,
                  output: event.patch.output ?? part.output,
                  error: event.patch.error ?? part.error,
                };
              }
              return part;
            }),
          })),
        );
        return;
      }

      if (event.type === 'text-delta') {
        setMessages((current) =>
          updateMessage(current, event.messageId, (message) => ({
            ...message,
            parts: replacePart(message.parts, event.partId, (part) =>
              part.type === 'text' ? { ...part, text: part.text + event.delta } : part,
            ),
          })),
        );
        return;
      }

      if (event.type === 'files-changed') {
        scheduleFilesRefresh();
        return;
      }

      if (event.type === 'finish') {
        finishedRef.current = true;
        setMessages((current) =>
          updateMessage(current, event.messageId, (message) => ({
            ...message,
            status: event.status,
            streaming: false,
            stopReason: event.stopReason ?? undefined,
            error: event.error ?? undefined,
            changeSetId: event.changeSetId ?? message.changeSetId,
          })),
        );
        setSummaries((current) =>
          event.summary ? { ...current, [event.messageId]: event.summary } : current,
        );
        setRun(null);
        setStopping(false);
        setConnection('idle');
        setChats((current) =>
          patchChatInList(current, chatId, (chat) => ({
            ...chat,
            streaming: false,
            pendingApproval: false,
            updatedAt: new Date().toISOString(),
          })),
        );
        setBundle((current) =>
          current
            ? {
                ...current,
                chat: {
                  ...current.chat,
                  streaming: false,
                  pendingApproval: false,
                },
              }
            : current,
        );
        scheduleFilesRefresh();
        void loadProjects();
        return;
      }

      if (event.type === 'error') {
        setError(event.message);
      }
    },
    [chatId, loadProjects, scheduleFilesRefresh],
  );

  const follow = useCallback(
    async (eventsUrl = `/api/chats/${chatId}/events`) => {
      const generation = followGenerationRef.current + 1;
      followGenerationRef.current = generation;
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;
      lastSeqRef.current = 0;
      finishedRef.current = false;
      setConnection('connecting');
      let since = 0;
      let attempts = 0;

      while (!controller.signal.aborted && followGenerationRef.current === generation) {
        try {
          setConnection(attempts === 0 ? 'connecting' : 'reconnecting');
          await streamEvents<SseEvent>(
            withSince(eventsUrl, since),
            (event) => {
              if (followGenerationRef.current !== generation) return;
              setConnection('live');
              handleEvent(event);
            },
            controller.signal,
          );
        } catch (cause) {
          if (controller.signal.aborted || followGenerationRef.current !== generation) break;
          if (!(cause instanceof ApiRequestError) && !(cause instanceof DOMException)) {
            setError(errorMessage(cause));
          }
        }

        if (finishedRef.current || controller.signal.aborted) break;
        if (followGenerationRef.current !== generation) break;
        attempts += 1;
        if (attempts > 5) {
          setConnection('idle');
          setError('事件流已中断，请刷新页面后重试。');
          break;
        }
        since = lastSeqRef.current;
        await sleep(Math.min(800 * attempts, 4000));
      }

      if (followGenerationRef.current === generation) setConnection('idle');
    },
    [chatId, handleEvent],
  );

  useEffect(() => {
    followRef.current = follow;
  }, [follow]);

  useEffect(() => {
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    setError(null);
    void Promise.all([loadBundle(), loadProjects(), loadArchived()]).then(([next]) => {
      if (cancelled) return;
      setLoading(false);
      if (next?.chat.streaming || next?.chat.pendingApproval) {
        void followRef.current?.();
      }
    });
    return () => {
      cancelled = true;
      controllerRef.current?.abort();
      if (filesTimerRef.current) window.clearTimeout(filesTimerRef.current);
    };
  }, [loadBundle, loadProjects, loadArchived]);

  const refresh = useCallback(async () => {
    setError(null);
    await Promise.all([loadBundle(), loadProjects(), loadArchived()]);
  }, [loadBundle, loadProjects, loadArchived]);

  const sendMessage = useCallback(
    async (text: string): Promise<boolean> => {
      setError(null);
      try {
        const accepted = await api.post<{ runId: string; messageId: string; eventsUrl: string }>(
          `/api/chats/${chatId}/messages`,
          { text },
        );
        await loadBundle();
        void follow(accepted.eventsUrl);
        return true;
      } catch (cause) {
        setError(
          cause instanceof ApiRequestError && cause.status === 409
            ? '该对话已有运行中的回合'
            : errorMessage(cause),
        );
        return false;
      }
    },
    [chatId, follow, loadBundle],
  );

  const stopRun = useCallback(async () => {
    if (stopping) return;
    setStopping(true);
    setError(null);
    const stoppedMessageId = run?.messageId;
    try {
      await api.post(`/api/chats/${chatId}/stop`);
      finishedRef.current = true;
      setRun((current) => (current ? { ...current, status: 'stopped' } : current));
      if (stoppedMessageId) {
        setMessages((current) =>
          updateMessage(current, stoppedMessageId, (message) => ({
            ...message,
            status: 'stopped',
            stopReason: 'user_stop',
            streaming: false,
          })),
        );
      }
      setChats((current) =>
        patchChatInList(current, chatId, (chat) => ({
          ...chat,
          streaming: false,
          pendingApproval: false,
        })),
      );
      setBundle((current) =>
        current
          ? {
              ...current,
              chat: { ...current.chat, streaming: false, pendingApproval: false },
            }
          : current,
      );
      setStopping(false);
    } catch (cause) {
      setStopping(false);
      setError(errorMessage(cause));
    }
  }, [chatId, run?.messageId, stopping]);

  const decideApproval = useCallback(
    async (approvalId: string, decision: 'approved' | 'rejected') => {
      if (!run) {
        setError('运行信息尚未就绪，请稍后重试。');
        return;
      }
      setError(null);
      try {
        await api.post(`/api/chats/${chatId}/runs/${run.id}/approvals/${approvalId}`, {
          decision,
        });
        setMessages((current) =>
          current.map((message) => ({
            ...message,
            parts: message.parts.map((part) =>
              part.type === 'approval' && part.approvalId === approvalId
                ? { ...part, status: decision }
                : part,
            ),
          })),
        );
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : '提交批准结果失败，请重试。');
      }
    },
    [chatId, run],
  );

  const createChat = useCallback(async (projectId: string): Promise<ChatSummary | null> => {
    setError(null);
    try {
      const body: CreateChatRequest = {};
      const chat = await api.post<ChatSummary>(`/api/projects/${projectId}/chats`, body);
      setChats((current) => [chat, ...current]);
      return chat;
    } catch (cause) {
      setError(errorMessage(cause));
      return null;
    }
  }, []);

  const renameChat = useCallback(
    async (targetId: string, title: string) => {
      const trimmed = title.trim();
      if (!trimmed) return;
      setError(null);
      try {
        const updated = await api.patch<ChatSummary>(`/api/chats/${targetId}`, { title: trimmed });
        setChats((current) => patchChatInList(current, targetId, () => updated));
        setBundle((current) =>
          current && current.chat.id === targetId ? { ...current, chat: updated } : current,
        );
        void loadArchived();
      } catch (cause) {
        setError(errorMessage(cause));
      }
    },
    [loadArchived],
  );

  const archiveChat = useCallback(async (targetId: string): Promise<boolean> => {
    setError(null);
    try {
      const updated = await api.post<ChatSummary>(`/api/chats/${targetId}/archive`);
      setChats((current) => current.filter((chat) => chat.id !== targetId));
      setArchived((current) => [updated, ...current.filter((chat) => chat.id !== targetId)]);
      return true;
    } catch (cause) {
      setError(errorMessage(cause));
      return false;
    }
  }, []);

  const restoreChat = useCallback(
    async (targetId: string) => {
      setError(null);
      try {
        const updated = await api.post<ChatSummary>(`/api/chats/${targetId}/restore`);
        setArchived((current) => current.filter((chat) => chat.id !== targetId));
        setChats((current) =>
          updated.projectId === bundle?.project.id
            ? [updated, ...current.filter((chat) => chat.id !== targetId)]
            : current,
        );
      } catch (cause) {
        setError(errorMessage(cause));
      }
    },
    [bundle?.project.id],
  );

  const renameProject = useCallback(
    async (name: string) => {
      const project = bundle?.project;
      const trimmed = name.trim();
      if (!project || !trimmed) return;
      setError(null);
      try {
        const updated = await api.patch<Project>(`/api/projects/${project.id}`, {
          name: trimmed,
        });
        setBundle((current) => (current ? { ...current, project: updated } : current));
        setProjects((current) =>
          current.map((item) => (item.id === project.id ? { ...item, name: updated.name } : item)),
        );
      } catch (cause) {
        setError(errorMessage(cause));
      }
    },
    [bundle?.project],
  );

  const setModel = useCallback(
    async (modelId: string) => {
      if (!bundle) return;
      setError(null);
      try {
        const updated = await api.patch<ChatSummary>(`/api/chats/${chatId}`, { modelId });
        setBundle((current) => (current ? { ...current, chat: updated } : current));
        setChats((current) => patchChatInList(current, chatId, () => updated));
      } catch (cause) {
        setError(errorMessage(cause));
      }
    },
    [bundle, chatId],
  );

  const notifyFilesChanged = useCallback(() => {
    scheduleFilesRefresh();
  }, [scheduleFilesRefresh]);

  const openProject = useCallback(async (workspacePath: string): Promise<OpenProjectResponse> => {
    const body: OpenProjectRequest = { workspacePath: workspacePath.trim() };
    return api.post<OpenProjectResponse>('/api/projects/open', body);
  }, []);

  // 撤销后由面板直接调用，避免把撤销结果再拉一遍列表。
  const value = useMemo<WorkspaceContextValue>(
    () => ({
      bundle,
      messages,
      chats,
      projects,
      archived,
      models: bundle?.models ?? [],
      run,
      summaries,
      connection,
      filesVersion,
      loading,
      error,
      stopping,
      refresh,
      sendMessage,
      stopRun,
      decideApproval,
      createChat,
      renameChat,
      archiveChat,
      restoreChat,
      renameProject,
      setModel,
      refreshFiles,
      notifyFilesChanged,
      openProject,
    }),
    [
      bundle,
      messages,
      chats,
      projects,
      archived,
      run,
      summaries,
      connection,
      filesVersion,
      loading,
      error,
      stopping,
      refresh,
      sendMessage,
      stopRun,
      decideApproval,
      createChat,
      renameChat,
      archiveChat,
      restoreChat,
      renameProject,
      setModel,
      refreshFiles,
      notifyFilesChanged,
      openProject,
    ],
  );

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace(): WorkspaceContextValue {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error('useWorkspace 必须在 WorkspaceProvider 内使用');
  return value;
}
