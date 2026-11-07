import type { SiteState } from './types';

/**
 * 预览里渲染的「生成结果」。真实产品里这里是沙箱 dev server 的反代页面；
 * 原型用同一份 content 直接渲染，保证预览、代码面板与 diff 讲的是同一件事。
 * data-src / data-component 模拟 React fiber 上的 _debugSource，供 Design mode 定位。
 */
export function MockSite({ site }: { site: SiteState }) {
  const c = site.content;
  const layout = site.layout;

  return (
    <div className="min-h-full bg-[#faf7f2] text-stone-900">
      {layout >= 2 ? (
        <header
          data-src="components/site-header.tsx:5"
          data-component="SiteHeader"
          data-label="顶部导航"
          className="sticky top-0 z-10 border-b border-stone-200 bg-[#faf7f2]/95 backdrop-blur"
        >
          <div className="mx-auto flex max-w-5xl items-center justify-between px-8 py-4">
            <span className="text-sm font-semibold tracking-tight">{c.brand}</span>
            <nav className="hidden items-center gap-7 text-sm text-stone-600 sm:flex">
              {c.nav.map((item) => (
                <span key={item}>{item}</span>
              ))}
            </nav>
            <span className="rounded-full border border-stone-300 px-4 py-1.5 text-xs">
              {c.cta}
            </span>
          </div>
        </header>
      ) : null}

      {layout >= 3 ? (
        <section
          data-src="components/hero.tsx:5"
          data-component="Hero"
          data-label="主视觉"
          className="bg-stone-950 px-8 pt-24 pb-20 text-stone-50"
        >
          <div className="mx-auto grid max-w-5xl items-center gap-12 md:grid-cols-[1.2fr_1fr]">
            <div>
              <p className="text-xs tracking-[0.25em] text-stone-400 uppercase">{c.brand}</p>
              <h1 className="mt-6 text-5xl leading-tight font-semibold tracking-tight text-balance">
                {c.headline}
              </h1>
              <p className="mt-6 max-w-md text-base leading-7 text-stone-300">{c.tagline}</p>
              <span className="mt-9 inline-block rounded-full bg-stone-50 px-6 py-3 text-sm font-medium text-stone-950">
                {c.cta}
              </span>
            </div>
            <div className="aspect-square rounded-3xl bg-gradient-to-br from-stone-600 via-stone-800 to-stone-900" />
          </div>
        </section>
      ) : (
        <section
          data-src="components/hero.tsx:5"
          data-component="Hero"
          data-label="主视觉"
          className="mx-auto max-w-3xl px-8 pt-24 pb-16 text-center"
        >
          <p className="text-xs tracking-[0.2em] text-stone-500 uppercase">{c.brand}</p>
          <h1 className="mt-5 text-5xl font-semibold tracking-tight text-balance text-stone-900">
            {c.headline}
          </h1>
          <p className="mt-5 text-base leading-7 text-stone-600">{c.tagline}</p>
          {layout >= 2 ? (
            <p className="mt-6 inline-block rounded-full bg-stone-900/5 px-3 py-1 text-xs text-stone-600">
              本季新品已上架
            </p>
          ) : null}
          <div>
            <span className="mt-8 inline-block rounded-full bg-stone-900 px-6 py-3 text-sm font-medium text-white">
              {c.cta}
            </span>
          </div>
        </section>
      )}

      <section
        data-src="components/feature-grid.tsx:5"
        data-component="FeatureGrid"
        data-label="能力介绍"
        className="mx-auto max-w-5xl px-8 py-16"
      >
        <div className="grid gap-10 md:grid-cols-3">
          {c.features.map((feature) => (
            <div key={feature.title}>
              <div className="h-9 w-9 rounded-lg bg-stone-900/5" />
              <h2 className="mt-4 text-base font-medium text-stone-900">{feature.title}</h2>
              <p className="mt-2 text-sm leading-6 text-stone-600">{feature.body}</p>
            </div>
          ))}
        </div>
      </section>

      {layout >= 2 ? (
        <section
          data-src="components/detail-section.tsx:5"
          data-component="DetailSection"
          data-label={c.detailTitle}
          className="bg-stone-900/[0.03] px-8 py-20"
        >
          <div className="mx-auto max-w-5xl">
            <div className="flex items-baseline justify-between">
              <h2 className="text-2xl font-semibold tracking-tight">{c.detailTitle}</h2>
              <span className="text-xs text-stone-500">共 {c.details.length} 项</span>
            </div>
            <div className="mt-8 grid gap-4 md:grid-cols-3">
              {c.details.map((item) => (
                <article
                  key={item.name}
                  data-src={`components/detail-section.tsx:15`}
                  data-component="DetailCard"
                  data-label={item.name}
                  className="rounded-xl bg-white p-5 shadow-sm"
                >
                  <h3 className="text-sm font-medium">{item.name}</h3>
                  <p className="mt-1 text-xs text-stone-500">{item.note}</p>
                  <p className="mt-6 text-sm text-stone-900">{item.price}</p>
                </article>
              ))}
            </div>
          </div>
        </section>
      ) : null}

      {layout >= 3 ? (
        <section
          data-src="components/testimonial-band.tsx:5"
          data-component="TestimonialBand"
          data-label="客户评价"
          className="mx-auto max-w-3xl px-8 py-20 text-center"
        >
          <p className="text-xs tracking-[0.25em] text-stone-400 uppercase">客户评价</p>
          <blockquote className="mt-6 text-xl leading-8 text-stone-800">
            “{c.testimonial.quote}”
          </blockquote>
          <p className="mt-4 text-sm text-stone-500">{c.testimonial.author}</p>
        </section>
      ) : null}

      <footer
        data-src="components/site-footer.tsx:5"
        data-component="SiteFooter"
        data-label="页脚"
        className="border-t border-stone-200 px-8 py-10"
      >
        <div className="mx-auto flex max-w-5xl flex-col justify-between gap-3 text-xs text-stone-500 sm:flex-row">
          <span>{c.footerNote}</span>
          <span>{c.brand}</span>
        </div>
      </footer>
    </div>
  );
}
