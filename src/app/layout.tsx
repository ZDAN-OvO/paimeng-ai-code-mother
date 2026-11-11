import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Paimeng',
  description: '在本地项目目录里与助手对话改代码：实时预览、改动 diff、撤销与运行日志。',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}
