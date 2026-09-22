#!/usr/bin/env node

/**
 * Protected Path Gate - determines from a changed-files list whether a PR
 * touches a protected path, used as the signal for whether
 * GitHub `@codex review` is eligible for the change (#2478,
 * tempo-linked review signal; downgraded from a merge-blocking gate to an
 * advisory signal in #2596 - merge itself is blocked by the main branch
 * repository ruleset).
 *
 * The old design required an extra cross-review on every PR uniformly. This
 * script narrows the "where should the standard review focus" signal to PRs that
 * touch protected paths. It is the single source of truth consumed by
 * `scripts/tasks/finish-branch.sh` (the glob list is not duplicated in bash to
 * avoid drift), which also reuses it to decide whether the `Production Config
 * Audit` trusted-dispatch checkpoint applies (`auditContract`, still a merge
 * gate - see below).
 *
 * The selection criterion is "external contract or irreversible" (#2489,
 * 2026-08-31): a mistake there is not caught by CI and cannot be undone by a
 * revert alone - it leaks across a tenant boundary, breaks an existing external
 * consumer, mutates production data, or disables the guardrails themselves.
 *
 * Dayopt's core time invariants (timezone / half-open interval / overlap) were
 * dropped from this list in the same change. They are reversible in-app
 * behavior covered by unit tests and CI, and keeping them here put nearly every
 * product PR on the required side - which, combined with cloud sessions where
 * `Workflow` / `Agent` are disabled by default (#2472), stalled merges instead
 * of adding review. `review:full` remains a human-only attention label and
 * does not expand this machine-selected scope.
 *
 * Retreat condition for that call: see AGENTS.md §レビュー (the sentence
 * referencing #2489 / #2503) for when a PR must carry `review:full` by hand
 * even though nothing here re-checks it. Described once there, not
 * duplicated here, to avoid two sources of truth drifting apart.
 *
 * Usage:
 *   printf '%s\n' file1 file2 | node scripts/ci/protected-path-gate.mjs --stdin
 *   node scripts/ci/protected-path-gate.mjs apps/product/src/features/auth/foo.ts
 *
 * Output: `{"required": true, "reason": "<matched glob>", "auditContract": <bool>}` or
 * `{"required": false, "auditContract": <bool>}`.
 *
 * `auditContract` は「audit contract そのもの（audit script / production-build-gate /
 * production-config-audit.yml）を変えたか」。`finish-branch.sh` が trusted dispatch の
 * commit status を要求するかの判定に使う（#2571）。
 *
 * Design notes:
 * - Unknown paths are simply a non-match (they do not push the verdict
 *   toward required). Unlike the Impact Resolver (scripts/ci/impact.mjs)
 *   this is an allowlist check ("does this touch a protected area?"), not a
 *   "what needs to build" check, so fail-closed here means "any glob match
 *   -> required", not "unknown -> required".
 * - Fail-closed behavior for empty input / missing node is the caller's
 *   responsibility (scripts/tasks/finish-branch.sh) - if node is missing
 *   this script cannot even run, so that branch cannot live here.
 */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * `.github/workflows/production-config-audit.yml` の self-change 検出
 * （`grep -Eq '^(...)$'`、`Detect audit contract changes` step）がリテラルで
 * 持つ 4 path。あちらは PR 由来の checkout を使わない trusted-base 判定用の
 * 別経路（Vercel token を PR code から隔離する）で、こちらの marker gate と
 * 目的は違うが対象は同じ 4 つの契約ファイルなので、リストの重複をここでは
 * named export にしてテスト（`scripts/__tests__/protected-path-gate-contract.test.ts`）
 * から両者の一致を機械的に固定する。どちらか一方だけ変えるとテストが落ちる。
 */
export const PRODUCTION_CONFIG_AUDIT_CONTRACT_PATHS = [
  'scripts/ci/production-config-audit.mjs',
  'apps/product/production-build-gate.mjs',
  'apps/web/production-build-gate.mjs',
  '.github/workflows/production-config-audit.yml',
];

/**
 * Protected path globs (OR'd together). If any changed file matches one of
 * these, the PR is eligible for GitHub `@codex review` at the stable
 * merge-candidate stage (#2596; no longer a merge-blocking requirement).
 * Add or remove entries only in this array (finish-branch.sh does not keep a copy).
 */
