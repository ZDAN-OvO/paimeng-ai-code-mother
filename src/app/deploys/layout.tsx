'use client';

import { Toaster } from '@/components/ui/sonner';
import { THEME_SCRIPT, ThemeProvider } from '@/features/theme/theme-provider';

export default function PublishedLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      <ThemeProvider>
        {children}
        <Toaster position="top-center" />
      </ThemeProvider>
    </>
  );
}
