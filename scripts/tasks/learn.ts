#!/usr/bin/env node
/**
 * Dayopt Learning System の入口。
 *
 *   pnpm learn             docs/learn の正本から対話画面（.learn/index.html）を作って開く
 *   pnpm learn --no-open   作るだけ（CI や確認用）
 *   pnpm learn:generate    docs/learn の各 .md の生成ブロック（図と説明）を書き直す
 *
 * 生成ブロックの drift と参照の実在は `pnpm docs:check`（learn-refs）が検査する。
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isDirectExecution } from '../lib/is-direct-execution.mjs';
import { collectLearnData, type LearnData } from '../lib/learn/data.ts';
import { renderLearnDocs } from '../lib/learn/render-markdown.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const TEMPLATE = resolve(ROOT, 'scripts/lib/learn/ui/template.html');
const OUTPUT = resolve(ROOT, '.learn/index.html');
// prettier が placeholder を別の行へ折っても見つかるよう、前後の空白を許す
const PLACEHOLDER =
  /(<script type="application\/json" id="learn-data">)\s*__LEARN_DATA__\s*(<\/script>)/;

/** data を template の JSON script へ埋め込む。`</script>` で閉じられないよう < を escape する。 */
export function buildLearnHtml(template: string, data: LearnData): string {
  if (!PLACEHOLDER.test(template)) throw new Error('template に learn-data の placeholder が無い');
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  return template.replace(
    PLACEHOLDER,
    (_match, open: string, close: string) => open + json + close,
  );
}

function fail(errors: readonly string[]): never {
  console.error('docs/learn の正本に問題があります:');
  for (const error of errors) console.error(`  - ${error}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const result = collectLearnData(ROOT);
  if (result.errors.length > 0 || !result.data) fail(result.errors);

  if (args.has('--generate')) {
    let changed = 0;
    for (const doc of await renderLearnDocs(ROOT, result)) {
      if (doc.current === doc.expected) continue;
      writeFileSync(resolve(ROOT, doc.file), doc.expected);
      console.log(`更新: ${doc.file}`);
      changed += 1;
    }
    console.log(changed === 0 ? '生成ブロックは最新です' : `${changed} 件を更新しました`);
    return;
  }

  mkdirSync(dirname(OUTPUT), { recursive: true });
  writeFileSync(OUTPUT, buildLearnHtml(readFileSync(TEMPLATE, 'utf8'), result.data));
  const journeys = result.data.scenarios.length;
  const fails = result.data.scenarios.reduce(
    (sum, j) => sum + j.hops.reduce((n, hop) => n + hop.fails.length, 0),
    0,
  );
  console.log(`作成: .learn/index.html（経路 ${journeys} 本・失敗 ${fails} 種）`);

  if (args.has('--no-open')) return;
  const opener =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
  const opened = spawnSync(opener, [OUTPUT], { stdio: 'ignore' });
  if (opened.status !== 0) console.log(`ブラウザで開いてください: ${OUTPUT}`);
}

if (isDirectExecution(import.meta.url)) {
  void main();
}