export const PROTECTED_PATH_GLOBS = [
  // auth / OAuth / MCP integrations
  'apps/product/src/features/auth/**',
  'apps/product/src/app/oauth/**',
  'apps/product/src/app/[locale]/oauth/**',
  'apps/product/src/app/api/oauth/**',
  'apps/product/src/app/.well-known/oauth-authorization-server/**',
  'apps/product/src/app/.well-known/oauth-protected-resource/**',
  // 認証 callback / middleware と共有判定層。route だけを保護しても、token 発行・
  // verified user・scope・redirect allowlist の実装変更が同じ境界を迂回する。
  'apps/product/src/app/[locale]/(auth)/auth/**',
  'apps/product/src/proxy.ts',
  'apps/product/src/lib/supabase/middleware.ts',
  'apps/product/src/lib/trpc/session-auth-context.ts',
  'apps/product/src/lib/auth/**',
  'apps/product/src/lib/safe-redirect.ts',
  'apps/product/src/lib/oauth-server/**',
  'apps/product/src/app/api/integrations/**',
  'apps/product/src/app/mcp/**',
  'apps/product/src/app/api/mcp/**',
  // MCP の認証 / 認可 + service role（RLS を迂回する）アクセス面全体（#2503 監査）。
  'apps/product/src/lib/mcp/**',
  // DB / migrations
  'supabase/migrations/**',
  'supabase/functions/**',
  // billing
  'apps/product/src/lib/stripe/**',
  'apps/product/src/lib/billing/**',
  'apps/product/src/app/api/webhooks/**',
  'apps/product/src/features/settings/server/billing-*.ts',
  // external calendar integrations
  'apps/product/src/features/external-calendar/server/providers/**',
  // Google OAuth client 契約。provider adapter だけでなく、scope / token response、
  // authority identity、PKCE state の変更も全利用者の接続互換性と認証境界へ波及する。
  'apps/product/src/features/external-calendar/server/google-oauth.ts',
  'apps/product/src/features/external-calendar/server/authority-config.ts',
  'apps/product/src/features/external-calendar/server/connect-flow.ts',
  'apps/product/src/features/external-calendar/schemas/google*.ts',
  // アカウント削除に伴う外部 calendar データの不可逆な一括削除を駆動する cron（#2503 監査）。
  'apps/product/src/app/api/cron/calendar-account-deletion-settle/**',
  // 不可逆な purge 本体 + provider 側 token の revoke（#2503 監査）。
  'apps/product/src/features/external-calendar/server/account-deletion.ts',
  // rotation を誤ると唯一の refresh token が失効し、以後そのアカウントの sync が復旧できない（#2503 監査）。
  'apps/product/src/features/external-calendar/server/token-rotation.ts',
  // provider 側の revoke は一方向操作で、実行してしまえば取り消せない（#2503 監査）。
  'apps/product/src/features/external-calendar/server/revoke-outbox.ts',
  // timeblock feature の server 側だけに同居する高リスク面（#2489 クロスレビュー P1）。
  // feature 全体は必須側から外したが、この 2 つは「外部契約 or 不可逆」に該当するため
  // 残す: mcp-* は MCP の公開契約 + service role（RLS を迂回する）クエリ、
  // private-timeblock-search-query.ts は検索語を Sentry から隔離する privacy 境界。
  'apps/product/src/features/timeblock/server/mcp-*',
  'apps/product/src/features/timeblock/server/private-timeblock-search-query.ts',
  // system API
  'apps/product/src/app/api/v1/system/**',
  // the guardrails themselves
  '.husky/**',
  '.codex/**',
  '.claude/settings.json',
  // agent adapter は child の権限・scope・credential 境界を固定するため、変更時は
  // 標準 GitHub review の重点確認対象にする。
  'scripts/agent/**',
  'scripts/hooks/**',
  'scripts/tasks/finish-branch.sh',
  'scripts/ci/protected-path-gate.mjs',
  // CI の中枢。check.mjs は write 権限つき GH_TOKEN を PR コードから隔離する
  // 処理とどの test を skip するかの判定を持ち、ci.yml はその job / permissions
  // を決める。どちらも「壊れても CI は green のまま」になりうるため、
  // guardrail の重点確認対象として残す（#2483 の過去レビューで入った境界）。
  'scripts/ci/check.mjs',
  '.github/workflows/ci.yml',
  // Review policy / validation controller。#2794 / #2796 で追加された後発の
  // ガードレールで、判定側と producer を同じ PR で弱めると shadow が偽の green を出す。
  // #2489 の「ガードレール自身」に含めるが、AGENTS.md や一般 skill のような
  // 可逆な agent 向け文書までは保護対象へ広げない。
  'scripts/lib/validation-plan.mjs',
  'scripts/lib/validation-plan.test.ts',
  'scripts/lib/review-policy.mjs',
  'scripts/lib/review-policy.test.ts',
  'scripts/ci/validation-gate.mjs',
  'scripts/ci/validation-gate.test.ts',
  '.github/workflows/validation-gate.yml',
  // promote.yml は production domain を切り替える唯一の経路で、2026-09-03 以降は
  // main merge がそれを自動で起動する（層 3 → smoke → promote → rollback）。
  // gate の `if:` 式を 1 つ緩めるだけで未検証の main が本番へ出るが、その変更は
  // CI では green のまま通り、promote 後の revert では届いてしまったものを
  // 取り戻せない（判定基準「外部契約 or 不可逆」の両方に当たる）。
  // **nightly.yml は含めない** —— 層 3 撤去後は sweep / replica / backup だけで、
  // 「nightly.yml は marker を要求しない」既存契約（finish-branch.test.ts）を
  // 反転させない。
  '.github/workflows/promote.yml',
  // promote.yml は配線にすぎず、「どの suite が要るか」「この SHA を promote するか」
  // の判断はこの 2 つの script が持つ。workflow だけを保護対象にすると、判断側を
  // 触る PR がクロスレビュー無しで通る（例: 影響判定の catch を fail open へ倒す）。
  // production-release.mjs は元から保護対象外だったが、2026-09-03 の merge 連動化で
  // 「人が dispatch した時だけ動く」から「全 merge で無人実行される」へ変わったため、
  // 判定基準（外部契約 or 不可逆）に実際に該当するようになった。
  'scripts/ci/release-impact.mjs',
  'scripts/ci/production-release.mjs',
  // 上 3 つの guardrail である contract test 自身（#2503 / #2546 と同じ判断）。
  // 同じ PR で保護対象と test を同時に弱められる経路を塞ぐ。
  'scripts/ci/release-workflow-contract.test.ts',
  'scripts/ci/release-impact.test.ts',
  // この2つの drift 検出テスト自身がガードレール（#2503）。削除・skip・
  // 弱体化されても保護対象 path の選定にも他の test にも現れず、将来の glob /
  // privacy 境界の縮退を恒久的に検出できなくなる（Codex 指摘 #2546）。
  'scripts/__tests__/protected-path-gate-contract.test.ts',
  'apps/product/src/features/timeblock/server/private-search-boundary-contract.test.ts',
  ...PRODUCTION_CONFIG_AUDIT_CONTRACT_PATHS,
];

