import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Auth send_email hook の Edge Function 設定を固定する。
 *
 * この hook は standardwebhooks の署名を付けて POST されるが JWT は付かない。
 * verify_jwt = true にすると入口で弾かれ、GoTrue 側に
 * `500: Hook requires authorization token` が返り、**認証メールが 1 通も送れない**。
 * 画面には汎用エラーしか出ず、Auth ログを見るまで原因が分からないため、
 * 設定だけを頼りにせずテストで固定する（2026-07-27 に本番で発生）。
 */
const configPath = resolve(import.meta.dirname, '../supabase/config.toml');

/**
 * 対象 function ブロックの「設定行だけ」を返す。
 * コメント行を残すと、説明文中の `verify_jwt = true` のような記述を
 * 実設定と誤認してしまうため落とす。
 */
function readFunctionBlock(slug: string): string {
  const config = readFileSync(configPath, 'utf8');
  const start = config.indexOf(`[functions.${slug}]`);
  if (start === -1) {
    throw new Error(`[functions.${slug}] が config.toml に宣言されていません`);
  }
  const rest = config.slice(start + 1);
  const nextSection = rest.indexOf('\n[');
  const block =
    nextSection === -1 ? config.slice(start) : config.slice(start, start + 1 + nextSection);

  return block
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');
}

function readConfigBlock(section: string): string {
  const config = readFileSync(configPath, 'utf8');
  const start = config.indexOf(`[${section}]`);
  if (start === -1) {
    throw new Error(`[${section}] が config.toml に宣言されていません`);
  }
  const rest = config.slice(start + 1);
  const nextSection = rest.indexOf('\n[');
  return nextSection === -1 ? config.slice(start) : config.slice(start, start + 1 + nextSection);
}

describe('supabase/config.toml の send-auth-email', () => {
  it('自動デプロイ対象として宣言されている', () => {
    // 宣言が無いと Preview / production へ配布されず、変更をマージしても本番に届かない
    const block = readFunctionBlock('send-auth-email');
    expect(block).toMatch(/enabled\s*=\s*true/);
  });

  it('verify_jwt が false（Auth hook は JWT を付けないため）', () => {
    const block = readFunctionBlock('send-auth-email');
    expect(block).toMatch(/verify_jwt\s*=\s*false/);
    expect(block).not.toMatch(/verify_jwt\s*=\s*true/);
  });

  it('From の fallback が apex dayopt.app（send.dayopt.app は From に使えない）', () => {
    // 2026-07-21 incident: send.dayopt.app は Return-Path 用 DNS subdomain で、
    // Resend の検証済み From domain ではない（403 になる）。apps 側には同じ回帰テストが
    // あるが Edge Function は網の外だったため、ここで固定する
    const indexPath = resolve(
      import.meta.dirname,
      '../supabase/functions/send-auth-email/index.ts',
    );
    const source = readFileSync(indexPath, 'utf8');
    expect(source).not.toContain("send.dayopt.app'");
    expect(source).toMatch(/RESEND_FROM_EMAIL'\)\s*\|\|\s*'[a-z-]+@dayopt\.app'/);
  });

  it('import map が実在する共有 deno.json を指している', () => {
    const block = readFunctionBlock('send-auth-email');
    const match = block.match(/import_map\s*=\s*"([^"]+)"/);
    expect(match).not.toBeNull();

    const importMapPath = resolve(import.meta.dirname, '../supabase', match![1]!);
    expect(() => readFileSync(importMapPath, 'utf8')).not.toThrow();
  });
});

describe('supabase/config.toml の password changed notification', () => {
  it('Auth event 起点の通知が有効', () => {
    const block = readConfigBlock('auth.email.notification.password_changed');
    expect(block).toMatch(/enabled\s*=\s*true/);
  });
});
