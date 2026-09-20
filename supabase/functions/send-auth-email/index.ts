/**
 * Supabase Edge Function: Custom Auth Emails with Resend + React Email
 *
 * Supabase Auth Hook (send_email) 経由で呼び出され、
 * React Email テンプレートを renderAsync でHTML化し、Resend で送信。
 *
 * @see https://supabase.com/docs/guides/functions/examples/auth-send-email-hook-react-email-resend
 */

import { renderAsync } from '@react-email/components';
import { createClient } from '@supabase/supabase-js';
import React from 'react';
import { Resend } from 'resend';
import { Webhook } from 'standardwebhooks';

import { captureEdgeFunctionEvent } from '../_shared/sentry.ts';
import type { EmailData, WebhookPayload } from '../_shared/types.ts';

import { buildConfirmUrl as buildAuthConfirmUrl } from './confirm-url.ts';
import { ConfirmEmail } from './ConfirmEmail.tsx';
import { EmailChangeEmail } from './EmailChangeEmail.tsx';
import {
  classifySendAuthEmailFailure,
  resolveSendAuthEmailStatus,
  type SendAuthEmailFailurePhase,
} from './failure.ts';
import {
  type AuthEmailRecipientRole,
  buildAuthEmailIdempotencyKey,
  resolveWebhookEventId,
} from './idempotency.ts';
import { MagicLinkEmail } from './MagicLinkEmail.tsx';
import { resolvePasswordChangedNotificationEmails } from './password-changed-notification.ts';
import { PasswordChangedEmail } from './PasswordChangedEmail.tsx';
import { PasswordResetEmail } from './PasswordResetEmail.tsx';
import { authEmailSubjects } from './subjects.ts';
import { resolveAuthEmailSecretKey } from './supabase-key.ts';

const resend = new Resend(Deno.env.get('RESEND_API_KEY') as string);
const hookSecret = (Deno.env.get('SEND_EMAIL_HOOK_SECRET') as string).replace('v1,whsec_', '');
// From は apex dayopt.app のみ（2026-07-21 incident で確定。send.dayopt.app は
// Return-Path 用 DNS で、Resend の検証済み From domain ではなく 403 になる）
const FROM_EMAIL = Deno.env.get('RESEND_FROM_EMAIL') || 'noreply@dayopt.app';
const APP_URL = Deno.env.get('NEXT_PUBLIC_APP_URL') || 'https://app.dayopt.app';

type Locale = 'en' | 'ja';

/**
 * user_settings から preferred_locale を取得する
 * 取得できない場合は 'en' にフォールバック
 */
async function getUserLocale(userId: string): Promise<Locale> {
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  if (!supabaseUrl) return 'en';
  const secretKey = resolveAuthEmailSecretKey({
    supabaseUrl,
    secretKey: Deno.env.get('SUPABASE_SECRET_KEY'),
    secretKeys: Deno.env.get('SUPABASE_SECRET_KEYS'),
    localServiceRoleKey: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
  });

  if (!secretKey) return 'en';

  try {
    const supabase = createClient(supabaseUrl, secretKey);
    const { data } = await supabase
      .from('user_settings')
      .select('preferred_locale')
      .eq('user_id', userId)
      .single();

    const locale = (data as Record<string, unknown> | null)?.preferred_locale;
    if (locale === 'ja') return 'ja';
    return 'en';
  } catch {
    return 'en';
  }
}

/**
 * 確認 URL の組み立ては `./confirm-url.ts`（Deno API 非依存の純関数）へ寄せてある。
 * origin の allowlist 検証を含み、Node 側の vitest から直接テストできる（#2616）。
 */
function buildConfirmUrl(emailData: EmailData, tokenHash?: string): string {
  return buildAuthConfirmUrl({ emailData, appUrl: APP_URL, tokenHash });
}

