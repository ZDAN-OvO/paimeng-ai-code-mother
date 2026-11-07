import type { FileMap, SiteState } from '@/shared/api/schemas';

const UI_BUTTON_FILE = `import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const buttonVariants = cva(
  'inline-flex items-center justify-center rounded-full text-sm font-medium transition-colors',
  {
    variants: {
      variant: {
        default: 'bg-stone-900 text-white hover:bg-stone-800',
        outline: 'border border-stone-300 hover:bg-stone-100',
        ghost: 'hover:bg-stone-900/5',
      },
      size: { default: 'h-10 px-6', sm: 'h-8 px-4', icon: 'size-9' },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);

export function Button({
  className,
  variant,
  size,
  ...props
}: React.ComponentProps<'button'> & VariantProps<typeof buttonVariants>) {
  return <button className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}
`;

const UTILS_FILE = `import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
`;

const CONSTANT_FILES = {
  'app/layout.tsx': `import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: '首页',
  description: '由 Paimeng 生成的项目',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
`,
  'app/globals.css': `@import 'tailwindcss';

:root {
  --page: #faf7f2;
  --ink: #1c1917;
}

body {
  background: var(--page);
  color: var(--ink);
  font-family: ui-sans-serif, system-ui, 'PingFang SC', sans-serif;
  -webkit-font-smoothing: antialiased;
}
`,
  'package.json': `{
  "name": "generated-site",
  "private": true,
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start"
  },
  "dependencies": {
    "class-variance-authority": "^0.7.1",
    "clsx": "^2.1.1",
    "next": "^16.4.5",
    "react": "19.2.8",
    "react-dom": "19.2.8",
    "tailwind-merge": "^3.3.1"
  },
  "devDependencies": {
    "@tailwindcss/postcss": "^4.3.4",
    "tailwindcss": "^4.3.4"
  }
}
`,
};

function contentFile(site: SiteState): string {
  const c = site.content;
  const list = (items: Record<string, string>[]) => JSON.stringify(items, null, 2);
  return `export const content = {
  brand: ${JSON.stringify(c.brand)},
  headline: ${JSON.stringify(c.headline)},
  tagline: ${JSON.stringify(c.tagline)},
  cta: ${JSON.stringify(c.cta)},
  nav: ${JSON.stringify(c.nav)},
  features: ${list(c.features)},
  detailTitle: ${JSON.stringify(c.detailTitle)},
  details: ${list(c.details)},
  testimonial: ${JSON.stringify(c.testimonial)},
  footerNote: ${JSON.stringify(c.footerNote)},
} as const;
`;
}

function heroFile(site: SiteState): string {
  const dark = site.layout >= 3;
  if (dark) {
    return `import { content } from '@/lib/content';
import { Button } from '@/components/ui/button';

export function Hero() {
  return (
    <section className="bg-stone-950 px-6 pt-24 pb-20 text-stone-50">
      <div className="mx-auto grid max-w-5xl gap-12 md:grid-cols-[1.2fr_1fr] md:items-center">
        <div>
          <p className="text-xs uppercase tracking-[0.25em] text-stone-400">{content.brand}</p>
          <h1 className="mt-6 text-5xl font-semibold leading-tight tracking-tight">
            {content.headline}
          </h1>
          <p className="mt-6 max-w-md text-base leading-7 text-stone-300">{content.tagline}</p>
          <Button className="mt-9 bg-stone-50 text-stone-950 hover:bg-stone-200">
            {content.cta}
          </Button>
        </div>
        <div className="aspect-square rounded-3xl bg-gradient-to-br from-stone-600 via-stone-800 to-stone-900" />
      </div>
    </section>
  );
}
`;
  }
  return `import { content } from '@/lib/content';
import { Button } from '@/components/ui/button';

export function Hero() {
  return (
    <section className="mx-auto max-w-3xl px-6 pt-24 pb-16 text-center">
      <p className="text-xs uppercase tracking-[0.2em] text-stone-500">{content.brand}</p>
      <h1 className="mt-5 text-5xl font-semibold tracking-tight text-stone-900">
        {content.headline}
      </h1>
      <p className="mt-5 text-base leading-7 text-stone-600">{content.tagline}</p>
      ${site.layout >= 2 ? '<p className="mt-6 inline-block rounded-full bg-stone-900/5 px-3 py-1 text-xs text-stone-600">本季新品已上架</p>\n      ' : ''}<button className="mt-8 rounded-full bg-stone-900 px-6 py-3 text-sm font-medium text-white">
        {content.cta}
      </button>
    </section>
  );
}
`;
}

