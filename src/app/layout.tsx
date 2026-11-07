import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Paimeng',
  description: '用一句话生成一个完整的 Next.js 应用，在沙箱里实时预览并发布。',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}
