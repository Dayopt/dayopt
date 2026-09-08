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

import type { EmailData, WebhookPayload } from '../_shared/types.ts';

import { buildConfirmUrl as buildAuthConfirmUrl } from './confirm-url.ts';
import { ConfirmEmail } from './ConfirmEmail.tsx';
import { EmailChangeEmail } from './EmailChangeEmail.tsx';
import { MagicLinkEmail } from './MagicLinkEmail.tsx';
import { PasswordResetEmail } from './PasswordResetEmail.tsx';
import { authEmailSubjects } from './subjects.ts';

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
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

  if (!supabaseUrl || !serviceRoleKey) return 'en';

  try {
    const supabase = createClient(supabaseUrl, serviceRoleKey);
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
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response('not allowed', { status: 400 });
  }

  const payload = await req.text();
  const headers = Object.fromEntries(req.headers);
  const wh = new Webhook(hookSecret);

  try {
    const { user, email_data } = wh.verify(payload, headers) as WebhookPayload;

    const userName = user.user_metadata.full_name || 'there';
    const confirmUrl = buildConfirmUrl(email_data);
    const locale = await getUserLocale(user.id);
    const subjects = authEmailSubjects[locale];

    const emails: OutgoingEmail[] = [];

    switch (email_data.email_action_type) {
      case 'signup': {
        emails.push({
          to: user.email,
          subject: subjects.signup,
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
        emails.push({
          to: user.email,
          subject: subjects.recovery,
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
        emails.push({
          to: user.email,
          subject: subjects.magic_link,
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

    for (const { to, subject, element } of emails) {
      const html = await renderAsync(element);

      const { error } = await resend.emails.send({
        from: `Dayopt <${FROM_EMAIL}>`,
        to: [to],
        subject,
        html,
      });

      if (error) {
        // 部分失敗（email_change の 2 通目など）を切り分けられるよう、宛先を含めず記録する
        console.error('[send-auth-email] send failed', {
          action: email_data.email_action_type,
          subject,
        });
        throw error;
      }
    }
  } catch (error) {
    // catch 変数は unknown。auth hook のエラー契約（http_code / message）に
    // 載せる 2 プロパティだけを取り出す
    const { code, message } = error as { code?: number; message?: string };
    return new Response(
      JSON.stringify({
        error: {
          http_code: code,
          message,
        },
      }),
      {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  }

  return new Response(JSON.stringify({}), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
});