/**
 * Minimal glob matcher with the same semantics as GitHub Actions `paths`:
 * `*` matches within one path segment, `**` matches across segments.
 * Implemented as a single regex replace with a callback so no placeholder
 * token is needed to disambiguate `*` from `**`.
 */
function globToRegExp(glob) {
  const escapedGlob = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const pattern = escapedGlob.replace(/\*\*|\*/g, matchOneOrTwoStars);
  return new RegExp(`^${pattern}$`);
}

function matchOneOrTwoStars(token) {
  if (token === '**') return '.*';
  return '[^/]*';
}

const MATCHERS = PROTECTED_PATH_GLOBS.map((glob) => ({ glob, re: globToRegExp(glob) }));

/**
 * audit contract の判定も **`PROTECTED_PATH_GLOBS` と同じ glob 意味論**で行う。
 *
 * 同じ 4 path のコピーは `paths` filter（glob）・workflow の self-change grep（正規表現）・
 * この定数（`globToRegExp`）と、いずれもパターンとして解釈される。ここだけ完全一致にすると、
 * 将来リストの 1 要素を glob へ畳んだ時（例: 3 つ目の app が増えて
 * `apps/<app>/production-build-gate.mjs` のような形にする）に **他の 3 箇所は動き、契約 test も
 * 通り、この判定だけが永久に false へ落ちて checkpoint がまるごと無効化される**。
 */
const AUDIT_CONTRACT_MATCHERS = PRODUCTION_CONFIG_AUDIT_CONTRACT_PATHS.map((glob) =>
  globToRegExp(glob),
);

/**
 * `auditContract` は「この PR が audit contract そのものを変えたか」。
 *
 * `production-config-audit.yml` の `pull_request_target` は #2571 で `paths` filter を
 * 得たが、workflow が起動しない条件は `paths` の意味論だけではない（Actions の一時
 * Disable、base 側の workflow 定義の破損、`paths` の書き間違い、そして changed files が
 * 3,000 件を超えた時の GitHub 仕様）。`finish-branch.sh` はここの値を見て、contract 変更
 * PR には commit status `Production Config Audit` の success（= trusted dispatch 実行済み）
 * を **workflow が起動したかどうかと無関係に** 要求する。判定不能（変更ファイル一覧を
 * 取得できない）な PR も同様に要求する側へ倒している。
 *
 * @param {string[]} changedFiles
 * @returns {{ required: true, reason: string, auditContract: boolean }
 *   | { required: false, auditContract: boolean }}
 */
export function resolveProtectedPathGate(changedFiles) {
  const files = changedFiles.map((f) => f.trim()).filter(Boolean);

  // rename の旧 path（`previous_filename`）も呼び出し側が渡してくるため、両側が一致する。
  const auditContract = files.some((file) => AUDIT_CONTRACT_MATCHERS.some((re) => re.test(file)));

  for (const file of files) {
    for (const matcher of MATCHERS) {
      if (matcher.re.test(file)) {
        return { required: true, reason: matcher.glob, auditContract };
      }
    }
  }

  return { required: false, auditContract };
}

// --- CLI -------------------------------------------------------------

async function readStdinLines() {
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  return data.split('\n');
}

const isDirectRun = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  const args = process.argv.slice(2);
  const useStdin = args.includes('--stdin');
  const fileArgs = args.filter((a) => !a.startsWith('--'));

  const files = useStdin ? await readStdinLines() : fileArgs;
  const result = resolveProtectedPathGate(files);

  process.stdout.write(`${JSON.stringify(result)}\n`);
}
