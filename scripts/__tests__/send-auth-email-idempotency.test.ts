/**
 * `send-auth-email` の idempotency key 生成（#2803）。
 *
 * GoTrue は 503 / 429 で最大 3 回まで同じ hook を呼び直すため、Resend への送信が成功した
 * 後にこちらが失敗応答を返すと同じメールが二重配送される。key の性質はここで固定する。
 *
 * 実体は `supabase/functions/send-auth-email/idempotency.ts`。`index.ts` は module scope で
 * `Deno.env.get` を呼ぶため import できないので、純関数だけを分離してここから検証する
 * （先例は `send-auth-email-confirm-url.test.ts`）。
 */

import { describe, expect, it } from 'vitest';

import {
  buildAuthEmailIdempotencyKey,
  resolveWebhookEventId,
} from '../../supabase/functions/send-auth-email/idempotency.ts';

const EVENT_ID = 'msg_2abcDEF456ghiJKL789mno';

function key(overrides: Parameters<typeof buildAuthEmailIdempotencyKey>[0]) {
  return buildAuthEmailIdempotencyKey(overrides);
}

describe('resolveWebhookEventId', () => {
  it('webhook-id header を取り出す', () => {
    expect(resolveWebhookEventId({ 'webhook-id': EVENT_ID })).toBe(EVENT_ID);
  });

  it('header 名の大文字小文字を問わない', () => {
    expect(resolveWebhookEventId({ 'Webhook-Id': EVENT_ID })).toBe(EVENT_ID);
  });

  it('前後の空白を落とす', () => {
    expect(resolveWebhookEventId({ 'webhook-id': `  ${EVENT_ID}  ` })).toBe(EVENT_ID);
  });

  // 乱数へフォールバックしないことが重要。毎回違う key は idempotency として無意味なうえ、
  // 「冪等になったつもり」で 503→500 の降格を外すとかえって二重配送が増える。
  it.each([
    ['header ごと欠落', {}],
    ['空文字', { 'webhook-id': '' }],
    ['空白のみ', { 'webhook-id': '   ' }],
    ['別 header だけ', { 'webhook-timestamp': '1700000000' }],
  ])('%s なら undefined を返す', (_label, headers) => {
    expect(resolveWebhookEventId(headers as Record<string, string>)).toBeUndefined();
  });
});

describe('buildAuthEmailIdempotencyKey', () => {
  it('同じ webhook-id の再試行では同じ key になる（重複配送しない）', () => {
    const first = key({ eventId: EVENT_ID, emailActionType: 'recovery', recipientRole: 'single' });
    const retry = key({ eventId: EVENT_ID, emailActionType: 'recovery', recipientRole: 'single' });

    expect(first).toBeDefined();
    expect(retry).toBe(first);
  });

  it('別の webhook-id なら別 key になる（後日の正当な 2 回目を潰さない）', () => {
    const first = key({ eventId: EVENT_ID, emailActionType: 'recovery', recipientRole: 'single' });
    const later = key({
      eventId: 'msg_different',
      emailActionType: 'recovery',
      recipientRole: 'single',
    });

    expect(later).not.toBe(first);
  });

  it('同じ配送でも action が違えば別 key になる', () => {
    const signup = key({ eventId: EVENT_ID, emailActionType: 'signup', recipientRole: 'single' });
    const recovery = key({
      eventId: EVENT_ID,
      emailActionType: 'recovery',
      recipientRole: 'single',
    });

    expect(signup).not.toBe(recovery);
  });

  it('password changed event は同じ event だけを重複抑止する', () => {
    const first = key({
      eventId: EVENT_ID,
      emailActionType: 'password_changed_notification',
      recipientRole: 'single',
    });
    const retry = key({
      eventId: EVENT_ID,
      emailActionType: 'password_changed_notification',
      recipientRole: 'single',
    });
    const laterChange = key({
      eventId: 'msg_later_password_change',
      emailActionType: 'password_changed_notification',
      recipientRole: 'single',
    });

    expect(first).toBeDefined();
    expect(retry).toBe(first);
    expect(laterChange).not.toBe(first);
  });

  // email_change は現アドレス宛と新アドレス宛の 2 通を同じ webhook 配送で送る。
  // 同じ key だと 2 通目が 1 通目のキャッシュに当たり、新アドレスへ届かない。
  it('email_change の 2 通は相互に抑止しない', () => {
    const current = key({
      eventId: EVENT_ID,
      emailActionType: 'email_change',
      recipientRole: 'current',
    });
    const next = key({
      eventId: EVENT_ID,
      emailActionType: 'email_change',
      recipientRole: 'new',
    });

    expect(current).toBeDefined();
    expect(next).toBeDefined();
    expect(current).not.toBe(next);
  });

  it('webhook-id が無ければ key を作らない', () => {
    expect(
      key({ eventId: undefined, emailActionType: 'signup', recipientRole: 'single' }),
    ).toBeUndefined();
  });

  // Resend の上限。切り詰めると別イベント同士が同じ key へ潰れうるので、短くせず諦める。
  it('256 文字を超える場合は key を作らない', () => {
    expect(
      key({ eventId: 'x'.repeat(300), emailActionType: 'signup', recipientRole: 'single' }),
    ).toBeUndefined();
  });

  it('256 文字ちょうどは受け入れる', () => {
    // `auth/` + eventId + `/signup/single`
    const fixedLength = 'auth/'.length + '/signup/single'.length;
    const generated = key({
      eventId: 'x'.repeat(256 - fixedLength),
      emailActionType: 'signup',
      recipientRole: 'single',
    });

    expect(generated).toHaveLength(256);
  });

  // key は Resend 側に保存され、こちらの log にも載りうる。識別子だけで構成する。
  it('email / token / token_hash / 本文を含まない', () => {
    const generated = key({
      eventId: EVENT_ID,
      emailActionType: 'email_change',
      recipientRole: 'new',
    });

    expect(generated).toBe(`auth/${EVENT_ID}/email_change/new`);
    expect(generated).not.toContain('@');
    for (const secret of ['hash-current', 'hash-new', '123456', 'user@example.com']) {
      expect(generated).not.toContain(secret);
    }
  });
});
