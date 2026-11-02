import { ArrowUpRight } from 'lucide-react';
import { Link } from 'react-router';
import { PageHeader } from '@/components/layout/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { metrics, recentActivity, upcomingQueue, type ActivityStatus } from '@/data/dashboard';

const statusTone: Record<ActivityStatus, 'default' | 'outline' | 'muted'> = {
  已发布: 'default',
  审核中: 'outline',
  草稿: 'muted',
};

export function HomePage() {
  return (
    <div className="space-y-8">
      <PageHeader
        title="内容运营工作台"
        description="模板自带的示例页面：布局、设计令牌、shadcn/ui 组件与路由都已接好，把这里的内容换成用户的需求即可。"
        actions={
          <Button asChild>
            <Link to="/about">
              查看组件说明
              <ArrowUpRight className="size-4" aria-hidden />
            </Link>
          </Button>
        }
      />

      <section aria-label="关键指标" className="grid gap-4 sm:grid-cols-3">
        {metrics.map(metric => (
          <Card key={metric.label}>
            <CardHeader>
              <CardDescription>{metric.label}</CardDescription>
              <CardTitle className="font-display text-3xl">{metric.value}</CardTitle>
            </CardHeader>
            <CardContent className="flex items-center gap-2 text-sm text-ink-muted">
              <metric.icon className="size-4 text-brand" aria-hidden />
              <span>{metric.detail}</span>
            </CardContent>
          </Card>
        ))}
      </section>

      <div className="grid gap-6 lg:grid-cols-[1.4fr_1fr]">
        <Card>
          <CardHeader className="flex-row items-center justify-between">
            <div>
              <CardTitle>最近更新</CardTitle>
              <CardDescription>团队本周改过的内容</CardDescription>
            </div>
            <Badge tone="outline">共 {recentActivity.length} 条</Badge>
          </CardHeader>
          <CardContent>
            <ul className="divide-y divide-line">
              {recentActivity.map(item => (
                <li key={item.id} className="flex items-center justify-between gap-4 py-3 first:pt-0 last:pb-0">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{item.title}</p>
                    <p className="text-xs text-ink-muted">
                      {item.owner} · {item.updatedAt}
                    </p>
                  </div>
                  <Badge tone={statusTone[item.status]}>{item.status}</Badge>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>待办排期</CardTitle>
            <CardDescription>按截止时间从近到远</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="space-y-3">
              {upcomingQueue.map(item => (
                <li key={item.id} className="rounded-lg bg-surface-muted px-4 py-3">
                  <p className="text-sm font-medium">{item.title}</p>
                  <p className="mt-1 text-xs text-ink-muted">
                    {item.channel} · {item.dueAt}
                  </p>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
