/**
 * Check: 経路ウォークスルーの参照切れ
 *
 * docs/engineering/walkthrough.html は操作の経路と失敗時の挙動を実コード・運用文書へ結びつける教材。
 * HTML は他の checker（`**\/*.md` のみ）から見えないため、埋め込み JSON の refs（{path, find}）が
 * 「repo に在り、find の文字列を含む」ことをここで検査する。行番号は持たせていない。
 * 内容の正しさまでは検査しない（ずれを見つけたら HTML を直す）。
 */

import { existsSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { colors, DOCS_DIR, ROOT } from '../config.ts';

export const WALKTHROUGH_FILE = resolve(DOCS_DIR, 'engineering/walkthrough.html');

const DATA_RE = /<script type="application\/json" id="walkthrough-data">([\s\S]*?)<\/script>/;

export interface WalkthroughRef {
  path: string;
  find: string;
}

export interface WalkthroughRefViolation {
  ref: string;
  reason: string;
}

export function extractWalkthroughRefs(html: string): WalkthroughRef[] {
  const match = DATA_RE.exec(html);
  if (!match?.[1]) throw new Error('walkthrough-data の JSON ブロックが見つからない');

  const refs: WalkthroughRef[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (!node || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node)) {
      if (key === 'refs' && Array.isArray(value)) {
        for (const ref of value) {
          if (ref && typeof ref.path === 'string' && typeof ref.find === 'string') {
            refs.push({ path: ref.path, find: ref.find });
          } else {
            refs.push({ path: String(ref?.path ?? ''), find: '' });
          }
        }
      } else {
        visit(value);
      }
    }
  };
  visit(JSON.parse(match[1]));
  return refs;
}

export function checkWalkthroughRefs(
  refs: WalkthroughRef[],
  root = ROOT,
): WalkthroughRefViolation[] {
  const violations: WalkthroughRefViolation[] = [];
  const contents = new Map<string, string>();

  for (const { path, find } of refs) {
    const label = `${path} :: ${find}`;
    const abs = resolve(root, path);
    if (!path || !find) {
      violations.push({ ref: label, reason: 'path と find の両方が必要' });
      continue;
    }
    if (relative(root, abs).startsWith('..')) {
      violations.push({ ref: label, reason: 'repo の外を指している' });
      continue;
    }
    if (!existsSync(abs)) {
      violations.push({ ref: label, reason: 'ファイルが存在しない' });
      continue;
    }
    if (!contents.has(abs)) contents.set(abs, readFileSync(abs, 'utf8'));
    if (!contents.get(abs)?.includes(find)) {
      violations.push({ ref: label, reason: 'find の文字列がファイルに無い' });
    }
  }

  return violations;
}

export function runWalkthroughRefsCheck(): WalkthroughRefViolation[] {
  if (!existsSync(WALKTHROUGH_FILE)) return [];
  try {
    return checkWalkthroughRefs(extractWalkthroughRefs(readFileSync(WALKTHROUGH_FILE, 'utf8')));
  } catch (error) {
    return [{ ref: 'docs/engineering/walkthrough.html', reason: String(error) }];
  }
}

export function reportWalkthroughRefsCheck(violations: WalkthroughRefViolation[]): boolean {
  if (violations.length === 0) {
    console.log(`${colors.green}✓${colors.reset} 経路ウォークスルーの参照: 0件`);
    return true;
  }

  console.log(`${colors.red}✗${colors.reset} 経路ウォークスルーの参照: ${violations.length}件`);
  for (const v of violations) {
    console.log(`  ${colors.yellow}${v.ref}${colors.reset}: ${v.reason}`);
  }
  return false;
}
