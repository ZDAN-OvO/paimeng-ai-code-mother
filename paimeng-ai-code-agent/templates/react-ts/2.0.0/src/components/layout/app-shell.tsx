import { Compass, LayoutDashboard, Sparkles } from 'lucide-react';
import { NavLink, Outlet } from 'react-router';
import { cn } from '@/lib/utils';

const navigation = [
  { to: '/', label: '工作台', icon: LayoutDashboard, end: true },
  { to: '/about', label: '关于骨架', icon: Compass, end: false },
];

export function AppShell() {
  return (
    <div className="min-h-screen lg:flex">
      <aside className="border-b border-line bg-white px-6 py-5 lg:w-64 lg:shrink-0 lg:border-r lg:border-b-0">
        <div className="flex items-center gap-3">
          <span className="flex size-9 items-center justify-center rounded-xl bg-brand text-white">
            <Sparkles className="size-4" aria-hidden />
          </span>
          <div>
            <p className="font-display text-base font-semibold">Paimeng Studio</p>
            <p className="text-xs text-ink-muted">内容运营示例</p>
          </div>
        </div>
        <nav aria-label="主导航" className="mt-8 flex gap-1 lg:flex-col">
          {navigation.map(item => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                cn(
                  'flex items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors',
                  isActive ? 'bg-brand-soft text-brand' : 'text-ink-muted hover:bg-surface-muted hover:text-ink',
                )
              }
            >
              <item.icon className="size-4" aria-hidden />
              {item.label}
            </NavLink>
          ))}
        </nav>
        <p className="mt-8 hidden text-xs leading-relaxed text-ink-muted lg:block">这是模板自带的窄屏侧栏布局。改内容前先看 src/index.css 里的设计令牌。</p>
      </aside>
      <main className="min-w-0 flex-1 px-6 py-8 lg:px-10">
        <Outlet />
      </main>
    </div>
  );
}
