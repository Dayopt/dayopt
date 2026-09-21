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
 *  - architecture-map        : Architecture Map の生成ブロック drift と参照切れ
 *  - learn-refs              : docs/learn の正本 schema・参照（path + find）の実在・生成ブロックの drift
 *  - likec4-validate         : LikeC4 model の構文（生成器か .c4 が変わった時だけ / advisory）
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
  reportArchitectureMapCheck,
  runArchitectureMapCheck,
} from './checks/architecture-map-sync.ts';
import {
  reportDecisionsAppendOnlyGuard,
  runDecisionsAppendOnlyGuard,
} from './checks/decisions-append-only.ts';
import { reportFrontmatterCheck, runFrontmatterCheck } from './checks/frontmatter-check.ts';
import { reportGlossarySyncCheck, runGlossarySyncCheck } from './checks/glossary-sync.ts';
import { reportLearnRefsCheck, runLearnRefsCheck } from './checks/learn-refs.ts';
import { reportLikeC4ValidateCheck, runLikeC4ValidateCheck } from './checks/likec4-validate.ts';
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

  const architectureMapViolations = await runArchitectureMapCheck();
  const architectureMapOk = reportArchitectureMapCheck(architectureMapViolations);

  const learnRefsOk = reportLearnRefsCheck(await runLearnRefsCheck());

  // advisory（常に true）。生成器か .c4 が変わった PR でだけ likec4 を取ってきて構文検査する。
  const likec4Ok = reportLikeC4ValidateCheck(runLikeC4ValidateCheck());

  console.log('\n' + '='.repeat(60));

  const ok =
    linkOk &&
    frontmatterOk &&
    namingOk &&
    decisionsAppendOnlyOk &&
    glossarySyncOk &&
    architectureMapOk &&
    learnRefsOk &&
    likec4Ok;

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
