'use client';

import { useEffect, useRef, useState } from 'react';
import { MockSite } from '@/features/preview/mock-site';
import type { SiteState } from '@/shared/api/schemas';

/**
 * 把站点按 1200px 的桌面宽度渲染，再等比缩到容器宽度。
 * 模板缩略图与项目卡片共用同一份站点内容。
 */
export function SiteThumb({
  site,
  className,
  designWidth = 1200,
  align = 'top',
}: {
  site: SiteState;
  className?: string;
  designWidth?: number;
  align?: 'top' | 'center';
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.3);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      if (width > 0) setScale(width / designWidth);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [designWidth]);

  return (
    <div ref={ref} className={className} aria-hidden>
      <div
        className="pointer-events-none origin-top-left select-none"
        style={{
          width: designWidth,
          transform: `scale(${scale})`,
          transformOrigin: align === 'top' ? 'top left' : 'center top',
        }}
      >
        <MockSite site={site} />
      </div>
    </div>
  );
}
