'use client';

import { usePathname } from 'next/navigation';
import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { PrototypeHud } from '@/prototype/components/hud';
import { PrototypeProvider } from '@/prototype/store';
import { THEME_SCRIPT, ThemeProvider } from '@/prototype/theme';

export default function PrototypeLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isPublished = pathname.startsWith('/prototype/p/');

  return (
    <PrototypeProvider>
      {/* 首帧前先把主题类名放到 <html> 上，刷新时不闪一下浅色。 */}
      <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      <ThemeProvider>
        <TooltipProvider delayDuration={200}>
          {children}
          {isPublished ? null : <PrototypeHud />}
          <Toaster position="top-center" />
        </TooltipProvider>
      </ThemeProvider>
    </PrototypeProvider>
  );
}
