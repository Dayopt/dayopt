/**
 * Check: 用語集の生成物 drift
 *
 * `docs/product/glossary.md` の生成ブロックが `scripts/lib/glossary/terms.ts` と
 * 一致しているかを検証する（`pnpm glossary:check` と同じ判定）。
 *
 * docs-guard 側に置くのは、`pnpm check:static`（copy:check / glossary:check を含む
 * lane）が docs-only PR で丸ごと skip される一方、`pnpm docs:check` は常時実行される
 * ため。glossary.md の表だけを手で書き換えた PR を止められるのはこちらだけ。
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { buildGlossaryMarkdown } from '../../generate-glossary.ts';
import { colors, ROOT } from '../config.ts';

const GLOSSARY_PATH = resolve(ROOT, 'docs/product/glossary.md');

export interface GlossarySyncViolation {
  reason: string;
}

export async function runGlossarySyncCheck(): Promise<GlossarySyncViolation[]> {
  let expected: string;
  try {
    expected = await buildGlossaryMarkdown();
  } catch (error) {
    return [{ reason: error instanceof Error ? error.message : String(error) }];
  }

  const actual = readFileSync(GLOSSARY_PATH, 'utf8');
  if (actual.trim() === expected.trim()) return [];

  return [
    {
      reason:
        'docs/product/glossary.md の生成ブロックが scripts/lib/glossary/terms.ts と一致しません。pnpm glossary:generate を実行してください',
    },
  ];
}

export function reportGlossarySyncCheck(violations: GlossarySyncViolation[]): boolean {
  if (violations.length === 0) {
    console.log(`${colors.green}✅ glossary-sync: 用語集は最新${colors.reset}`);
    return true;
  }

  console.log(`${colors.red}❌ glossary-sync: ${violations.length} 件${colors.reset}`);
  for (const violation of violations) {
    console.log(`   ${violation.reason}`);
  }
  return false;
}
