import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { REQUIRED_PRODUCT_OPERATIONAL_BUILD_ENV } from '../../../apps/product/production-build-gate.mjs';
import { REQUIRED_WEB_OPERATIONAL_BUILD_ENV } from '../../../apps/web/production-build-gate.mjs';
import { onePasswordEnvSchema } from './schema';

/**
 * replica ⊆ 台帳 検査（#2084）。
 *
 * Vercel production env の key 名だけを取得し、1Password 台帳
 * （scripts/tasks/env/schema.ts の onePasswordEnvSchema）に無い key を検出する。
 * 既存の production-config-audit.mjs が「台帳側の必須 key が Vercel に揃って
 * いるか」（台帳 → replica）を見るのに対し、こちらは逆方向 —「Vercel にあるが
 * 台帳に無い値の存在」= docs/operations/secrets.md 基本方針 7
 * 「値がどこに存在していようと、必ず 1Password にもある」の違反を検出する。
 *
 * 値は一切取得・保持・表示しない。API 応答は key / target のみに即時射影し、
 * value プロパティには触れない（secrets.md §API 経由の設定読戻し）。
 *
 * fetch / 射影は production-config-audit.mjs と同型だが import しない。
 * あちらは audit contract 保護対象（変更すると PR ごとに trusted dispatch が
 * 要る）のため、export 追加を避けてこの script に閉じる。build-gate の
 * REQUIRED_*_OPERATIONAL_BUILD_ENV は既存 export の import のみで、保護対象
 * ファイルの変更は伴わない。
 */

const PROJECTS = ['product', 'web'] as const;

/**
 * 検査方向が「未台帳 key の検出 = 検出ゼロが green」なので、応答の欠落
 * （pagination の途中打ち切り、target 表現の変更、空応答）がそのまま
 * 偽グリーンになる。build gate が Vercel Production に必ず要求する key を
 * 床（sanity floor）とし、これを下回る応答は検査結果ではなく取得失敗として
 * throw する。
 */
const REQUIRED_PRODUCTION_FLOOR: Record<(typeof PROJECTS)[number], readonly string[]> = {
  product: REQUIRED_PRODUCT_OPERATIONAL_BUILD_ENV,
  web: REQUIRED_WEB_OPERATIONAL_BUILD_ENV,
};

/**
 * 台帳（schema）に無いが Vercel Production に存在してよい key。
 * 追加する時は必ず理由を書く。空にできている状態が正常で、ここが増えるのは
 * 台帳へ登録できない構造的理由がある時だけ。
 *
 * 以下は Supabase↔Vercel Marketplace integration（configurationId
 * icfg_ZZhIJpCa3ksZJLqBXjg257gb、slug: supabase）が product project の
 * Production へ自動注入する固定セット。Vercel API の `configurationId` で
 * integration 由来と確認済み（#2094 調査）。Supabase 公式ドキュメントの
 * 仕様どおり per-key の選択的無効化はできず（all-or-nothing）、同じ
 * integration が Preview の PR Preview Branch credentials 注入も担うため
 * integration 自体の切断もできない。アプリコードからの参照は 0 件
 * （production runtime / build-gate / env.ts のいずれにも無い）。
 * 実値は integration が管理し 1Password には置かない。
 * #2517: runtime が使う SUPABASE_SECRET_KEY と NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
 * は production 台帳へ移した。Preview の値は引き続き integration が管理する。
 */
export const allowedNonLedgerKeys: ReadonlyMap<string, string> = new Map<string, string>([
  ['POSTGRES_DATABASE', 'Supabase↔Vercel integration 自動注入。アプリ未参照（#2094）'],
  ['POSTGRES_HOST', 'Supabase↔Vercel integration 自動注入。アプリ未参照（#2094）'],
  ['POSTGRES_PASSWORD', 'Supabase↔Vercel integration 自動注入。アプリ未参照（#2094）'],
  ['POSTGRES_PRISMA_URL', 'Supabase↔Vercel integration 自動注入。アプリ未参照（#2094）'],
  ['POSTGRES_URL', 'Supabase↔Vercel integration 自動注入。アプリ未参照（#2094）'],
  ['POSTGRES_URL_NON_POOLING', 'Supabase↔Vercel integration 自動注入。アプリ未参照（#2094）'],
  ['POSTGRES_USER', 'Supabase↔Vercel integration 自動注入。アプリ未参照（#2094）'],
  ['SUPABASE_JWT_SECRET', 'Supabase↔Vercel integration 自動注入。アプリ未参照（#2094）'],
  ['SUPABASE_PUBLISHABLE_KEY', 'Supabase↔Vercel integration 自動注入。アプリ未参照（#2094）'],
  // #2094 では configurationId が無い「手動残骸」と判定して 2026-08-17 に削除したが、
  // 2026-08-24 に同じ integration（icfg_ZZhIJpCa3ksZJLqBXjg257gb）が再注入した。
  // 注入セットが 11 件から増えた形で、削除しても戻るため allowlist へ移す（#2458）。
  [
    'SUPABASE_ANON_KEY',
    'Supabase↔Vercel integration 自動注入（2026-08-24 に再注入）。アプリ未参照（#2094 / #2458）',
  ],
]);

export type EnvKeyEntry = { key: string; targets: string[] };

