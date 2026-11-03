import { PageHeader } from '@/components/layout/page-header';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

const sections = [
  { title: '设计令牌', description: '颜色、字体、圆角与阴影定义在 src/index.css 的 @theme 里，引用它们而不是写死数值。', items: ['bg-surface / bg-surface-muted', 'text-ink / text-ink-muted', 'bg-brand-soft / text-brand', 'rounded-card · shadow-card'] },
  { title: '组件', description: 'src/components/ui 下是 shadcn/ui 的源码，需要新组件时照同样结构添加。', items: ['Button：default / outline / ghost', 'Card：Header · Title · Description · Content', 'Badge：default / outline / muted'] },
  { title: '路由', description: '路由表在 src/App.tsx，页面放在 src/pages，新增页面时两处一起改。', items: ['/ 工作台', '/about 关于骨架', '* 未找到页面'] },
];

export function AboutPage() {
  return (
    <div className="space-y-8">
      <PageHeader title="关于这个骨架" description="这些约定帮你在不重写设计系统的前提下扩展页面。" />
      <div className="grid gap-6 md:grid-cols-3">
        {sections.map(section => (
          <Card key={section.title}>
            <CardHeader>
              <CardTitle>{section.title}</CardTitle>
              <CardDescription>{section.description}</CardDescription>
            </CardHeader>
            <CardContent>
              <ul className="space-y-2">
                {section.items.map(item => (
                  <li key={item}>
                    <Badge tone="muted">{item}</Badge>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
