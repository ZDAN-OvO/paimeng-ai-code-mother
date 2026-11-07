import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const now = new Date();
const day = [
  String(now.getFullYear()).slice(-2),
  String(now.getMonth() + 1).padStart(2, '0'),
  String(now.getDate()).padStart(2, '0'),
].join('-');

/**
 * 证据根目录，按运行日分目录。
 *
 * 默认写到 `runtime/evidence/<YY-MM-DD>/`（已 gitignore）。验证技能用
 * `E2E_EVIDENCE_ROOT` 把它指到自己的证据目录，这样一次证明的截图、日志和报告
 * 落在同一个可整包带走的位置，而不是散在 runtime/ 里等着被下一次运行覆盖。
 */
const root = join(
  process.env.E2E_EVIDENCE_ROOT ??
    fileURLToPath(new URL('../../../runtime/evidence', import.meta.url)),
  day,
);

/** Return a dated evidence directory under the evidence root, creating it. */
export function evidenceDir(...parts: string[]): string {
  const dir = join(root, ...parts);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Return a dated evidence file path under the evidence root, creating its parent directory. */
export function evidencePath(...parts: string[]): string {
  const path = join(root, ...parts);
  mkdirSync(dirname(path), { recursive: true });
  return path;
}
