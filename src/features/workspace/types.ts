/** 右栏面板：同一时刻只显示一个，宽度可拖。 */
export type RailPanel = 'preview' | 'code' | 'diff' | 'logs' | 'settings' | 'artifact';

/** Design mode 里点选到的元素，作为本轮对话的定位上下文。 */
export type DesignSelection = { component: string; src: string; label: string };

export type Attachment = { url: string; name: string };

export type CodePanelTab = 'files' | 'diff';
