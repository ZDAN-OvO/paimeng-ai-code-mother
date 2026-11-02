import { CalendarDays, FileText, Users, type LucideIcon } from 'lucide-react';

export type Metric = { label: string; value: string; detail: string; icon: LucideIcon };

export const metrics: Metric[] = [
  { label: '本周发布', value: '18 篇', detail: '比上周多 4 篇', icon: FileText },
  { label: '排队待审', value: '6 篇', detail: '最早今天 16:00 截止', icon: CalendarDays },
  { label: '协作成员', value: '12 人', detail: '3 人今天有更新', icon: Users },
];

export type ActivityStatus = '已发布' | '审核中' | '草稿';

export type ActivityItem = { id: string; title: string; owner: string; status: ActivityStatus; updatedAt: string };

export const recentActivity: ActivityItem[] = [
  { id: 'a-1', title: '春季新品上架清单', owner: '林晓', status: '已发布', updatedAt: '今天 09:24' },
  { id: 'a-2', title: '会员权益改版说明', owner: '周牧', status: '审核中', updatedAt: '今天 08:10' },
  { id: 'a-3', title: '四月社群活动预热', owner: '陈一', status: '草稿', updatedAt: '昨天 18:42' },
  { id: 'a-4', title: '季度内容复盘', owner: '林晓', status: '已发布', updatedAt: '昨天 15:05' },
];

export type QueueItem = { id: string; title: string; channel: string; dueAt: string };

export const upcomingQueue: QueueItem[] = [
  { id: 'q-1', title: '品牌故事长图', channel: '公众号', dueAt: '今天 16:00' },
  { id: 'q-2', title: '产品更新短视频脚本', channel: '视频号', dueAt: '明天 11:00' },
  { id: 'q-3', title: '用户访谈纪要', channel: '站内', dueAt: '周五 10:00' },
];
