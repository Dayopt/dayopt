import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createServerClient: vi.fn(),
}));

vi.mock('next/headers', () => ({
  cookies: vi.fn().mockResolvedValue({ getAll: vi.fn().mockReturnValue([]), set: vi.fn() }),
}));

vi.mock('@supabase/ssr', () => ({
  createServerClient: mocks.createServerClient,
}));

vi.mock('@/env', () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: 'https://example.supabase.co',
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'test-anon-key',
  },
}));

import { createClient as createSupabaseServerClient } from './server';

const SRC_ROOT = path.resolve(import.meta.dirname, '../..');

/**
 * Node runtime で動く Supabase client factory。全て W3C traceparent を伝播する（#2728）。
 * 新しい factory を足したらここへ追加する。列挙漏れは下の contract test が落とす。
 */
const TRACED_FACTORY_FILES = [
  'app/api/health/route.ts',
  'features/external-calendar/server/account-deletion.ts',
  'features/external-calendar/server/connection-service.ts',
  'features/external-calendar/server/event-pruning.ts',
  'features/external-calendar/server/fenced-sync-writer.ts',
  'features/external-calendar/server/sync-service.ts',
  'features/external-calendar/server/token-rotation.ts',
  'features/timeblock/server/mcp-mutation-db.ts',
  'features/timeblock/server/mcp-timeblock-read-client.ts',
  'lib/mcp/access-db.ts',
  'lib/oauth-server/db.ts',
  'lib/supabase/oauth.ts',
  'lib/supabase/server.ts',
  'lib/trpc/context.ts',
  'lib/trpc/server.ts',
];

/**
 * 伝播しない factory と、その機構上の理由。
 * どちらの Sentry SDK も OpenTelemetry の global propagator を登録しないため、
 * 同じ option を渡しても extractor が空の carrier しか返さず header が付かない。
 */
const UNTRACED_FACTORY_FILES: Record<string, string> = {
  'lib/supabase/client.ts': 'browser（@sentry/browser は @opentelemetry/api を使わない）',
  'lib/supabase/middleware.ts': 'edge（@sentry/vercel-edge は @opentelemetry/api を持たない）',
};

/**
 * Supabase の factory を実際に import しているファイルだけを拾う。
 * 呼び出しの形（generic の有無、static / dynamic import）に依存させない
 * —— `createClient<Database>(` だけを見る形にすると `src/app/api/health/route.ts` の
 * 非 generic な `createClient(` を取りこぼす（PR #2835 のレビュー指摘）。
 */
const FACTORY_NAMES = new Set(['createClient', 'createServerClient', 'createBrowserClient']);
const STATIC_IMPORT_PATTERN =
  /import\s+(type\s+)?\{([^}]*)\}\s*from\s*'@supabase\/(?:supabase-js|ssr)'/gu;
// 分割代入は 1 行に収まる想定。`[^}]*` にすると手前の `{` から貪欲に食って
// binding 名が一致しなくなる（lib/trpc/context.ts で実際に外した）。
const DYNAMIC_IMPORT_PATTERN =
  /\{([^{}\n]*)\}\s*=\s*await\s+import\(\s*'@supabase\/(?:supabase-js|ssr)'\s*\)/gu;

/**
 * import specifier から**元の名前**を取り出す。
 * `createClient as createAdminClient`（static import の alias）と
 * `createClient: createAdminClient`（dynamic import の分割代入 rename）の両方を
 * 正規化するので、局所名が何であっても factory を見失わない。
 */
function importedName(specifier: string): string {
  return (specifier.split(/\s+as\s+|:/u)[0] ?? '').trim();
}

function bindsSupabaseFactory(bindings: string): boolean {
  return bindings.split(',').some((specifier) => FACTORY_NAMES.has(importedName(specifier)));
}

