/** 侧栏入口切换的中栏视图：同一时刻只有一个，不换路由。 */
export type WorkspaceView = 'home' | 'chat' | 'chats' | 'projects' | 'skills' | 'templates';

/** 右栏面板：同一时刻只显示一个，宽度可拖。 */
export type RailPanel = 'preview' | 'code' | 'changes' | 'logs' | 'settings';

/** Design mode 里点选到的元素，作为本轮对话的定位上下文。 */
export type DesignSelection = { component: string; src: string; label: string };

export type Attachment = { url: string; name: string };
