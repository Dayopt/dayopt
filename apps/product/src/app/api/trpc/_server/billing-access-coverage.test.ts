import { describe, expect, it } from 'vitest';

import { appRouter } from '@/app/api/trpc/_server/app-router';
import { requiresProductAccess } from '@/lib/billing/operation-access';

/**
 * 利用期間の終了後に「何が許可され、何が拒否されるか」を、実 appRouter の全 procedure から
 * 導出して固定する（#2629）。
 *
 * `operation-access.test.ts` は `requiresProductAccess` へ手書きの path 文字列を渡す表であり、
 * **その path が実在するか**も、**router 全体がどちらへ倒れるか**も見ていない。そのため次の
 * 2 つが緑のまま抜ける:
 *
 * 1. allowlist に載っている mutation を rename / 削除すると、allowlist 側が dead entry になり、
 *    終了後ユーザーのアカウント削除・請求管理・再契約が黙って FORBIDDEN になる。救済経路が
 *    閉じるという、この機能で最も高くつく壊れ方。
 * 2. 逆に新しい mutation を allowlist へ足した時、それが本当に「終了後も許可してよい操作」
 *    なのかを誰も再確認しない。
 *
 * 点（path 1 本）ではなく class を閉じる: 実 router の leaf procedure 全件を
 * `requiresProductAccess` に通し、**終了後も通る集合そのもの**を固定する。新しい mutation は
 * deny-by-default（`operation-access.ts`）なので、許可側が動く変更だけがこのテストの差分として
 * 現れ、rename は集合から消える形で検出される。
 *
 * router tree の歩き方は `write-fence-coverage.test.ts` と同じ idiom
 * （`_def.procedure === true` で leaf 判定し、それ以外はネストされた router record として再帰）。
 * **type で絞り込まない** のも同じ理由で、将来 `.subscription()` が増えても網から外れない。
 */

interface ProcedureDef {
  type: string;
}

function isProcedure(value: unknown): value is { _def: ProcedureDef } {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return false;
  const def = (value as Record<string, unknown>)._def;
  if (!def || typeof def !== 'object') return false;
  return (def as Record<string, unknown>).procedure === true;
}

function collectProcedures(
  record: Record<string, unknown>,
  parentPath: string[] = [],
): { path: string; type: string }[] {
  const results: { path: string; type: string }[] = [];

  for (const [key, value] of Object.entries(record)) {
    const currentPath = [...parentPath, key];

    if (isProcedure(value)) {
      results.push({ path: currentPath.join('.'), type: value._def.type });
    } else if (value !== null && typeof value === 'object') {
      results.push(...collectProcedures(value as Record<string, unknown>, currentPath));
    }
  }

  return results;
}

const procedures = collectProcedures(appRouter._def.record);
const mutations = procedures.filter((procedure) => procedure.type === 'mutation');
const queries = procedures.filter((procedure) => procedure.type === 'query');

function allowedAfterEnd(candidates: { path: string; type: string }[]): string[] {
  return candidates
    .filter((procedure) => !requiresProductAccess(procedure.path, procedure.type, false))
    .map((procedure) => procedure.path)
    .sort();
}

/**
 * 利用期間の終了後（体験消費済み・未契約）でも session から実行できる mutation の全量。
 *
 * 増減には根拠が要る。許可してよいのは #2614 の状態×操作表にある「閲覧・export・削除・
 * 請求管理・再契約」と、アカウントを安全に保ち続けるための最小限の操作だけ。
 */
const MUTATIONS_ALLOWED_AFTER_END = [
  'activities.deleteActivity',
  'activities.deleteCategory',
  'billing.createCheckoutSession',
  'billing.createPortalSession',
  'billing.startTrial',
  'contact.submit',
  'email.sendPasswordChanged',
  'externalCalendar.disconnect',
  'mcpConnections.revoke',
  'planCommands.delete',
  'planTemplates.delete',
  'recordCommands.delete',
  'review.trackOpened',
  'user.deleteAccount',
  'user.deleteAllData',
  'user.deleteBlocks',
  'user.requestEmailChange',
  'user.verifyRecoveryCode',
  'userSettings.regenerateICalToken',
  'userSettings.update',
  'userSettings.updateProfile',
];

/**
 * #2614 が名前で挙げている救済経路。rename されたら許可集合から静かに消えるため、
 * type を問わず「実在し、終了後も到達できる」ことを別途 path で固定する。
 */
const RESCUE_PATHS = [
  'user.exportData', // GDPR エクスポート（query）
  'user.deleteAccount',
  'user.deleteAllData',
  'billing.createCheckoutSession', // 再契約
  'billing.createPortalSession', // 請求管理
  'plans.list', // 保存済み予定の閲覧
  'records.list',
  'review.getReportPeriod',
];

describe('利用期間終了後の許可・拒否を実 router 全件で固定する', () => {
  it('終了後も通る mutation は管理・削除・請求・アカウント安全の操作だけである', () => {
    expect(allowedAfterEnd(mutations)).toEqual(MUTATIONS_ALLOWED_AFTER_END);
  });

  it('それ以外の mutation は終了後すべて拒否される（deny-by-default が効いている）', () => {
    const denied = mutations
      .filter((procedure) => requiresProductAccess(procedure.path, procedure.type, false))
      .map((procedure) => procedure.path);

    expect(denied.length).toBeGreaterThan(0);
    expect(denied.filter((path) => MUTATIONS_ALLOWED_AFTER_END.includes(path))).toEqual([]);
  });

  it('保存済みデータの query は終了後も読める（外部 provider への問い合わせだけ拒否）', () => {
    const blocked = queries
      .filter((procedure) => requiresProductAccess(procedure.path, procedure.type, false))
      .map((procedure) => procedure.path)
      .sort();

    expect(blocked).toEqual(['externalCalendar.listProviderCalendars']);
  });

  it('MCP（OAuth）は read も write も利用権を要求する', () => {
    const reachable = procedures.filter(
      (procedure) => !requiresProductAccess(procedure.path, procedure.type, true),
    );

    expect(reachable.map((procedure) => `${procedure.type}:${procedure.path}`)).toEqual([]);
  });

  it('救済経路は実在し、終了後も到達できる（rename で静かに閉じない）', () => {
    const byPath = new Map(procedures.map((procedure) => [procedure.path, procedure.type]));

    expect(RESCUE_PATHS.filter((path) => !byPath.has(path))).toEqual([]);
    expect(
      RESCUE_PATHS.filter((path) => requiresProductAccess(path, byPath.get(path)!, false)),
    ).toEqual([]);
  });

  it('空振り検出: mutation と query がどちらも収集できている', () => {
    expect(mutations.length).toBeGreaterThan(0);
    expect(queries.length).toBeGreaterThan(0);
    expect(procedures.length).toBe(mutations.length + queries.length);
  });
});
