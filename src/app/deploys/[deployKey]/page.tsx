'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ArrowLeft, Globe2 } from 'lucide-react';
import { PaimengMark } from '@/components/brand/paimeng-mark';
import { MockSite } from '@/features/preview/mock-site';
import { api, ApiRequestError } from '@/lib/api/client';
import type { PublishedResponse } from '@/shared/api/schemas';

export default function PublishedPage() {
  const params = useParams<{ deployKey: string }>();
  const [data, setData] = useState<PublishedResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const published = await api.get<PublishedResponse>(
          `/api/deploys/${encodeURIComponent(params.deployKey)}`,
        );
        if (!cancelled) setData(published);
      } catch (cause) {
        if (!cancelled) {
          setError(cause instanceof ApiRequestError ? cause.message : '这个发布地址暂时打不开');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [params.deployKey]);

  if (loading) return <div className="min-h-dvh bg-[#faf7f2]" />;

  if (!data) {
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-stone-50 px-6 text-center">
        <div className="flex size-11 items-center justify-center rounded-full bg-stone-100">
          <Globe2 className="size-5 text-stone-400" />
        </div>
        <div>
          <p className="text-sm font-medium text-stone-900">这个发布地址没有可访问的版本</p>
          <p className="mt-1 max-w-sm text-xs leading-5 text-stone-500">
            {error ?? '打开一个项目重新发布一次即可。'}
          </p>
        </div>
        <Link
          href="/"
          className="inline-flex items-center gap-1.5 rounded-md border border-stone-200 bg-white px-3 py-1.5 text-xs text-stone-700 hover:bg-stone-50"
        >
          <ArrowLeft className="size-3.5" />
          返回项目
        </Link>
      </div>
    );
  }

  return (
    <div className="relative min-h-dvh bg-[#faf7f2]">
      <MockSite site={data.version.site} />

      <div className="fixed right-4 bottom-4 z-40 flex items-center gap-2 rounded-full border border-stone-300/70 bg-white/90 px-3 py-1.5 text-[11px] text-stone-600 shadow-md backdrop-blur">
        <span className="size-1.5 rounded-full bg-emerald-500" />
        已发布 · {data.project.name} · v{data.deploy.versionSeq}
        <span className="text-stone-300">|</span>
        <Link
          href="/"
          className="flex items-center gap-1.5 text-stone-700 underline-offset-2 hover:underline"
        >
          <PaimengMark size={14} />由 Paimeng 发布
        </Link>
      </div>
    </div>
  );
}
