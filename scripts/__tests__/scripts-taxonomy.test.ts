import { describe, expect, it } from 'vitest';

import { classifyAllScripts } from '../lib/scripts-taxonomy';

/**
 * scripts/ 呼ばれ方別再編（#2476）の常設 contract test。
 *
 * 無参照 script（誰からも呼ばれていない script）を機械的に検出する。以後、
 * このクラスの棚卸しを人力でやり直さずに済ませるための gate。
 */

// 呼ばれ方別ディレクトリと、そこに置かれるべきカテゴリの対応。
// scripts/lib/scripts-taxonomy.ts の 6 分類（tasks/ci/hooks/agent/runbook/lib）と 1:1。
const CATEGORY_DIR: Record<string, string> = {
  tasks: 'scripts/tasks/',
  ci: 'scripts/ci/',
  hooks: 'scripts/hooks/',
  agent: 'scripts/agent/',
  runbook: 'scripts/runbook/',
  lib: 'scripts/lib/',
};

/**
 * ファイル単位の priority 判定では「配置ズレ」に見えるが、実際は内部結合の
 * 強いディレクトリを主エントリポイントの分類でユニット扱いした意図的な例外。
 * #2476 Phase B/C の issue コメントで都度説明済み（各行にコメントを付す）。
 */
const KNOWN_PLACEMENT_EXCEPTIONS = new Set<string>([
  // boundaries/: check.ts が root package.json "lint:boundaries" を持つ tasks unit。
  // budget.ts / checks/*.ts / config.ts は内部 lib・runbook 判定だが分割しない。
  'scripts/tasks/boundaries/budget.ts',
  'scripts/tasks/boundaries/checks/feature-dag.ts',
  'scripts/tasks/boundaries/checks/import-paths.ts',
  'scripts/tasks/boundaries/checks/package-layers.ts',
  'scripts/tasks/boundaries/checks/public-api-barrels.ts',
  'scripts/tasks/boundaries/config.ts',
  // docs-guard/: index.ts が pkg entry "docs:check" を持つ tasks unit。
  'scripts/tasks/docs-guard/checks/decisions-append-only.ts',
  'scripts/tasks/docs-guard/checks/frontmatter-check.ts',
  'scripts/tasks/docs-guard/checks/glossary-sync.ts',
  'scripts/tasks/docs-guard/checks/link-check.ts',
  'scripts/tasks/docs-guard/checks/naming-check.ts',
  'scripts/tasks/docs-guard/config.ts',
  'scripts/tasks/docs-guard/git-changes.ts',
  // docs-coverage/: index.ts が pkg entry "docs:coverage" を持つ tasks unit。
  'scripts/tasks/docs-coverage/collect.ts',
  // env/: check-*.ts が全て pkg entry を持つ tasks unit。schema.ts はその内部 lib。
  'scripts/tasks/env/schema.ts',
  // admin-*.sh family: admin-common.sh を `dirname "${BASH_SOURCE[0]}"` 相対で
  // source するため、同一ディレクトリに揃える必要がある。admin-delete-user.sh は
  // lane-protocol.md / usability-probe SKILL.md からの言及で agent 判定になるが、
  // family を割らない。
  'scripts/runbook/admin-delete-user.sh',
  // supabase-mgmt-safe-get.mjs: pre-tool-guard-rules.mjs 内の言及は「このscriptを使え」
  // という利用者(agent)向け誘導メッセージであり、フック自身がこのscriptを実行・
  // 照合するわけではない（hook が完全一致で実行照合する allowlist とは性質が違う）。
  // 実利用のされ方は agent 直叩きに近いため agent/ に置く。
  'scripts/agent/supabase-mgmt-safe-get.mjs',
  // storage-objects-app-policy-names.mjs: #2483 以前は integration.yml の
  // paths: トリガー条件への言及があったが、CI ファイル統合で INTEGRATION_GLOBS
  // （impact.mjs、JS 配列）へ一本化され workflow YAML からの言及は無くなった。
  // 実際の呼び出し元は generate-rls-snapshot.ts（tasks）と
  // production-storage-rls-audit.mjs（ci）の import のみで、正しい分類は
  // lib（現状維持。この exception は現状 no-op だが記録として残す）。
  'scripts/lib/storage-objects-app-policy-names.mjs',
  // scripts-taxonomy.ts: 唯一の実 importer が __tests__/ 配下のテストファイルであり、
  // classifyAllScripts の importedBy 判定は __tests__/ を除外した allScriptFiles しか
  // 走査しないため、ライブラリとして実在するにもかかわらず無参照判定になる
  // （#2476 Phase C コメントに既知の設計限界として記録済み）。
  // glossary/: core.ts と terms.ts は check-glossary.ts / generate-glossary.ts から
  // import されるだけの lib だが、docs/product/glossary.md が「正本は terms.ts」と
  // 名指しするため docs 参照が先に当たって runbook 判定になる。この言及は読者への
  // 案内であって実行手順ではない（storage-objects-app-policy-names.mjs と同型）。
  'scripts/lib/glossary/core.ts',
  'scripts/lib/glossary/terms.ts',
  'scripts/lib/scripts-taxonomy.ts',
  // protected-path-gate.mjs: impact.mjs（scripts/ci/、同じ --stdin 呼び出し規約）と
  // 同型で、finish-branch.sh から node 経由で呼ばれる ci unit。skill docs（audit-ai-
  // config / pr-cross-review）からの言及は利用者向けの説明文であり、実行呼び出しでは
  // ないため agent 判定になるが、正しい分類は ci（現状維持、#2478）。
  'scripts/ci/protected-path-gate.mjs',
  // gitleaks-allowlist-canary.sh: #2483 以前は docs-guard.yml の `run:` step
  // （workflow ヒット判定可能）から直接実行されていたが、CI ファイル統合で
  // scripts/ci/check.mjs の `run('bash', [...])` 呼び出しへ移った。この呼び出し
  // 形（JS ヘルパー経由の文字列引数）は本ライブラリの workflow/import 判定
  // どちらにも当たらない検出漏れで、実行自体は無変更のまま継続している
  // （scripts/ci/check.mjs:267）。
  'scripts/ci/gitleaks-allowlist-canary.sh',
  // check-destructive-migration.mjs: scripts/ci/check.mjs（#2483 で新設）が
  // import するため lib 判定になるが、migration safety 検査は CI 専用ロジックで
  // scripts/ci/ の兄弟ファイル（production-*-audit.mjs 等）と同じ結合を持つ。
  // scripts/lib/ へ移すと import 元の相対 path が二重に散らばるため、taxonomy
  // 再編（#2476）の対象外として現状の配置を維持する。
  'scripts/ci/check-destructive-migration.mjs',
  // pre-tool-guard-rules.mjs: pre-tool-guard.mjs（隣接する loader）から
  // `await import('./pre-tool-guard-rules.mjs')` で動的 import される。
  // findImporters の import 検出は `(from|require\() ... ['"]` のみを見ており
  // 引数を伴わない `import(...)` 形は拾えないため無参照判定になる。admin-*.sh
  // family と同型のペア構成（内部結合の強い unit）。loader は settings.json から
  // 参照されるため hooks 判定になり、rules だけがこの例外で hooks/ に揃える。
  'scripts/hooks/pre-tool-guard-rules.mjs',
]);

