import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  BRAND_DOCUMENT_TARGETS,
  documentSourcePath,
} from '../../../lib/docs-live/brand-document.ts';
import { documentPaths } from '../../../lib/docs-live/catalog.ts';
import {
  checkStoredLiveDocument,
  LIVE_DOCUMENT_VIEWS,
} from '../../../lib/docs-live/live-contract.ts';
import { renderLiveDocument } from '../../../lib/docs-live/render.ts';
import { ROOT } from '../config.ts';

export function runLiveDocsCheckForArgs(args: string[], check = runLiveDocsCheck): boolean {
  if (args.length > 1 || (args[0] !== undefined && args[0] !== '--ci'))
    throw new Error('Usage: pnpm docs:check [--ci]');
  // 環境変数 CI では切り替えない。remote の pre-push は通常の検査を行う。
  if (args[0] === '--ci') return true;
  return check();
}

/** 既存の docs:check に接続。生成物との比較ではなく、参照を現在解決できることを検査する。 */
export function runLiveDocsCheck(root = ROOT): boolean {
  const files = [...new Set([...documentPaths(root), ...Object.keys(LIVE_DOCUMENT_VIEWS)])];
  let ok = true;
  const tracked = execFileSync(
    'git',
    [
      'ls-files',
      '--cached',
      '--',
      ...BRAND_DOCUMENT_TARGETS,
      ...BRAND_DOCUMENT_TARGETS.map((file) => file.replace('README.md', 'dayopt-brand-F.zip')),
    ],
    { cwd: root, encoding: 'utf8' },
  ).trim();
  if (tracked) {
    ok = false;
    console.error(`❌ live-docs: 配布生成物の Git 登録は禁止です: ${tracked}`);
  }
  for (const file of files) {
    const source = documentSourcePath(file);
    try {
      const markdown = readFileSync(resolve(root, source), 'utf8');
      const violations = checkStoredLiveDocument(source, markdown);
      if (violations.length) throw new Error(violations.join('\n'));
      if (markdown.includes('<!-- docs-live:')) renderLiveDocument(root, source);
    } catch (error) {
      ok = false;
      console.error(
        `❌ live-docs: ${file}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (ok) console.log('✅ live-docs: 閲覧時の正本解決に成功');
  return ok;
}
