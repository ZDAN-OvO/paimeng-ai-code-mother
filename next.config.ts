import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // 原型截图时隐藏 Next 的开发指示器。
  devIndicators: false,
  // 不往 AGENTS.md 里追加 Next 自动生成的说明。
  agentRules: false,
  // ripgrep 以平台二进制随包提供，交给 Node 运行时加载，避免 Turbopack 把它当源码解析。
  serverExternalPackages: ['@vscode/ripgrep'],
};

export default nextConfig;
