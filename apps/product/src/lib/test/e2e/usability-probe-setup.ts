#!/usr/bin/env tsx
/**
 * Haiku ユーザビリティプローブ用の認証済み storageState を用意する。
 *
 * 「credential をモデルに触らせない」（#2022）の実装。スローアウェイ test user を
 * service role で作り、このスクリプト自身が headless Playwright でログインフォームへ
 * 入力する。probe agent（Haiku）に渡るのは実セッション（refresh token を含む
 * storageState）そのもので、password ではないというだけの話であることに注意
 * （agent への非露出は `.claude/skills/usability-probe/SKILL.md` §Probe agent へ渡す
 * persona instructions の明示指示が担保する。常設 agent 定義の全廃（2026-08、#2478）
 * 以前は `.claude/agents/usability-probe.md` の tools allowlist による技術的強制
 * だったが、常設定義撤去に伴い prompt 内の明示指示ベースの担保へ後退した。
 * このスクリプトが担保するのは password を書き出さないことだけ）。
 * probe agent は on-demand 登録した専用 Playwright MCP
 * （`--storage-state=<このファイル>`）経由でこの storageState を読み込んだ
 * ブラウザを操作する（agent 自身は storageState ファイルにも触れない）。
 *
 * 実行先の安全性は `service-role-target-guard.ts` にそのまま従う（local のみ既定
 * 許可、非ローカルは `E2E_ALLOW_NONLOCAL_SUPABASE=1` の明示 opt-in が必要、
 * production は opt-in があっても拒否）。`--base-url` にも同型の allowlist 判定
 * （`../usability-probe-guards.ts` の `resolveBaseUrlTarget`）を掛ける。opt-in
 * env は Supabase 側と衝突しないよう `USABILITY_PROBE_ALLOW_NONLOCAL` に分離。
 *
 * Usage:
 *   pnpm --filter @dayopt/product probe:setup
 *   pnpm --filter @dayopt/product probe:setup -- --base-url=http://localhost:3000
 *
 * 前提: 対象アプリが起動していること（ローカルなら `pnpm dev:raw`）。
 *
 * 後始末: 作成した test user は自動で消さない。標準出力に出る email とホストを
 * 見て `USER_EMAIL=<email> bash scripts/runbook/admin-delete-user.sh` で削除する。
 * **`.op-env.human` 経由では実行しない**（`docs/operations/tooling.md` の通り
 * production 専用の env file のため）。local を対象にした本スクリプトの
 * cleanup は `supabase status -o env` の値を `NEXT_PUBLIC_SUPABASE_URL` /
 * `SUPABASE_SECRET_KEY` として渡す。専用の cleanup script は書かない
 * （既存の管理スクリプトを使い回す）。
 *
 * @see docs/product/log — プローブの所見はここに記録される（本スクリプトの管轄外）
 * @see .claude/skills/usability-probe/SKILL.md — このスクリプトを呼ぶオーケストレーション
 */

import { mkdirSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

import { chromium } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';

import type { Database } from '@/lib/database';

import { resolveServiceRoleTarget } from '../service-role-target-guard';
import { resolveBaseUrlTarget } from '../usability-probe-guards';
import { suppressConsentBanner } from './suppress-consent-banner';

const __dirname = dirname(fileURLToPath(import.meta.url));
// __dirname: apps/product/src/lib/test/e2e → 4 階層上で apps/product に戻る
const APP_ROOT = resolve(__dirname, '../../../..');
// storageState の出力先は固定する（可変にすると .probe/ 配下から外れた場所へ
// 生セッションを書き出せてしまう。#2076 クロスレビュー指摘）。
const STORAGE_STATE_PATH = resolve(APP_ROOT, '.probe/storage-state.json');

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SECRET_KEY;

function parseBaseUrl(argv: string[]): string {
  const flag = argv.find((arg) => arg.startsWith('--base-url='));
  return flag ? flag.slice('--base-url='.length) : 'http://localhost:3000';
}

async function main() {
  const target = resolveServiceRoleTarget(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  if (!target.safe) {
    console.error(`[usability-probe-setup] 実行を中止: ${target.reason}`);
    process.exitCode = 1;
    return;
  }

  const baseUrl = parseBaseUrl(process.argv.slice(2));
  const baseUrlTarget = resolveBaseUrlTarget(baseUrl);
  if (!baseUrlTarget.safe) {
    console.error(`[usability-probe-setup] 実行を中止: ${baseUrlTarget.reason}`);
    process.exitCode = 1;
    return;
  }

  const runId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const email = `usability-probe-${runId}@example.com`;
  // probe agent には見せない。このプロセス内でのみ使い、ログイン後は破棄する。
  const password = crypto.randomUUID();

  const adminSupabase = createClient<Database>(SUPABASE_URL!, SUPABASE_SERVICE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { error: authError } = await adminSupabase.auth.admin.createUser({
    id: userId,
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: 'usability probe' },
  });
  if (authError) throw new Error(`test user 作成に失敗: ${authError.message}`);

  // ここで一度出す: この後 browser 操作が失敗しても、cleanup に必要な email が
  // 標準出力に残る（作った test user が身元不明のまま残らないようにする）。
  const cleanupHost = new URL(SUPABASE_URL!).host;
  console.log(`[usability-probe-setup] test user 作成済み（${cleanupHost}）: ${email}`);
  console.log(
    `[usability-probe-setup] cleanup: NEXT_PUBLIC_SUPABASE_URL=${SUPABASE_URL} SUPABASE_SECRET_KEY=<ローカルの値> USER_EMAIL=${email} bash scripts/runbook/admin-delete-user.sh`,
  );

  const { error: profileError } = await adminSupabase.from('profiles').upsert({
    id: userId,
    email,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
  if (profileError) throw new Error(`profile 作成に失敗: ${profileError.message}`);

  const { error: settingsError } = await adminSupabase.from('user_settings').upsert({
    user_id: userId,
    timezone: 'Asia/Tokyo',
    preferred_locale: 'ja',
    default_view: 'day',
    default_duration: 60,
    time_format: '24h',
    week_starts_on: 1,
  });
  if (settingsError) throw new Error(`user_settings 作成に失敗: ${settingsError.message}`);

  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await suppressConsentBanner(page);
    await page.goto(`${baseUrl}/ja/auth/login`);
    await page.locator('input[type="email"], input[name="email"]').first().fill(email);
    await page.locator('input[type="password"]').first().fill(password);
    await page.locator('button[type="submit"]').first().click();
    await page.waitForURL(/\/ja\/calendar/i, { timeout: 15_000 });

    mkdirSync(dirname(STORAGE_STATE_PATH), { recursive: true });
    await context.storageState({ path: STORAGE_STATE_PATH });
  } finally {
    await browser.close();
  }

  // 実行メタデータ（cleanup 用の userId、生成元 runId）を storageState の隣に残す。
  // password は含めない（既にセッション化済みで不要）。
  writeFileSync(
    resolve(dirname(STORAGE_STATE_PATH), 'session-meta.json'),
    JSON.stringify({ runId, userId, email, createdAt: new Date().toISOString() }, null, 2) + '\n',
  );

  console.log(`[usability-probe-setup] storageState: ${STORAGE_STATE_PATH}`);
}

// tsx で直接実行された時だけ main() を走らせる。unit test から import しても
// service role の実操作が走らないようにするためのガード。
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error('[usability-probe-setup] failed:', error);
    process.exitCode = 1;
  });
}
