#!/usr/bin/env node
/**
 * docs-guard（orchestrator）
 *
 * docs/ の機械的ガードを4 checker で実行する。
 *  - link-check              : 相対リンク切れ
 *  - frontmatter-check       : path別metadata / code path / stock lifecycle
 *  - naming-check            : kebab-case 命名規約
 *  - decisions-append-only   : docs/decisions.md の append-only 契約
 *  - glossary-sync           : 用語集の生成ブロックが terms.ts と一致するか
 *
 * 各ドメイン log/ の凍結契約チェック（append-only-guard）は、domain log/ 全廃
 * （2026-08-28、#2475）に伴い撤去した。
 *
 * Usage:
 *   tsx scripts/tasks/docs-guard/index.ts
 *
 * ローカルでは `pnpm docs:check` からも同じスクリプトが実行される。
 */

import {
  reportDecisionsAppendOnlyGuard,
  runDecisionsAppendOnlyGuard,
} from './checks/decisions-append-only.ts';
import { reportFrontmatterCheck, runFrontmatterCheck } from './checks/frontmatter-check.ts';
import { reportGlossarySyncCheck, runGlossarySyncCheck } from './checks/glossary-sync.ts';
import { reportLinkCheck, runLinkCheck } from './checks/link-check.ts';
import { reportNamingCheck, runNamingCheck } from './checks/naming-check.ts';
import { colors } from './config.ts';

async function main(): Promise<void> {
  console.log(`${colors.cyan}docs-guard${colors.reset}`);
  console.log('===========\n');

  const linkViolations = await runLinkCheck();
  const linkOk = reportLinkCheck(linkViolations);

  const frontmatterViolations = await runFrontmatterCheck();
  const frontmatterOk = reportFrontmatterCheck(frontmatterViolations);

  const namingViolations = await runNamingCheck();
  const namingOk = reportNamingCheck(namingViolations);

  const decisionsAppendOnlyViolations = runDecisionsAppendOnlyGuard();
  const decisionsAppendOnlyOk = reportDecisionsAppendOnlyGuard(decisionsAppendOnlyViolations);

  const glossarySyncViolations = await runGlossarySyncCheck();
  const glossarySyncOk = reportGlossarySyncCheck(glossarySyncViolations);

  console.log('\n' + '='.repeat(60));

  const ok = linkOk && frontmatterOk && namingOk && decisionsAppendOnlyOk && glossarySyncOk;

  if (ok) {
    console.log(`${colors.green}✅ docs-guard: 全チェック pass${colors.reset}`);
    process.exit(0);
  } else {
    console.log(`${colors.red}❌ docs-guard: 違反あり${colors.reset}`);
    process.exit(1);
  }
}

main().catch((error: Error) => {
  console.error(`${colors.red}Error:${colors.reset}`, error.message);
  process.exit(1);
});
