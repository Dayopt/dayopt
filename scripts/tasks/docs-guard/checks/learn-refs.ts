/**
 * Check: Dayopt Learning System（docs/learn）の正本の整合
 *
 * docs/learn の各 .md は、説明と図の生成ブロック + 正本の JSON block（learn:journey など）を持つ。
 * ここでは 3 つを検査する:
 *  - 正本の schema と block 間の整合（未定義のサービス・存在しない段を指す失敗など）
 *  - 参照 {path, find}（コードとテスト）が repo に在り、find の文字列を含むこと。行番号は持たない
 *  - 生成ブロックが正本と一致すること（手で書き換えた / 再生成を忘れた）
 * 内容の正しさまでは検査しない（ずれを見つけたら正本の JSON を直す）。
 */

import { existsSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';

import { collectLearnData, listLearnRefs, type LearnRef } from '../../../lib/learn/data.ts';
import { renderLearnDocs } from '../../../lib/learn/render-markdown.ts';
import { colors, ROOT } from '../config.ts';

export interface LearnViolation {
  ref: string;
  reason: string;
}

export function checkLearnRefs(
  refs: readonly { file: string; ref: LearnRef }[],
  root = ROOT,
): LearnViolation[] {
  const violations: LearnViolation[] = [];
  const contents = new Map<string, string>();

  for (const { file, ref } of refs) {
    const label = `${file}: ${ref.path} :: ${ref.find}`;
    const abs = resolve(root, ref.path);
    if (relative(root, abs).startsWith('..')) {
      violations.push({ ref: label, reason: 'repo の外を指している' });
      continue;
    }
    if (!existsSync(abs)) {
      violations.push({ ref: label, reason: 'ファイルが存在しない' });
      continue;
    }
    if (!contents.has(abs)) contents.set(abs, readFileSync(abs, 'utf8'));
    if (!contents.get(abs)?.includes(ref.find)) {
      violations.push({ ref: label, reason: 'find の文字列がファイルに無い' });
    }
  }

  return violations;
}

export async function runLearnRefsCheck(root = ROOT): Promise<LearnViolation[]> {
  if (!existsSync(resolve(root, 'docs/learn'))) return [];
  const result = collectLearnData(root);
  const violations: LearnViolation[] = result.errors.map((reason) => ({
    ref: 'docs/learn',
    reason,
  }));
  violations.push(...checkLearnRefs(listLearnRefs(result), root));
  if (result.errors.length === 0) {
    for (const doc of await renderLearnDocs(root, result)) {
      if (doc.current !== doc.expected) {
        violations.push({
          ref: doc.file,
          reason: '生成ブロックが正本と一致しない。pnpm learn:generate を実行する',
        });
      }
    }
  }
  return violations;
}

export function reportLearnRefsCheck(violations: LearnViolation[]): boolean {
  if (violations.length === 0) {
    console.log(`${colors.green}✓${colors.reset} docs/learn の正本・参照・生成ブロック: 0件`);
    return true;
  }

  console.log(
    `${colors.red}✗${colors.reset} docs/learn の正本・参照・生成ブロック: ${violations.length}件`,
  );
  for (const v of violations) {
    console.log(`  ${colors.yellow}${v.ref}${colors.reset}: ${v.reason}`);
  }
  return false;
}
