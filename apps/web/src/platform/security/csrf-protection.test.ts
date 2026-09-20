/**
 * CSRF の origin allowlist（#2616）。
 *
 * 旧実装は `^https://[a-z0-9-]+-dayopt\.vercel\.app$` で、project 名のアンカーが無いうえに
 * ハイフンを許していた。第三者が `evil-dayopt` という Vercel team slug を取れば
 * `web-<hash>-evil-dayopt.vercel.app` が一致し、他テナントのアプリから CSRF が通る。
 * hash を 9 文字の英数字（Vercel docs 明記、ハイフンなし）に固定すると、一致には slug が
 * ちょうど `dayopt` である必要があり、その経路が閉じる。ここはその幅を固定する。
 */

import { NextRequest } from 'next/server';
import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  env: {
    NODE_ENV: 'production',
    VERCEL_URL: 'web-k94imlgmq-dayopt.vercel.app',
    NEXT_PUBLIC_APP_URL: 'https://app.dayopt.app',
  },
}));

vi.mock('@web/platform/config/env', () => ({ env: mocks.env }));

import { verifyCsrfToken } from './csrf-protection';

function postFrom(origin: string): NextRequest {
  return new NextRequest('https://dayopt.app/api/contact', {
    method: 'POST',
    headers: { origin },
  });
}

describe('verifyCsrfToken: Vercel deployment URL の許可範囲', () => {
  it.each([
    ['product の commit URL', 'https://product-k94imlgmq-dayopt.vercel.app'],
    ['web の commit URL', 'https://web-k94imlgmq-dayopt.vercel.app'],
    ['product の production alias', 'https://product-dayopt.vercel.app'],
    ['web の production alias', 'https://web-dayopt.vercel.app'],
  ])('%s を許可する', (_label, origin) => {
    expect(verifyCsrfToken(postFrom(origin))).toBe(true);
  });

  it.each([
    // 第三者が `-dayopt` で終わる team slug を取った時に生えるホスト。
    ['第三者 team slug の commit URL', 'https://web-k94imlgmq-evil-dayopt.vercel.app'],
    ['第三者 team slug（hash 抜き）', 'https://web-evil-dayopt.vercel.app'],
    ['任意 project 名', 'https://anything-k94imlgmq-dayopt.vercel.app'],
    // branch URL 形は branch 名にハイフンが入るため同じ手口を regex で区別できず、許可しない。
    ['branch URL 形', 'https://web-git-feat-x-dayopt.vercel.app'],
    ['hash が 8 文字', 'https://web-k94imlgm-dayopt.vercel.app'],
    ['hash が 10 文字', 'https://web-k94imlgmqz-dayopt.vercel.app'],
    ['ドット入りのサブドメイン', 'https://web-x.evil-dayopt.vercel.app'],
    ['末尾に追加ラベル', 'https://web-k94imlgmq-dayopt.vercel.app.evil.example'],
    ['接尾辞の偽装', 'https://web-k94imlgmq-dayopt.vercel.appx'],
    ['http へのダウングレード', 'http://web-k94imlgmq-dayopt.vercel.app'],
    ['無関係な vercel.app', 'https://attacker.vercel.app'],
  ])('%s を拒否する', (_label, origin) => {
    expect(verifyCsrfToken(postFrom(origin))).toBe(false);
  });

  // 自分自身宛の POST は regex ではなく VERCEL_URL の完全一致で通る。branch URL 形を
  // allowlist から外しても preview が自分の API を叩けるのはこの経路があるため。
  it('VERCEL_URL 自身は完全一致で許可する', () => {
    expect(verifyCsrfToken(postFrom(`https://${mocks.env.VERCEL_URL}`))).toBe(true);
  });

  it('GET は origin を問わず検証不要', () => {
    const request = new NextRequest('https://dayopt.app/api/contact', {
      method: 'GET',
      headers: { origin: 'https://attacker.example' },
    });

    expect(verifyCsrfToken(request)).toBe(true);
  });
});
