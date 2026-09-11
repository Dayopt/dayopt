/**
 * service role で破壊的な seed / cleanup を行う E2E の実行先ガード。
 *
 * 対象 suite は auth user、profile、user_settings、tag、plan、record を作って
 * 消す。`NEXT_PUBLIC_SUPABASE_URL` と `SUPABASE_SECRET_KEY` が「揃っている
 * こと」だけを条件にすると、Production の認証情報を持つ shell から起動された
 * 瞬間に Production のデータを mutate する。CLAUDE.md の `EXPLICIT AUTHORITY`
 * （production mutation・データ削除は明示指示が揃うまで実行しない）に反するので、
 * 実行先が安全であることを確認できた場合だけ suite を有効にする。
 *
 * 既定はローカル stack のみ。PR Preview など非ローカルで走らせる場合は
 * `E2E_ALLOW_NONLOCAL_SUPABASE=1` の明示的な opt-in を要求する。
 * Production project ref は opt-in があっても許可しない。
 *
 * `e2e/` 配下ではなくここに置く。vitest の unit project は `**\/e2e/**` を exclude
 * するため、あの場所では単体テストが実行されない（`apps/product/vitest.config.ts` の
 * `UNIT_EXCLUDE` 参照。`usability-probe-guards.ts` と同じ理由）。
 */

/** Production Supabase project ref（docs/engineering/infra.md §Supabase Project）。 */
const PRODUCTION_PROJECT_REF = 'yvglwblxrnrenfifsnje';

const LOCAL_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

type ServiceRoleTarget = { safe: true } | { safe: false; reason: string };

export function resolveServiceRoleTarget(
  supabaseUrl: string | undefined,
  serviceRoleKey: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): ServiceRoleTarget {
  if (!supabaseUrl || !serviceRoleKey) {
    return { safe: false, reason: 'NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SECRET_KEY が未設定' };
  }

  let hostname: string;
  try {
    hostname = new URL(supabaseUrl).hostname;
  } catch {
    return {
      safe: false,
      reason: `NEXT_PUBLIC_SUPABASE_URL を URL として解釈できない: ${supabaseUrl}`,
    };
  }

  // opt-in があっても Production だけは通さない
  if (hostname.includes(PRODUCTION_PROJECT_REF)) {
    return {
      safe: false,
      reason: 'Production project を指しているため実行しない（破壊的 seed / cleanup を含む）',
    };
  }

  if (LOCAL_HOSTNAMES.has(hostname)) return { safe: true };

  if (env.E2E_ALLOW_NONLOCAL_SUPABASE === '1') return { safe: true };

  return {
    safe: false,
    reason: `非ローカルの Supabase (${hostname}) には E2E_ALLOW_NONLOCAL_SUPABASE=1 の明示 opt-in が必要`,
  };
}

/**
 * 「この suite は必ず走るはず」の実行環境で、guard が unsafe と判定したら throw する。
 *
 * `safe === false` で suite を丸ごと `test.describe.skip` にする設計は安全側だが、
 * skip は Playwright 上「0 failed」として集計されるため、**実行先の env が壊れていても
 * CI は緑になる**。実際 `promote.yml` は `supabase status | jq` の出力を
 * `SUPABASE_SECRET_KEY` へ渡しており、ここが空文字に落ちれば破壊的 suite が
 * 全部静かに消えたまま job が通る。
 *
 * そこで「走らないとおかしい」実行主体（= CI）だけが
 * `E2E_REQUIRE_SERVICE_ROLE_SUITES=1` を立て、その時は skip ではなく module load 時の
 * throw にする。ローカルや env の無い環境では従来どおり skip する。
 */
export function assertServiceRoleSuiteRunnable(
  target: ServiceRoleTarget,
  suiteName: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (target.safe) return;
  if (env.E2E_REQUIRE_SERVICE_ROLE_SUITES !== '1') return;
  throw new Error(
    `E2E_REQUIRE_SERVICE_ROLE_SUITES=1 だが suite "${suiteName}" を実行できない: ${target.reason}`,
  );
}
