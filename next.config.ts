import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // 原型截图时隐藏 Next 的开发指示器。
  devIndicators: false,
  // 不往 AGENTS.md 里追加 Next 自动生成的说明。
  agentRules: false,
};

export default nextConfig;
