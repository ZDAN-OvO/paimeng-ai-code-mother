import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  antdDeprecatedProps,
  deprecatedPropViolations,
  formItemWiringViolations,
} from '../lib/ui-patterns';

/**
 * 管理端 UI 的静态护栏：只挡「生产构建里看不到、但用户在 dev 里一眼看到」的写法。
 *
 * 每条规则都对应一次真实事故：
 * - antd v6 废弃属性：`Space direction`（2026-10-13 用户贴截图）、
 *   `Input addonAfter/addonBefore`（2026-10-13 复核时发现）、`Drawer width`
 *   （2026-11-03 配置模型抽屉，第四次同类）。生产构建会剥离这些告警，所以
 *   `npm run test:e2e:isolated` 抓不到；动态兜底是 `npm run test:e2e:dev`。
 * - 有 `name` 的 `Form.Item` 直接子节点不是控件而是包装元素：antd 只把 value/onChange
 *   注入直接子节点，包装元素会把它们丢掉，字段永远收不到值
 *   （2026-10-13 别名「上游模型名」选了模型却写不进数据库，且没有任何告警）。
 * - `{' '}`：antd 的 Form.Item 收到多个子节点后不再注入 value/onChange，开关会变成
 *   「点了界面会动、保存不落库」的死控件（2026-10-12 六个开关全部失效）。
 *
 * 废弃属性只认表：`scripts/lib/ui-patterns.ts` 的 `antdDeprecatedProps`。再踩一次就往表里加一行，
 * 不要为单个组件再写一条正则。
 */

const root = process.cwd();
const sourceDir = join(root, 'src');

function tsxFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...tsxFiles(path));
    else if (entry.name.endsWith('.tsx')) found.push(path);
  }
  return found;
}

if (!existsSync(sourceDir)) {
  console.error(`找不到 ${sourceDir}；请在 paimeng-ai-code-agent/ 目录下运行本检查`);
  process.exitCode = 1;
} else {
  const files = tsxFiles(sourceDir);
  const violations: string[] = [];
  for (const file of files) {
    const name = relative(root, file);
    const text = readFileSync(file, 'utf8');
    violations.push(...deprecatedPropViolations(name, text));
    violations.push(...formItemWiringViolations(name, text));
  }
  if (violations.length > 0) {
    console.error('UI 写法检查未通过：');
    for (const violation of violations) console.error(`- ${violation}`);
    process.exitCode = 1;
  } else {
    console.log(
      `UI 写法检查通过（${files.length} 个 tsx，${antdDeprecatedProps.length} 条废弃属性规则）`,
    );
  }
}