describe('scripts/ 呼ばれ方別 taxonomy', () => {
  it('無参照 script が存在しない', () => {
    const classified = classifyAllScripts(process.cwd());
    const unreferenced = classified
      .filter((c) => c.category === 'unreferenced')
      .filter((c) => !KNOWN_PLACEMENT_EXCEPTIONS.has(c.path));

    expect(
      unreferenced,
      unreferenced
        .map(
          (c) =>
            `${c.path} — package.json / workflow / husky・claude hooks / claude rules・skills・CLAUDE.md / docs / 他scriptのいずれからも参照されていません`,
        )
        .join('\n'),
    ).toEqual([]);
  });

  it('分類カテゴリと実際の配置ディレクトリが一致する（既知の unit 例外を除く）', () => {
    const classified = classifyAllScripts(process.cwd());
    const mismatched = classified
      .filter((c) => c.category !== 'unreferenced')
      .filter((c) => !KNOWN_PLACEMENT_EXCEPTIONS.has(c.path))
      .filter((c) => {
        const expectedDir = CATEGORY_DIR[c.category];
        return expectedDir && !c.path.startsWith(expectedDir);
      });

    expect(
      mismatched,
      mismatched
        .map((c) => `${c.path} は ${c.category} 判定だが ${CATEGORY_DIR[c.category]} 配下に無い`)
        .join('\n'),
    ).toEqual([]);
  });
});