function pageFile(site: SiteState): string {
  const imports = [`import { Hero } from '@/components/hero';`];
  if (site.layout >= 2) imports.push(`import { SiteHeader } from '@/components/site-header';`);
  imports.push(`import { FeatureGrid } from '@/components/feature-grid';`);
  if (site.layout >= 2)
    imports.push(`import { DetailSection } from '@/components/detail-section';`);
  if (site.layout >= 3)
    imports.push(`import { TestimonialBand } from '@/components/testimonial-band';`);
  imports.push(`import { SiteFooter } from '@/components/site-footer';`);

  const body = [
    site.layout >= 2 ? '      <SiteHeader />' : null,
    '      <Hero />',
    '      <FeatureGrid />',
    site.layout >= 2 ? '      <DetailSection />' : null,
    site.layout >= 3 ? '      <TestimonialBand />' : null,
    '      <SiteFooter />',
  ].filter(Boolean);

  return `${imports.join('\n')}

export default function Page() {
  return (
    <main className="min-h-screen">
${body.join('\n')}
    </main>
  );
}
`;
}

function featureFile(): string {
  return `import { content } from '@/lib/content';

export function FeatureGrid() {
  return (
    <section className="mx-auto max-w-5xl px-6 py-16">
      <div className="grid gap-10 md:grid-cols-3">
        {content.features.map((feature) => (
          <div key={feature.title}>
            <div className="h-9 w-9 rounded-lg bg-stone-900/5" />
            <h2 className="mt-4 text-base font-medium text-stone-900">{feature.title}</h2>
            <p className="mt-2 text-sm leading-6 text-stone-600">{feature.body}</p>
          </div>
        ))}
      </div>
    </section>
  );
}
`;
}

function footerFile(): string {
  return `import { content } from '@/lib/content';

export function SiteFooter() {
  return (
    <footer className="border-t border-stone-200 px-6 py-10">
      <div className="mx-auto flex max-w-5xl flex-col gap-3 text-xs text-stone-500 sm:flex-row sm:items-center sm:justify-between">
        <span>{content.footerNote}</span>
        <span>{content.brand}</span>
      </div>
    </footer>
  );
}
`;
}

function headerFile(): string {
  return `import { content } from '@/lib/content';
import { Button } from '@/components/ui/button';

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-20 border-b border-stone-200 bg-[#faf7f2]/90 backdrop-blur">
      <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
        <span className="text-sm font-semibold tracking-tight">{content.brand}</span>
        <nav className="flex items-center gap-6 text-sm text-stone-600">
          {content.nav.map((item) => (
            <a key={item} href="#">
              {item}
            </a>
          ))}
        </nav>
        <Button variant="outline" size="sm">
          {content.cta}
        </Button>
      </div>
    </header>
  );
}
`;
}

function detailFile(): string {
  return `import { content } from '@/lib/content';

export function DetailSection() {
  return (
    <section className="bg-stone-900/[0.03] px-6 py-20">
      <div className="mx-auto max-w-5xl">
        <div className="flex items-baseline justify-between">
          <h2 className="text-2xl font-semibold tracking-tight">{content.detailTitle}</h2>
          <span className="text-xs text-stone-500">共 {content.details.length} 项</span>
        </div>
        <div className="mt-8 grid gap-4 md:grid-cols-3">
          {content.details.map((item) => (
            <article key={item.name} className="rounded-xl bg-white p-5 shadow-sm">
              <h3 className="text-sm font-medium">{item.name}</h3>
              <p className="mt-1 text-xs text-stone-500">{item.note}</p>
              <p className="mt-6 text-sm text-stone-900">{item.price}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
`;
}

function testimonialFile(): string {
  return `import { content } from '@/lib/content';

export function TestimonialBand() {
  return (
    <section className="mx-auto max-w-3xl px-6 py-20 text-center">
      <p className="text-xs uppercase tracking-[0.25em] text-stone-400">客户评价</p>
      <blockquote className="mt-6 text-xl leading-8 text-stone-800">
        “{content.testimonial.quote}”
      </blockquote>
      <p className="mt-4 text-sm text-stone-500">{content.testimonial.author}</p>
    </section>
  );
}
`;
}

export function buildSiteFiles(site: SiteState): FileMap {
  const files: FileMap = {
    ...CONSTANT_FILES,
    'app/page.tsx': pageFile(site),
    'lib/content.ts': contentFile(site),
    'components/hero.tsx': heroFile(site),
    'components/feature-grid.tsx': featureFile(),
    'components/site-footer.tsx': footerFile(),
    'components/ui/button.tsx': UI_BUTTON_FILE,
    'lib/utils.ts': UTILS_FILE,
  };
  if (site.layout >= 2) {
    files['components/site-header.tsx'] = headerFile();
    files['components/detail-section.tsx'] = detailFile();
  }
  if (site.layout >= 3) {
    files['components/testimonial-band.tsx'] = testimonialFile();
  }
  return files;
}