interface OutgoingEmail {
  to: string;
  subject: string;
  element: React.ReactElement;
  /** idempotency key の末尾。同じ webhook 配送に属する 2 通を区別する（#2803） */
  recipientRole: AuthEmailRecipientRole;
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response('not allowed', { status: 400 });
  }

  const payload = await req.text();
  const headers = Object.fromEntries(req.headers);
  const wh = new Webhook(hookSecret);

  let verified: WebhookPayload;
  try {
    verified = wh.verify(payload, headers) as WebhookPayload;
  } catch (error) {
    // 署名不一致は認証境界の失敗。攻撃者由来のノイズを Sentry Issues に入れないため
    // capture しない（#2616 の allowlist 判定とは別の防御、#2682）。
    const { status, message } = classifySendAuthEmailFailure(error, 'verify');
    return new Response(JSON.stringify({ error: { http_code: status, message } }), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const { user, email_data } = verified;

  // Standard Webhooks の `webhook-id`。retry では同じ値・別イベントでは別の値になるので、
  // そのまま idempotency key の素材にできる（#2803）。欠落時は undefined のまま扱い、
  // 乱数へフォールバックしない。
  const eventId = resolveWebhookEventId(headers);

  // Sentry へ送る context 用。宛先 email・本文・token_hash は含めない。
  let phase: SendAuthEmailFailurePhase = 'render';
  let sentCount = 0;
  let currentSubject = '';
  // 「既に送った分がすべて idempotency key 付きだったか」。`eventId` の有無ではなく実際に
  // 適用できた key を見る（key は 256 文字上限でも作られないため、両者は一致しない）。
  let sentWithoutIdempotencyKey = false;

  try {
    const userName = user.user_metadata.full_name || 'there';
    const locale = await getUserLocale(user.id);
    const subjects = authEmailSubjects[locale];

    const emails: OutgoingEmail[] = [];
    const passwordChangedEmails = resolvePasswordChangedNotificationEmails({
      emailActionType: email_data.email_action_type,
      user,
      locale,
    });

    if (passwordChangedEmails) {
      emails.push(
        ...passwordChangedEmails.map(({ userName: passwordChangedUserName, ...email }) => ({
          ...email,
          element: React.createElement(PasswordChangedEmail, {
            userName: passwordChangedUserName,
            locale,
            appUrl: APP_URL,
          }),
        })),
      );
    } else {
      switch (email_data.email_action_type) {
        case 'signup': {
          const confirmUrl = buildConfirmUrl(email_data);
          emails.push({
            to: user.email,
            subject: subjects.signup,
            recipientRole: 'single',
            element: React.createElement(ConfirmEmail, {
              userName,
              confirmUrl,
              locale,
              appUrl: APP_URL,
            }),
          });
          break;
        }
        case 'recovery': {
          const confirmUrl = buildConfirmUrl(email_data);
          emails.push({
            to: user.email,
            subject: subjects.recovery,
            recipientRole: 'single',
            element: React.createElement(PasswordResetEmail, {
              userName,
              resetUrl: confirmUrl,
              locale,
              appUrl: APP_URL,
            }),
          });
          break;
        }
        // hook payload の JSON Schema は 'magiclink'、公式サンプルは 'magic_link' 表記。
        // アプリは magic link 未使用だが、どちらが来ても処理できるよう両対応する
        case 'magic_link':
        case 'magiclink': {
          const confirmUrl = buildConfirmUrl(email_data);
          emails.push({
            to: user.email,
            subject: subjects.magic_link,
            recipientRole: 'single',
            element: React.createElement(MagicLinkEmail, {
              loginUrl: confirmUrl,
              locale,
              appUrl: APP_URL,
            }),
          });
          break;
        }
        case 'email_change': {
          const newEmail = user.new_email;
          if (!newEmail) {
            return new Response(
              JSON.stringify({ error: { message: 'email_change payload missing new_email' } }),
              { status: 400, headers: { 'Content-Type': 'application/json' } },
            );
          }
          // Secure Email Change 有効時は 2 通送る。token hash のフィールド名は
          // 後方互換のため逆転している（公式 docs 明記）:
          //   現アドレス宛 → token_hash_new / 新アドレス宛 → token_hash
          if (email_data.token_hash_new) {
            emails.push({
              to: user.email,
              subject: subjects.email_change_current,
              recipientRole: 'current',
              element: React.createElement(EmailChangeEmail, {
                userName,
                confirmUrl: buildConfirmUrl(email_data, email_data.token_hash_new),
                newEmail,
                variant: 'current',
                locale,
              }),
            });
          }
          emails.push({
            to: newEmail,
            subject: subjects.email_change_new,
            recipientRole: 'new',
            element: React.createElement(EmailChangeEmail, {
              userName,
              confirmUrl: buildConfirmUrl(email_data, email_data.token_hash),
              newEmail,
              variant: 'new',
              locale,
            }),
          });
          break;
        }
        default: {
          return new Response(
            JSON.stringify({
              error: {
                message: `Unknown email action type: ${email_data.email_action_type}`,
              },
            }),
            { status: 400, headers: { 'Content-Type': 'application/json' } },
          );
        }
      }
    }

    for (const { to, subject, element, recipientRole } of emails) {
      currentSubject = subject;

      phase = 'render';
      const html = await renderAsync(element);

      phase = 'send';
      // 同じ webhook 配送の再試行では同じ key になり、Resend 側で 24 時間のあいだ
      // 重複配送が抑止される。テンプレートは決定的なので再 render しても payload は
      // 一致し、payload 不一致の 409 を踏まない（#2803）。
      const idempotencyKey = buildAuthEmailIdempotencyKey({
        eventId,
        emailActionType: email_data.email_action_type,
        recipientRole,
      });

      const { error } = await resend.emails.send(
        {
          from: `Dayopt <${FROM_EMAIL}>`,
          to: [to],
          subject,
          html,
        },
        idempotencyKey ? { idempotencyKey } : undefined,
      );

      if (error) {
        // 部分失敗（email_change の 2 通目など）を切り分けられるよう、宛先を含めず記録する
        console.error('[send-auth-email] send failed', {
          action: email_data.email_action_type,
          subject,
        });
        throw error;
      }

      sentCount += 1;
      if (!idempotencyKey) sentWithoutIdempotencyKey = true;
    }
  } catch (error) {
    const classified = classifySendAuthEmailFailure(error, phase);
    const { kind, resendErrorName, message } = classified;
    const firstEmailAlreadySent = sentCount > 0;

    // 部分送信済みなら retryable status を返さない（判定理由は resolveSendAuthEmailStatus）。
    // ただし idempotency key を付けられていれば重複配送が起きないので降格しない。
    const status = resolveSendAuthEmailStatus(classified, {
      firstEmailAlreadySent,
      idempotencyKeyInUse: !sentWithoutIdempotencyKey,
    });

    // 401（署名不一致）は基本的には verify 段階の try/catch が処理するためここには来ないが、
    // 万一 classify が 401 を返しても capture しない（攻撃者由来のノイズを Issues に入れない）
    if (status !== 401) {
      await captureEdgeFunctionEvent(Deno.env.get('SENTRY_DSN'), {
        functionName: 'send-auth-email',
        message: `send-auth-email failed: ${kind}`,
        tags: {
          action: email_data.email_action_type,
          phase,
          kind,
          status: String(status),
          resend_error: resendErrorName ?? 'none',
        },
        extra: {
          subject: currentSubject,
          firstEmailAlreadySent,
          idempotencyKeyInUse: !sentWithoutIdempotencyKey,
        },
      });
    }

    return new Response(
      JSON.stringify({
        error: {
          http_code: status,
          message,
        },
      }),
      {
        status,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  }

  return new Response(JSON.stringify({}), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
});
