'use client';

import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { THEME_SCRIPT, ThemeProvider } from '@/features/theme/theme-provider';

export default function WorkbenchLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      {/* 首帧前把主题类名放到 <html> 上，刷新时不闪一下浅色。 */}
      <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      <ThemeProvider>
        <TooltipProvider delayDuration={200}>
          {children}
          <Toaster position="top-center" />
        </TooltipProvider>
      </ThemeProvider>
    </>
  );
}