/** API 応答を key / targets のみに射影する。想定外の形は fail closed で throw。 */
export function normalizeEnvKeys(response: unknown): EnvKeyEntry[] {
  if (
    !response ||
    typeof response !== 'object' ||
    !Array.isArray((response as { envs?: unknown }).envs)
  ) {
    throw new Error('Vercel environment metadata response is invalid');
  }

  // 複数ページに割れた応答を 1 ページ目だけで「全量」と誤読しない。
  // 実装当時の実測（2026-08-14、product 39 entry）では pagination は返らな
  // かったが、件数が増えて next が現れた時に黙って偽グリーンへ倒れないよう
  // fail closed にしておく。
  const pagination = (response as { pagination?: unknown }).pagination;
  if (
    pagination &&
    typeof pagination === 'object' &&
    (pagination as { next?: unknown }).next != null
  ) {
    throw new Error('Vercel environment metadata response is paginated; refusing partial results');
  }

  return (response as { envs: unknown[] }).envs.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const { key, target } = entry as { key?: unknown; target?: unknown };
    if (typeof key !== 'string') return [];
    const targets = Array.isArray(target)
      ? target.filter((item): item is string => typeof item === 'string')
      : [];
    return [{ key, targets }];
  });
}

export function buildLedger(): ReadonlySet<string> {
  return new Set(onePasswordEnvSchema.map((entry) => entry.envName));
}

/**
 * sanity floor: production target の key 集合が build gate の必須集合を
 * 含まなければ、応答の欠落（truncation / target 形状 drift / 空応答）と
 * みなして throw する。key 名しか扱わない。
 */
export function assertProductionFloor(
  projectName: (typeof PROJECTS)[number],
  entries: readonly EnvKeyEntry[],
): void {
  const productionKeys = new Set(
    entries.filter((entry) => entry.targets.includes('production')).map((entry) => entry.key),
  );
  const missing = REQUIRED_PRODUCTION_FLOOR[projectName].filter((key) => !productionKeys.has(key));
  if (missing.length > 0) {
    throw new Error(
      `Vercel environment metadata for ${projectName} is missing required production keys (${missing.join(', ')}); response looks truncated or malformed`,
    );
  }
}

/** Production target の key のうち、台帳にも allowlist にも無いものを返す（重複除去・sort 済み）。 */
export function findUnlistedKeys(
  entries: readonly EnvKeyEntry[],
  ledger: ReadonlySet<string>,
  allowlist: ReadonlyMap<string, string> = allowedNonLedgerKeys,
): string[] {
  const unlisted = entries
    .filter((entry) => entry.targets.includes('production'))
    .map((entry) => entry.key)
    .filter((key) => !ledger.has(key) && !allowlist.has(key));
  return Array.from(new Set(unlisted)).sort();
}

async function fetchEnvMetadata(
  projectName: string,
  token: string,
  teamId: string,
  fetchImpl: typeof fetch,
): Promise<unknown> {
  const url = new URL(`https://api.vercel.com/v10/projects/${encodeURIComponent(projectName)}/env`);
  url.searchParams.set('teamId', teamId);

  const response = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    // レスポンス本文は secret を含みうるため、status 以外を echo しない
    throw new Error(
      `Vercel environment metadata request failed for project: ${projectName} (status ${response.status})`,
    );
  }
  try {
    return await response.json();
  } catch {
    // JSON.parse の SyntaxError は message に本文断片を埋め込むため、
    // そのまま投げ直さず固定文言に差し替える
    throw new Error(
      `Vercel environment metadata response was not JSON for project: ${projectName}`,
    );
  }
}

export async function runReplicaCheck({
  token,
  teamId,
  fetchImpl = fetch,
}: {
  token: string | undefined;
  teamId: string | undefined;
  fetchImpl?: typeof fetch;
}): Promise<string[]> {
  if (!token) throw new Error('VERCEL_TOKEN is required for replica check');
  if (!teamId) throw new Error('VERCEL_TEAM_ID is required for replica check');

  const ledger = buildLedger();
  const findings: string[] = [];
  for (const projectName of PROJECTS) {
    const response = await fetchEnvMetadata(projectName, token, teamId, fetchImpl);
    const entries = normalizeEnvKeys(response);
    assertProductionFloor(projectName, entries);
    for (const key of findUnlistedKeys(entries, ledger)) {
      findings.push(
        `${projectName}: ${key} は Vercel Production にあるが 1Password 台帳（scripts/tasks/env/schema.ts）に無い`,
      );
    }
  }
  return findings;
}

// 素の `import.meta.url === file://argv[1]` は symlink（macOS の /tmp →
// /private/tmp 等）や percent-encoding で一致せず「無出力で exit 0」に
// 倒れる fail open を、この repo は 2026-08-11 に実測済み
// （production-auth-config-audit.mjs と同修正。契約は
// scripts/__tests__/check-vercel-replica.test.ts が固定する）。
function isDirectExecution(): boolean {
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (isDirectExecution()) {
  runReplicaCheck({
    token: process.env.VERCEL_TOKEN,
    teamId: process.env.VERCEL_TEAM_ID,
  })
    .then((findings) => {
      if (findings.length === 0) {
        console.log(
          'Replica check passed: Vercel Production の全 key が 1Password 台帳に載っている',
        );
        return;
      }
      for (const finding of findings) {
        console.log(`NG ${finding}`);
      }
      console.log(
        '対応: master（1Password）へ登録して scripts/tasks/env/schema.ts に entry を足すか、Vercel 側から撤去する（docs/operations/secrets.md §External Replicas）',
      );
      process.exitCode = 1;
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : 'replica check failed');
      process.exitCode = 1;
    });
}
