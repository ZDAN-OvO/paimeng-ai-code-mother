/**
 * 预览取证：打开一个预览地址，抓桌面/手机截图、控制台与网络错误、DOM 可访问性信号。
 *
 * 用法（在 paimeng-ai-code-agent/ 下）：
 *   npx tsx evals/scripts/probe.ts --url http://127.0.0.1:3001/preview/html_123/ --out runtime/evals/demo
 *
 * 这是启发式取证，不是 WCAG 认证：颜色对比度只覆盖纯色背景上的直接文本，
 * 图片/渐变/伪元素背景会被跳过或误报，最终结论必须回看截图。
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';

type ContrastIssue = {
  tag: string;
  text: string;
  color: string;
  background: string;
  ratio: number;
  fontSize: number;
  fontWeight: number;
};

type TapTarget = { tag: string; label: string; width: number; height: number };

type ProbeFindings = {
  url: string;
  finalUrl: string;
  status: number | null;
  title: string;
  lang: string | null;
  viewportMeta: string | null;
  headings: { level: number; text: string }[];
  counts: {
    links: number;
    buttons: number;
    forms: number;
    inputs: number;
    images: number;
    emptyLinks: number;
    hashLinks: number;
    ariaLive: number;
    alerts: number;
  };
  issues: {
    imagesWithoutAlt: string[];
    brokenImages: string[];
    inputsWithoutName: { tag: string; type: string; id: string }[];
    interactiveWithoutName: string[];
    duplicateIds: string[];
    horizontalOverflow: number;
    smallTapTargets: TapTarget[];
    contrast: ContrastIssue[];
  };
  styles: {
    bodyBackground: string;
    bodyColor: string;
    bodyFont: string;
    h1: { fontFamily: string; fontSize: string; fontWeight: string } | null;
    firstButton: { background: string; color: string; height: number } | null;
  };
  errors: { console: string[]; page: string[] };
  network: {
    failures: { url: string; status: number | null; reason: string }[];
    externalHosts: string[];
    externalRequests: number;
  };
};

type ProbeResult = {
  desktop: ProbeFindings;
  mobile: ProbeFindings;
  screenshots: string[];
  domPath: string;
  generatedAt: string;
};

const DESKTOP = { width: 1440, height: 900 };
const MOBILE = { width: 390, height: 844 };

export async function probePreview(url: string, outDir: string): Promise<ProbeResult> {
  await mkdir(outDir, { recursive: true });
  const browser = await chromium.launch();
  try {
    const desktop = await observe(browser, url, DESKTOP, join(outDir, 'desktop-full.png'), join(outDir, 'desktop-fold.png'));
    const mobile = await observe(browser, url, MOBILE, join(outDir, 'mobile-full.png'), join(outDir, 'mobile-fold.png'));
    await writeFile(join(outDir, 'dom.html'), desktop.dom, 'utf8');
    const result: ProbeResult = {
      desktop: desktop.findings,
      mobile: mobile.findings,
      screenshots: ['desktop-full.png', 'desktop-fold.png', 'mobile-full.png', 'mobile-fold.png'],
      domPath: 'dom.html',
      generatedAt: new Date().toISOString(),
    };
    await writeFile(join(outDir, 'probe.json'), JSON.stringify(result, null, 2), 'utf8');
    return result;
  } finally {
    await browser.close();
  }
}

async function observe(browser: Browser, url: string, viewport: { width: number; height: number }, fullPath: string, foldPath: string) {
  const context = await browser.newContext({
    viewport,
    reducedMotion: 'reduce',
    deviceScaleFactor: 1,
    ignoreHTTPSErrors: false,
  });
  const page = await context.newPage();
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const failures: { url: string; status: number | null; reason: string }[] = [];
  const hosts = new Map<string, number>();
  const origin = new URL(url).origin;

  page.on('console', message => {
    if (message.type() === 'error') consoleErrors.push(clean(message.text()).slice(0, 500));
  });
  page.on('pageerror', error => pageErrors.push(clean(error.message).slice(0, 500)));
  page.on('requestfailed', request => {
    const failure = request.failure();
    failures.push({ url: clean(request.url()).slice(0, 500), status: null, reason: failure?.errorText ?? 'request failed' });
  });
  page.on('response', response => {
    try {
      const target = new URL(response.url());
      if (target.protocol.startsWith('http') && target.origin !== origin) hosts.set(target.host, (hosts.get(target.host) ?? 0) + 1);
    } catch {
      // data: / blob: 等没有可解析的 origin
    }
    if (response.status() >= 400) failures.push({ url: clean(response.url()).slice(0, 500), status: response.status(), reason: response.statusText() });
  });

  let status: number | null = null;
  try {
    const response = await page.goto(url, { waitUntil: 'load', timeout: 30_000 });
    status = response?.status() ?? null;
  } catch (error) {
    failures.push({ url, status: null, reason: `goto failed: ${clean((error as Error).message).slice(0, 300)}` });
  }
  await page.waitForTimeout(700);
  await page.screenshot({ path: fullPath, fullPage: true, animations: 'disabled' }).catch(() => undefined);
  await page.screenshot({ path: foldPath, fullPage: false, animations: 'disabled' }).catch(() => undefined);

  const dom = (await page.content().catch(() => '')).slice(0, 300_000);
  // tsx/esbuild 会给具名函数注入 __name 助手；直接序列化函数会在浏览器里抛 ReferenceError。
  const collector = `(() => { const __name = (target) => target; return (${collectFindings.toString()})(); })()`;
  const findings = await page.evaluate(collector).catch((): null => null) as Omit<ProbeFindings, 'url' | 'finalUrl' | 'status' | 'errors' | 'network'> | null;
  await context.close();

  const fallback: ProbeFindings = {
    url,
    finalUrl: url,
    status,
    title: '',
    lang: null,
    viewportMeta: null,
    headings: [],
    counts: { links: 0, buttons: 0, forms: 0, inputs: 0, images: 0, emptyLinks: 0, hashLinks: 0, ariaLive: 0, alerts: 0 },
    issues: {
      imagesWithoutAlt: [], brokenImages: [], inputsWithoutName: [], interactiveWithoutName: [],
      duplicateIds: [], horizontalOverflow: 0, smallTapTargets: [], contrast: [],
    },
    styles: { bodyBackground: '', bodyColor: '', bodyFont: '', h1: null, firstButton: null },
    errors: { console: consoleErrors, page: pageErrors },
    network: {
      failures: dedupeFailures(failures),
      externalHosts: [...hosts.keys()].sort(),
      externalRequests: [...hosts.values()].reduce((sum, value) => sum + value, 0),
    },
  };
  if (!findings) return { findings: fallback, dom };
  return {
    findings: {
      ...fallback,
      ...findings,
      errors: { console: consoleErrors, page: pageErrors },
      network: fallback.network,
    },
    dom,
  };
}

function dedupeFailures(items: { url: string; status: number | null; reason: string }[]) {
  const seen = new Set<string>();
  return items.filter(item => {
    const key = `${item.url}::${item.status}::${item.reason}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 50);
}

function clean(value: string) {
  return value.replace(/\s+/g, ' ').trim();
}

/** 在浏览器里执行：只返回结构化信号，不返回整页文本。 */
function collectFindings() {
  const visible = (element: Element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0 && rect.width > 0 && rect.height > 0;
  };
  const label = (element: Element) => (element.getAttribute('aria-label') ?? element.getAttribute('title') ?? element.textContent ?? '').replace(/\s+/g, ' ').trim();

  const images = [...document.querySelectorAll('img')];
  const imagesWithoutAlt = images.filter(image => !image.hasAttribute('alt') && visible(image)).map(image => (image.getAttribute('src') ?? '').slice(0, 200));
  const brokenImages = images.filter(image => visible(image) && image.complete && image.naturalWidth === 0).map(image => (image.getAttribute('src') ?? '').slice(0, 200));

  const inputs = [...document.querySelectorAll('input, select, textarea')].filter(visible) as HTMLInputElement[];
  const inputsWithoutName = inputs.filter(input => {
    if (input.type === 'hidden') return false;
    const labelled = input.labels && input.labels.length > 0;
    return !labelled && !input.getAttribute('aria-label') && !input.getAttribute('aria-labelledby') && !input.getAttribute('title');
  }).map(input => ({ tag: input.tagName.toLowerCase(), type: input.type, id: input.id }));

  const interactive = [...document.querySelectorAll('button, a[href], [role="button"]')].filter(visible);
  const interactiveWithoutName = interactive.filter(element => {
    if (element.getAttribute('aria-hidden') === 'true') return false;
    return label(element).length === 0 && !element.querySelector('img[alt]:not([alt=""])');
  }).map(element => element.tagName.toLowerCase()).slice(0, 20);

  const ids = [...document.querySelectorAll('[id]')].map(element => element.id).filter(Boolean);
  const idCounts = new Map<string, number>();
  for (const id of ids) idCounts.set(id, (idCounts.get(id) ?? 0) + 1);
  const duplicateIds = [...idCounts.entries()].filter(([, count]) => count > 1).map(([id]) => id).slice(0, 20);

  const tapTargets: { tag: string; label: string; width: number; height: number }[] = [];
  for (const element of interactive) {
    const style = getComputedStyle(element);
    if (element.tagName === 'A' && style.display === 'inline') continue;
    const rect = element.getBoundingClientRect();
    if (rect.width < 24 || rect.height < 24) {
      tapTargets.push({ tag: element.tagName.toLowerCase(), label: label(element).slice(0, 60), width: Math.round(rect.width), height: Math.round(rect.height) });
      if (tapTargets.length >= 20) break;
    }
  }

  const parseColor = (input: string) => {
    const match = input.match(/rgba?\(([^)]+)\)/);
    if (!match) return null;
    const parts = match[1].split(/[,/]/).map(value => Number(value.trim())).filter(value => !Number.isNaN(value));
    if (parts.length < 3) return null;
    return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
  };
  const blend = (top: { r: number; g: number; b: number; a: number }, bottom: { r: number; g: number; b: number }) => ({
    r: top.r * top.a + bottom.r * (1 - top.a),
    g: top.g * top.a + bottom.g * (1 - top.a),
    b: top.b * top.a + bottom.b * (1 - top.a),
  });
  const backgroundOf = (element: Element) => {
    let current: Element | null = element;
    let color = { r: 255, g: 255, b: 255 };
    const stack: { r: number; g: number; b: number; a: number }[] = [];
    while (current) {
      const style = getComputedStyle(current);
      if (style.backgroundImage !== 'none') return null;
      const parsed = parseColor(style.backgroundColor);
      if (parsed && parsed.a > 0) stack.push(parsed);
      current = current.parentElement;
    }
    for (const layer of stack.reverse()) color = blend(layer, color);
    return color;
  };
  const luminance = (color: { r: number; g: number; b: number }) => {
    const channel = (value: number) => {
      const scaled = value / 255;
      return scaled <= 0.03928 ? scaled / 12.92 : Math.pow((scaled + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
  };
  const ratio = (a: { r: number; g: number; b: number }, b: { r: number; g: number; b: number }) => {
    const l1 = luminance(a);
    const l2 = luminance(b);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  };

  const contrast: { tag: string; text: string; color: string; background: string; ratio: number; fontSize: number; fontWeight: number }[] = [];
  const textElements = [...document.querySelectorAll('body *')].filter(element => {
    if (!visible(element)) return false;
    if (element.closest('[aria-hidden="true"]')) return false;
    if (['SCRIPT', 'STYLE', 'NOSCRIPT'].includes(element.tagName)) return false;
    return [...element.childNodes].some(node => node.nodeType === Node.TEXT_NODE && (node.textContent ?? '').trim().length > 1);
  });
  for (const element of textElements) {
    if (contrast.length >= 15) break;
    const style = getComputedStyle(element);
    const foreground = parseColor(style.color);
    const background = backgroundOf(element);
    if (!foreground || !background) continue;
    const fontSize = Number.parseFloat(style.fontSize);
    const fontWeight = Number.parseInt(style.fontWeight, 10) || 400;
    if (!Number.isFinite(fontSize) || fontSize < 10) continue;
    const value = ratio(foreground, background);
    const large = fontSize >= 24 || (fontSize >= 18.66 && fontWeight >= 700);
    if (value < (large ? 3 : 4.5)) {
      contrast.push({
        tag: element.tagName.toLowerCase(),
        text: (element.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 80),
        color: style.color,
        background: `rgb(${Math.round(background.r)}, ${Math.round(background.g)}, ${Math.round(background.b)})`,
        ratio: Math.round(value * 100) / 100,
        fontSize,
        fontWeight,
      });
    }
  }

  const headings = [...document.querySelectorAll('h1, h2, h3, h4, h5, h6')].filter(visible).slice(0, 30).map(element => ({
    level: Number(element.tagName.slice(1)),
    text: (element.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 120),
  }));
  const h1 = document.querySelector('h1');
  const firstButton = document.querySelector('button');
  const bodyStyle = getComputedStyle(document.body);
  const h1Style = h1 ? getComputedStyle(h1) : null;
  const buttonStyle = firstButton ? getComputedStyle(firstButton) : null;

  return {
    title: document.title,
    lang: document.documentElement.getAttribute('lang'),
    viewportMeta: document.querySelector('meta[name="viewport"]')?.getAttribute('content') ?? null,
    headings,
    counts: {
      links: document.querySelectorAll('a[href]').length,
      buttons: document.querySelectorAll('button').length,
      forms: document.querySelectorAll('form').length,
      inputs: inputs.length,
      images: images.length,
      emptyLinks: [...document.querySelectorAll('a[href="#"], a:not([href])')].length,
      hashLinks: document.querySelectorAll('a[href="#"]').length,
      ariaLive: document.querySelectorAll('[aria-live]').length,
      alerts: document.querySelectorAll('[role="alert"]').length,
    },
    issues: {
      imagesWithoutAlt,
      brokenImages,
      inputsWithoutName,
      interactiveWithoutName,
      duplicateIds,
      horizontalOverflow: Math.max(0, Math.round(document.documentElement.scrollWidth - window.innerWidth)),
      smallTapTargets: tapTargets,
      contrast,
    },
    styles: {
      bodyBackground: bodyStyle.backgroundColor,
      bodyColor: bodyStyle.color,
      bodyFont: bodyStyle.fontFamily,
      h1: h1Style ? { fontFamily: h1Style.fontFamily, fontSize: h1Style.fontSize, fontWeight: h1Style.fontWeight } : null,
      firstButton: buttonStyle && firstButton ? {
        background: buttonStyle.backgroundColor,
        color: buttonStyle.color,
        height: Math.round(firstButton.getBoundingClientRect().height),
      } : null,
    },
  };
}

function arg(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const url = arg('--url');
  const out = arg('--out');
  if (!url || !out) {
    console.error('用法：npx tsx evals/scripts/probe.ts --url <预览地址> --out <输出目录>');
    process.exit(2);
  }
  const result = await probePreview(url, out);
  console.log(`已写入 ${out}`);
  console.log(`  桌面：${result.desktop.title || '(无标题)'}｜横向溢出 ${result.desktop.issues.horizontalOverflow}px｜控制台 ${result.desktop.errors.console.length} 条`);
  console.log(`  手机：横向溢出 ${result.mobile.issues.horizontalOverflow}px｜小触控目标 ${result.mobile.issues.smallTapTargets.length} 个`);
}
