'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { CornerUpLeft, History, RotateCcw } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { SAMPLE_SCREENSHOT } from '../mock-data';
import { usePrototype } from '../store';
import type { DemoIntent, RailPanel } from '../types';
import { useStoredValue, writeStored } from '../use-persisted';
import { AppSidebar } from './app-sidebar';
import { ArtifactPanel } from './artifact-panel';
import { ChatPanel, type Attachment, type DesignSelection } from './chat-panel';
import { CodePanel } from './code-panel';
import { DeployDialog } from './deploy-dialog';
import { LogsPanel } from './logs-panel';
import { PreviewPanel } from './preview-panel';
import { SettingsPanel } from './settings-panel';
import { VersionsPanel } from './versions-panel';
import { WorkspaceHeader } from './workspace-header';

const SEARCH_PROMPT =
  '帮我找两个可以参考的同类网站，抓一下正文，说明它们的页面结构，再给出你的建议。';

const DEFAULT_RAIL = 620;
const MIN_RAIL = 380;

export function Workspace({ chatId }: { chatId: string }) {
  const router = useRouter();
  const {
    state,
    intent,
    intentAt,
    clearIntent,
    sendMessage,
    setViewVersion,
    rollbackTo,
    createChat,
    renameProject,
    setPendingPrompt,
  } = usePrototype();

  const chat = state.chats.find((item) => item.id === chatId);
  const project = state.projects.find((item) => item.id === chat?.projectId);
  const chats = state.chats.filter((item) => item.projectId === chat?.projectId);

  const [panel, setPanel] = useState<RailPanel>('preview');
  const [designMode, setDesignMode] = useState(false);
  const [selection, setSelection] = useState<DesignSelection | null>(null);
  const [deployOpen, setDeployOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [path, setPath] = useState('app/page.tsx');
  const handledIntent = useRef(0);

  const collapsed = useStoredValue('paimeng.sidebar', 'open') === 'closed';
  const storedRail = Number(useStoredValue('paimeng.railPx', ''));
  const [dragRail, setDragRail] = useState<number | null>(null);
  const railWidth =
    dragRail ?? (Number.isFinite(storedRail) && storedRail >= MIN_RAIL ? storedRail : null);
  const splitRef = useRef<HTMLDivElement>(null);

  const active = chat?.versions[chat.versions.length - 1];
  const viewed = chat?.versions.find((version) => version.id === chat.viewVersionId) ?? active;
  const viewingOld = Boolean(active && viewed && active.id !== viewed.id);

  useEffect(() => {
    if (!chat || !intent || intentAt === handledIntent.current) return;
    const actions: Partial<Record<Exclude<DemoIntent, null>, () => void>> = {
      'open-versions': () => setPanel('diff'),
      'open-env': () => setPanel('settings'),
      'open-deploy': () => setDeployOpen(true),
      'design-mode': () => {
        setPanel('preview');
        setDesignMode(true);
        toast.info('Design mode 已打开', { description: '点选预览里的元素，会填进对话框。' });
      },
      'attach-screenshot': () =>
        setAttachments((current) => [
          ...current.filter((item) => item.name !== '参考截图.svg'),
          { url: SAMPLE_SCREENSHOT, name: '参考截图.svg' },
        ]),
      'send-search': () => {
        setPanel('preview');
        sendMessage(chat.id, SEARCH_PROMPT);
      },
      'send-iteration': () => {
        setPanel('preview');
        sendMessage(chat.id, '把主视觉再收紧一点：标题短一些，加一行副标题。');
      },
    };
    const action = actions[intent];
    if (!action) return;
    handledIntent.current = intentAt;
    action();
    clearIntent();
  }, [chat, clearIntent, intent, intentAt, sendMessage]);

  function startDrag(event: React.PointerEvent<HTMLDivElement>) {
    const container = splitRef.current;
    if (!container) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth =
      container.getBoundingClientRect().right - event.currentTarget.getBoundingClientRect().left;
    const bounds = container.getBoundingClientRect();
    let latest = startWidth;

    function move(moveEvent: PointerEvent) {
      const next = Math.min(
        Math.max(startWidth + (startX - moveEvent.clientX), MIN_RAIL),
        Math.max(bounds.width - 360, MIN_RAIL),
      );
      latest = next;
      setDragRail(next);
    }

    function up() {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setDragRail(null);
      writeStored('paimeng.railPx', String(Math.round(latest)));
    }

    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  if (!chat || !project) {
    return (
      <div className="flex h-dvh flex-col items-center justify-center gap-3 bg-background">
        <p className="text-sm">这个对话不存在，可能已经被删除。</p>
        <Button variant="outline" size="sm" asChild>
          <Link href="/prototype">返回项目列表</Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="flex h-dvh overflow-hidden bg-background text-foreground">
      <AppSidebar
        collapsed={collapsed}
        onToggleCollapsed={() => writeStored('paimeng.sidebar', collapsed ? 'open' : 'closed')}
        project={project}
        chat={chat}
        projects={state.projects}
        chats={state.chats}
        onSelectChat={(next) => router.push(`/prototype/c/${next}`)}
        onNewChat={() => {
          const next = createChat(project.id);
          router.push(`/prototype/c/${next}`);
        }}
        onDraft={(text) => {
          setPendingPrompt(text);
          router.push('/prototype');
        }}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        <WorkspaceHeader
          project={project}
          chats={chats}
          chat={chat}
          panel={panel}
          onPanelChange={setPanel}
          onSelectChat={(next) => router.push(`/prototype/c/${next}`)}
          onNewChat={() => {
            const next = createChat(project.id);
            router.push(`/prototype/c/${next}`);
          }}
          onOpenDeploy={() => {
            if (chat.pendingPlan || chat.streaming) {
              toast.info('请先结束当前生成或处理计划审批。');
              return;
            }
            setDeployOpen(true);
          }}
          onRename={(name) => {
            renameProject(project.id, name);
            toast.success('项目已重命名');
          }}
        />

        {viewingOld && viewed ? (
          <div className="flex items-center gap-2 border-b border-sky-200 bg-sky-50 px-3 py-1.5 text-[11px] text-sky-900 dark:border-sky-900 dark:bg-sky-950/40 dark:text-sky-200">
            <History className="size-3.5" />
            正在查看历史版本 {viewed.label}，预览与代码都是当时的样子。
            <div className="ml-auto flex items-center gap-1.5">
              <Button
                size="sm"
                variant="ghost"
                className="h-6 gap-1 px-2 text-[11px] text-sky-900 hover:bg-sky-100 dark:text-sky-200 dark:hover:bg-sky-900/40"
                onClick={() => setViewVersion(chat.id, active?.id ?? viewed.id)}
              >
                <CornerUpLeft className="size-3" />
                回到最新
              </Button>
              <Button
                size="sm"
                className="h-6 gap-1 bg-sky-900 px-2 text-[11px] text-white hover:bg-sky-800 dark:bg-sky-200 dark:text-sky-950 dark:hover:bg-sky-100"
                onClick={() => {
                  rollbackTo(chat.id, viewed.id);
                  toast.success(`已回滚到 ${viewed.label}`, {
                    description: '工作区换成旧源码树，并追加了一个新版本。',
                  });
                }}
              >
                <RotateCcw className="size-3" />
                回滚到此版本
              </Button>
            </div>
          </div>
        ) : null}

        <div ref={splitRef} className="flex min-h-0 flex-1">
          <div className="flex min-w-0 flex-1 flex-col">
            <ChatPanel
              chat={chat}
              project={project}
              selection={selection}
              onClearSelection={() => setSelection(null)}
              draft={draft}
              onDraftChange={setDraft}
              attachments={attachments}
              onAttachmentsChange={setAttachments}
              onOpenVersion={(versionId) => {
                setPanel('diff');
                setViewVersion(chat.id, versionId);
              }}
            />
          </div>

          <div
            role="separator"
            aria-orientation="vertical"
            onPointerDown={startDrag}
            onDoubleClick={() => writeStored('paimeng.railPx', String(DEFAULT_RAIL))}
            className="group relative w-1 shrink-0 cursor-col-resize bg-border/70 transition-colors hover:bg-foreground/25"
            title="拖动调整右栏宽度，双击复位"
          >
            <span className="absolute inset-y-0 -left-1 -right-1" />
          </div>

          <div
            style={railWidth ? { width: railWidth } : undefined}
            className={
              railWidth
                ? 'flex min-h-0 shrink-0 flex-col border-l border-border/40'
                : 'flex min-h-0 w-[58%] min-w-[380px] shrink-0 flex-col border-l border-border/40'
            }
          >
            {panel === 'preview' ? (
              <PreviewPanel
                version={viewed && Object.keys(viewed.files).length ? viewed : undefined}
                liveSite={chat.streaming ? chat.liveSite : undefined}
                chatId={chat.id}
                sandboxState={chat.versions.length ? 'running' : 'starting'}
                designMode={designMode}
                onToggleDesign={() => {
                  setDesignMode((value) => !value);
                  setSelection(null);
                }}
                onSelectElement={(next) => {
                  setSelection(next);
                  setDesignMode(false);
                  setDraft(`调整「${next.label}」这个区块：`);
                  toast.success(`已选中 ${next.component}`, {
                    description: '一句话已经填进对话框，补充你想改的内容再发送。',
                  });
                }}
                selection={selection}
              />
            ) : panel === 'code' ? (
              <CodePanel chat={chat} selectedPath={path} onSelectPath={setPath} />
            ) : panel === 'diff' ? (
              <VersionsPanel
                chat={chat}
                onViewVersion={(versionId) => {
                  setViewVersion(chat.id, versionId);
                  setPanel('preview');
                  toast.info('预览已切到该版本');
                }}
                onRollback={(versionId) => rollbackTo(chat.id, versionId)}
                onShowDiffFile={(next) => {
                  setPath(next);
                  setPanel('code');
                }}
              />
            ) : panel === 'logs' ? (
              <LogsPanel chat={chat} version={viewed} />
            ) : panel === 'settings' ? (
              <SettingsPanel project={project} />
            ) : (
              <ArtifactPanel
                project={project}
                version={active}
                onDeploy={() => setDeployOpen(true)}
              />
            )}
          </div>
        </div>
      </div>

      <DeployDialog
        project={project}
        version={viewed}
        open={deployOpen}
        onOpenChange={setDeployOpen}
      />
    </div>
  );
}
