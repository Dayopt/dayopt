import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * service-role client で `.auth.*` を叩く場所を固定する（#1925）
 *
 * service-role の `Authorization` は GoTrue に admin role として解釈され、`verifyCaptcha` が
 * skip される。つまり **service-role client 経由の `.auth.*` は captcha を迂回する**。
 * `.auth.admin.*` は admin API でしか出来ない特権操作なので対象外だが、それ以外
 * （`signInWithPassword` / `signUp` / `verifyOtp` / `updateUser` 等）は迂回にあたる。
 *
 * 迂回が無自覚に増えると「どこが bot protection の適用外か」を誰も把握できなくなるため、
 * 許可した 1 ファイル以外に現れたら落とす。
 *
 * ## 検出契約（限界も含めて明示する）
 *
 * - **検出する**: 同一ファイル内で `createServiceRoleClient()` を代入した識別子に対する
 *   `X.auth.<admin 以外>`、および `createServiceRoleClient().auth.<admin 以外>` の直接 chain
 * - **検出しない（盲点）**:
 *   - ファイルを跨いで client を受け渡すケース。引数で受け取った `SupabaseClient` が
 *     service-role かどうかは静的に追えない
 *   - 1 段の中間束縛（`const { auth } = createServiceRoleClient()` / `const a = admin.auth`）
 *   - computed access（`admin.auth['signUp'](...)`）と分割代入（`const { signUp } = admin.auth`）
 *   - **`supabase/functions/**`（Edge Functions）**。service role key を常用する領域だが
 *     この走査は `apps/product/src` に閉じている
 *
 * いずれも「故意の回避」であり、guard の目的（**無自覚な**再導入の阻止）には足りている。
 * 網羅と誤認しないよう明記しておく。
 *
 * ファイル単位のナイーブな判定（「`createServiceRoleClient` を含み、かつ `.auth.` を含む」）
 * にはしない。user-service.ts は user-scoped の `supabase.auth.mfa.*` と
 * `createServiceRoleClient()` が同居しており、即座に誤検出するため。
 */

const SRC_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/** 迂回を意図的に行ってよい唯一の場所 */
const ALLOWED_FILES = ['features/auth/server/password-reauthentication.ts'];

const SKIPPED_DIRECTORIES = new Set(['node_modules']);

function collectSourceFiles(directory: string, found: string[] = []): string[] {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
      collectSourceFiles(path, found);
      continue;
    }
    if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) found.push(path);
  }
  return found;
}

/** `createServiceRoleClient()` の代入先識別子を集める */
function collectClientIdentifiers(source: string): string[] {
  const pattern =
    /(?:const|let|var|readonly)\s+(\w+)(?:\s*:[^=]+)?\s*=\s*createServiceRoleClient\(/g;
  return [...source.matchAll(pattern)].map(([, identifier]) => identifier as string);
}

function usesServiceRoleAuth(source: string): boolean {
  if (!source.includes('createServiceRoleClient')) return false;

  // 直接 chain: createServiceRoleClient().auth.<admin 以外>
  if (/createServiceRoleClient\(\)\s*\.\s*auth\s*\.\s*(?!admin\b)\w/.test(source)) return true;

  // `(?<![.\w$])` が要る。素の `\b` だと `ctx.supabase.auth.getUser()` のような
  // **別オブジェクトのプロパティ**にも一致し、user-scoped client の呼び出しを
  // service-role の迂回と誤検出する（lib/email/notifications.ts で実際に踏んだ）
  return collectClientIdentifiers(source).some((identifier) =>
    new RegExp(`(?<![.\\w$])${identifier}\\s*\\.\\s*auth\\s*\\.\\s*(?!admin\\b)\\w`).test(source),
  );
}

describe('service-role client の auth 使用', () => {
  const offenders = collectSourceFiles(SRC_ROOT)
    .filter((path) => !path.includes(`${join('lib', 'test', 'integration')}`))
    .filter((path) => usesServiceRoleAuth(readFileSync(path, 'utf8')))
    .map((path) => relative(SRC_ROOT, path).split('\\').join('/'))
    .sort();

  it('走査が空振りしていない（path 解決の事故を検出する）', () => {
    expect(collectSourceFiles(SRC_ROOT).length).toBeGreaterThan(100);
  });

  // 過不足なく一致させる。増えた場合だけでなく、ラッパーの呼び出しが消えた場合も落とす
  it('captcha を迂回する auth 呼び出しは許可した 1 ファイルだけにある', () => {
    expect(offenders).toEqual(ALLOWED_FILES);
  });
});