function importsSupabaseFactory(source: string): boolean {
  for (const match of source.matchAll(STATIC_IMPORT_PATTERN)) {
    // `import type { ... }` は型だけなので factory を作らない。
    if (!match[1] && bindsSupabaseFactory(match[2] ?? '')) return true;
  }
  for (const match of source.matchAll(DYNAMIC_IMPORT_PATTERN)) {
    if (bindsSupabaseFactory(match[1] ?? '')) return true;
  }
  return false;
}

/** apps/product/src 配下の .ts / .tsx を再帰列挙する（test / generated を除く）。 */
function listSourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // generated: 型定義のみ。test: E2E fixture で production 経路ではない。
      return entry.name === 'generated' || entry.name === 'test' ? [] : listSourceFiles(absolute);
    }
    if (!/\.tsx?$/u.test(entry.name) || /\.(test|spec)\.tsx?$/u.test(entry.name)) return [];
    return [absolute];
  });
}

function findFactoryFiles(): string[] {
  return listSourceFiles(SRC_ROOT)
    .filter((absolute) => importsSupabaseFactory(readFileSync(absolute, 'utf8')))
    .map((absolute) => path.relative(SRC_ROOT, absolute).split(path.sep).join('/'))
    .sort();
}

describe('factory の走査', () => {
  // 取りこぼしは「分類テストが緑のまま factory が増える」形で出るので、
  // 走査の性質自体を固定する。過去 2 巡とも取りこぼしの指摘だった（PR #2835）。
  it.each([
    ["import { createClient } from '@supabase/supabase-js';", true],
    ["import { createClient as createAdminClient } from '@supabase/supabase-js';", true],
    ["import { createServerClient as ssrClient } from '@supabase/ssr';", true],
    ["import { createClient, type SupabaseClient } from '@supabase/supabase-js';", true],
    ["const { createServerClient } = await import('@supabase/ssr');", true],
    ["const { createServerClient: makeClient } = await import('@supabase/ssr');", true],
    // 型だけの import は client を作らない
    ["import type { SupabaseClient } from '@supabase/supabase-js';", false],
    ["import type { User, Session } from '@supabase/supabase-js';", false],
    // 別 module の同名 factory（`@/lib/supabase/client` 等）は対象外
    ["import { createClient } from '@/lib/supabase/client';", false],
    ['const supabase = createClient();', false],
  ])('%s → %s', (source, expected) => {
    expect(importsSupabaseFactory(source)).toBe(expected);
  });
});

describe('Supabase client factory の trace 伝播配線', () => {
  it('全ての factory が伝播対象か、理由付きの対象外かに分類されている', () => {
    // 新しい factory を足して分類し忘れると、silent に伝播しない client が増える。
    expect(findFactoryFiles()).toEqual(
      [...TRACED_FACTORY_FILES, ...Object.keys(UNTRACED_FACTORY_FILES)].sort(),
    );
  });

  it.each(TRACED_FACTORY_FILES)('%s が共有の opt-in を option として渡している', (relativePath) => {
    const source = readFileSync(path.join(SRC_ROOT, relativePath), 'utf8');

    // import の有無だけを見ると、option を外して import が残った状態で緑になる。
    expect(source).toContain('tracePropagation: SUPABASE_TRACE_PROPAGATION');
  });

  it.each(Object.entries(UNTRACED_FACTORY_FILES))('%s は opt-in しない（%s）', (relativePath) => {
    const source = readFileSync(path.join(SRC_ROOT, relativePath), 'utf8');

    expect(source).not.toContain('SUPABASE_TRACE_PROPAGATION');
  });

  it('server factory は @supabase/ssr へ tracePropagation を渡す', async () => {
    mocks.createServerClient.mockReturnValue({});

    await createSupabaseServerClient();

    const options = mocks.createServerClient.mock.calls[0]?.[2] as {
      tracePropagation?: { enabled?: boolean };
    };
    expect(options.tracePropagation).toEqual({ enabled: true });
  });
});
