'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ArrowLeft, Globe2 } from 'lucide-react';
import { PaimengMark } from '@/components/brand/paimeng-mark';
import { MockSite } from '@/prototype/site';
import { usePrototype } from '@/prototype/store';

export default function PublishedPage() {
  const params = useParams<{ deployKey: string }>();
  const { findDeploy, hydrated } = usePrototype();
  const found = hydrated ? findDeploy(params.deployKey) : null;

  if (!hydrated) {
    return <div className="min-h-dvh bg-[#faf7f2]" />;
  }

  if (!found || !found.version) {
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-stone-50 px-6 text-center">
        <div className="flex size-11 items-center justify-center rounded-full bg-stone-100">
          <Globe2 className="size-5 text-stone-400" />
        </div>
        <div>
          <p className="text-sm font-medium text-stone-900">这个发布地址没有可访问的版本</p>
          <p className="mt-1 max-w-sm text-xs leading-5 text-stone-500">
            原型里的发布记录存在浏览器本地。重置演示数据或换了浏览器之后，旧的 deployKey
            就找不到了。 打开一个项目重新发布一次即可。
          </p>
        </div>
        <Link
          href="/prototype"
          className="inline-flex items-center gap-1.5 rounded-md border border-stone-200 bg-white px-3 py-1.5 text-xs text-stone-700 hover:bg-stone-50"
        >
          <ArrowLeft className="size-3.5" />
          返回原型
        </Link>
      </div>
    );
  }

  const { project, deploy, version } = found;

  return (
    <div className="relative min-h-dvh bg-[#faf7f2]">
      <MockSite site={version.site} />

      <div className="fixed right-4 bottom-4 z-40 flex items-center gap-2 rounded-full border border-stone-300/70 bg-white/90 px-3 py-1.5 text-[11px] text-stone-600 shadow-md backdrop-blur">
        <span className="size-1.5 rounded-full bg-emerald-500" />
        已发布 · {project.name} · v{deploy.versionSeq}
        <span className="text-stone-300">|</span>
        <Link
          href="/prototype"
          className="flex items-center gap-1.5 text-stone-700 underline-offset-2 hover:underline"
        >
          <PaimengMark size={14} />由 Paimeng 发布
        </Link>
      </div>
    </div>
  );
}
