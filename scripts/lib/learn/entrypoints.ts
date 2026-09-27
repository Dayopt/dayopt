/**
 * 外から product へ入る HTTP の入口を、実装から発見する。
 *
 *   - api-route  apps/product/src/app/api/【...】/route.ts（export している method を読む）
 *   - cron       apps/product/vercel.json の crons（該当する route に schedule を付ける）
 *
 * 一覧は機械が作り、説明（誰が呼ぶ・なぜ・止まると）は docs/learn/system/entrypoints.md の
 * learn:entrypoints が持つ。両者の対応は docs-guard の learn-refs が検査する（一覧にあって説明が
 * 無い入口、説明があって一覧に無い入口はどちらも fail）。
 *
 * architecture-map の inventory.ts は tRPC / MCP / page を発見するが HTTP の入口は持たない。
 * 入口をそちらへ載せる時は、この発見器を inventory.ts へ移して 1 か所にする。
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { glob } from 'glob';

const API_DIR = 'apps/product/src/app/api';
const VERCEL_JSON = 'apps/product/vercel.json';
const HTTP_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const;
type HttpMethod = (typeof HTTP_METHODS)[number];

export interface Entrypoint {
  /** URL の path。動的 segment は App Router の書き方のまま（例 /api/v1/calendar/[token]） */
  id: string;
  /** repo-relative path（route.ts） */
  path: string;
  methods: HttpMethod[];
  /** vercel.json の crons に載っている時だけ。cron 式 */
  schedule?: string;
}

const METHOD_SET = new Set<string>(HTTP_METHODS);

/** route.ts が export している HTTP method。宣言と `export { x as GET }` の両方を読む。 */
export function routeMethods(text: string): HttpMethod[] {
  const found = new Set<HttpMethod>();
  for (const m of text.matchAll(
    /^export\s+(?:async\s+)?(?:const|function|let)\s+(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)\b/gm,
  )) {
    found.add(m[1] as HttpMethod);
  }
  for (const m of text.matchAll(/^export\s*\{([^}]*)\}/gm)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().replace(/^.*\s+as\s+/, '');
      if (METHOD_SET.has(name)) found.add(name as HttpMethod);
    }
  }
  return HTTP_METHODS.filter((method) => found.has(method));
}

export interface EntrypointDiscovery {
  entrypoints: Entrypoint[];
  /** 発見の途中で見つかった矛盾（cron が指す route が無い、など） */
  errors: string[];
}

export function discoverEntrypoints(root: string): EntrypointDiscovery {
  const errors: string[] = [];
  const byId = new Map<string, Entrypoint>();

  const files = glob.sync('**/route.ts', { cwd: resolve(root, API_DIR) }).sort();
  for (const file of files) {
    const dir = file.replace(/\/?route\.ts$/, '');
    const id = `/api${dir ? `/${dir}` : ''}`;
    const path = `${API_DIR}/${file}`;
    const methods = routeMethods(readFileSync(resolve(root, path), 'utf8'));
    if (methods.length === 0) errors.push(`${path}: export している HTTP method が読めない`);
    byId.set(id, { id, path, methods });
  }

  const vercelPath = resolve(root, VERCEL_JSON);
  if (existsSync(vercelPath)) {
    const parsed: unknown = JSON.parse(readFileSync(vercelPath, 'utf8'));
    const crons =
      typeof parsed === 'object' && parsed !== null && 'crons' in parsed
        ? (parsed as { crons?: unknown }).crons
        : undefined;
    for (const cron of Array.isArray(crons) ? crons : []) {
      if (typeof cron !== 'object' || cron === null) continue;
      const { path, schedule } = cron as { path?: unknown; schedule?: unknown };
      if (typeof path !== 'string' || typeof schedule !== 'string') {
        errors.push(`${VERCEL_JSON}: crons の要素に path / schedule が無い`);
        continue;
      }
      const entry = byId.get(path);
      if (!entry) {
        errors.push(`${VERCEL_JSON}: cron ${path} に対応する route.ts が無い`);
        continue;
      }
      entry.schedule = schedule;
    }
  }

  return { entrypoints: [...byId.values()].sort((a, b) => a.id.localeCompare(b.id)), errors };
}

/** cron 式を人が読める間隔にする（教材の表用。読めない形はそのまま返す）。 */
export function describeSchedule(schedule: string): string {
  const every = schedule.match(/^\*\/(\d+) \* \* \* \*$/);
  if (every) return `${every[1]} 分ごと`;
  const hourly = schedule.match(/^(\d+) \* \* \* \*$/);
  if (hourly) return `毎時 ${hourly[1]} 分`;
  const daily = schedule.match(/^(\d+) (\d+) \* \* \*$/);
  if (daily) return `毎日 ${daily[2]}:${daily[1].padStart(2, '0')} UTC`;
  return schedule;
}
