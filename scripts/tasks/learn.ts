#!/usr/bin/env node
/**
 * Dayopt Learning System の入口。
 *
 *   pnpm learn             閲覧のたびに正本から作る対話画面を開く
 *   pnpm learn --no-open   閲覧サーバーを起動し URL を表示する
 *   pnpm learn --snapshot --no-open   明示的に保存記録を書き出す
 *   pnpm learn:generate    docs/learn の各 .md の生成ブロック（図と説明）を書き直す
 *
 * 生成ブロックの drift と参照の実在は `pnpm docs:check`（learn-refs）が検査する。
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readLearnHtml } from '../lib/docs-live/doc-server.ts';
import { isDirectExecution } from '../lib/is-direct-execution.mjs';
import { collectLearnData } from '../lib/learn/data.ts';
import { buildLearnHtml } from '../lib/learn/html.ts';
import { renderLearnDocs } from '../lib/learn/render-markdown.ts';
import { serveDocumentation } from './serve-docs.ts';

export { buildLearnHtml } from '../lib/learn/html.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const TEMPLATE = resolve(ROOT, 'scripts/lib/learn/ui/template.html');
const OUTPUT = resolve(ROOT, '.learn/index.html');

function fail(errors: readonly string[]): never {
  console.error('docs/learn の正本に問題があります:');
  for (const error of errors) console.error(`  - ${error}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  if ([...args].some((arg) => !['--generate', '--snapshot', '--no-open', '--html'].includes(arg)))
    throw new Error('Usage: pnpm learn [--no-open] | [--snapshot --no-open] | --generate');
  if (args.has('--generate') && args.has('--snapshot'))
    throw new Error('生成と保存記録は別々に指定してください');
  if (args.has('--html')) {
    if (args.size !== 1) throw new Error('--html は単独で指定してください');
    process.stdout.write(readLearnHtml(ROOT));
    return;
  }
  if (!args.has('--generate') && !args.has('--snapshot')) {
    await serveDocumentation(ROOT, '/learn', args.has('--no-open'));
    return;
  }
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
  const snapshot = buildLearnHtml(readFileSync(TEMPLATE, 'utf8'), result.data).replace(
    '<body>',
    `<body><aside style="padding:16px;border-bottom:1px solid">保存記録: ${new Date().toISOString()}。現在の正本を読むには pnpm learn を実行してください。</aside>`,
  );
  writeFileSync(OUTPUT, snapshot);
  const journeys = result.data.scenarios.length;
  const fails = result.data.scenarios.reduce(
    (sum, j) => sum + j.hops.reduce((n, hop) => n + hop.fails.length, 0),
    0,
  );
  console.log(`保存記録: .learn/index.html（経路 ${journeys} 本・失敗 ${fails} 種）`);

  if (args.has('--no-open')) return;
  const opener =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
  const opened = spawnSync(opener, [OUTPUT], { stdio: 'ignore' });
  if (opened.status !== 0) console.log(`ブラウザで開いてください: ${OUTPUT}`);
}

if (isDirectExecution(import.meta.url)) {
  void main().catch((error: Error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
