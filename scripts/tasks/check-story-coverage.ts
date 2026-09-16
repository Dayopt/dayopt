#!/usr/bin/env node
/**
 * Storybook Story カバレッジチェッカー
 *
 * チェック項目:
 * 1. UI / Common コンポーネントの Story 存在確認
 * 2. AllPatterns Story の存在確認
 * 3. StoryObj<typeof meta> の型安全確認
 * 4. (--collected) Storybook テスト（vitest --project storybook）が Story ファイルを取りこぼしていないか
 *
 * Usage:
 *   npx tsx scripts/tasks/check-story-coverage.ts             # レポート表示
 *   npx tsx scripts/tasks/check-story-coverage.ts --strict    # カバレッジ低下で exit 1
 *   npx tsx scripts/tasks/check-story-coverage.ts --collected # collect 漏れで exit 1（ブラウザ起動を伴い数分かかる）
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { hasExcludedMetaTag } from '../lib/story-test-collection';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '../..');
const APP_ROOT = path.join(ROOT, 'apps/product');
const STORYBOOK_ROOT = path.join(ROOT, 'apps/storybook');

// ─────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────

const SCAN_DIRS = [
  { dir: path.join(APP_ROOT, 'src/lib/components/ui'), label: 'UI Components' },
  { dir: path.join(APP_ROOT, 'src/lib/components/common'), label: 'Common Components' },
];

const isStrict = process.argv.includes('--strict');
const isCollected = process.argv.includes('--collected');

/**
 * `apps/storybook/.storybook/main.ts` の `stories` glob が指す Story ファイルの置き場所。
 * main.ts に root を足したらここにも足す（足し忘れは「期待集合に無いのに collect された」として赤になる）。
 */
const COLLECT_SCAN_ROOTS = [
  path.join(APP_ROOT, 'src'),
  path.join(ROOT, 'apps/web/src'),
  path.join(ROOT, 'packages/foundations/src'),
  path.join(ROOT, 'packages/components/src'),
  path.join(STORYBOOK_ROOT, '.storybook/stories'),
];

/** vitest.config.ts の storybookTest `tags.exclude` と同じ値 */
const EXCLUDED_STORY_TAGS = ['docs-only', 'wip'];

// ─────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────

interface CoverageResult {
  component: string;
  dir: string;
  label: string;
  hasStory: boolean;
}

interface QualityResult {
  file: string;
  hasAllPatterns: boolean;
  hasTypedStoryObj: boolean;
}

// ─────────────────────────────────────────────────────────
// Coverage Check
// ─────────────────────────────────────────────────────────

function getComponentFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter(
      (f) =>
        f.endsWith('.tsx') &&
        !f.endsWith('.stories.tsx') &&
        !f.endsWith('.test.tsx') &&
        f !== 'index.tsx' &&
        f !== 'index.ts' &&
        !f.startsWith('use-'),
    );
}

function checkCoverage(): CoverageResult[] {
  const results: CoverageResult[] = [];

  for (const { dir, label } of SCAN_DIRS) {
    const files = getComponentFiles(dir);
    for (const file of files) {
      const base = file.replace(/\.tsx$/, '');
      const storyFile = path.join(dir, `${base}.stories.tsx`);
      results.push({
        component: file,
        dir,
        label,
        hasStory: fs.existsSync(storyFile),
      });
    }
  }

  return results;
}

// ─────────────────────────────────────────────────────────
// Quality Check
// ─────────────────────────────────────────────────────────

function findAllStoryFiles(dir: string): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== '.next') {
      results.push(...findAllStoryFiles(fullPath));
    } else if (entry.name.endsWith('.stories.tsx')) {
      results.push(fullPath);
    }
  }
  return results;
}

/** AllPatterns / 型チェック対象外のパス（Foundations, Patterns, Docs, Emails） */
const QUALITY_EXCLUDE_PATTERNS = [
  '/styles/tokens/',
  '/stories/patterns/',
  '/stories/docs/',
  '/emails/',
];

function isQualityExcluded(filePath: string): boolean {
  return QUALITY_EXCLUDE_PATTERNS.some((p) => filePath.includes(p));
}

function checkQuality(storyFiles: string[]): QualityResult[] {
  return storyFiles.map((file) => {
    const relPath = path.relative(ROOT, file);
    const content = fs.readFileSync(file, 'utf-8');
    const excluded = isQualityExcluded(relPath);

    // AllPatterns の存在確認（除外パスはスキップ）
    const hasAllPatterns = excluded || /export\s+const\s+AllPatterns/.test(content);

    // StoryObj<typeof meta> の型安全確認（除外パスはスキップ）
    // OK: type Story = StoryObj<typeof meta>
    // NG: type Story = StoryObj (ジェネリクスなし)
    let hasTypedStoryObj = true;
    if (!excluded) {
      const storyObjMatch = content.match(/type\s+Story\s*=\s*StoryObj(<[^>]+>)?/);
      hasTypedStoryObj = storyObjMatch ? storyObjMatch[1] !== undefined : true;
    }

    return {
      file: relPath,
      hasAllPatterns,
      hasTypedStoryObj,
    };
  });
}

// ─────────────────────────────────────────────────────────
// Collect Check（#2592）
// ─────────────────────────────────────────────────────────

const STORY_FILE_PATTERN = /\.stories\.(ts|tsx|js|jsx|mjs)$/;

function findStoryFilesByPattern(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.next') continue;
      results.push(...findStoryFilesByPattern(fullPath));
    } else if (STORY_FILE_PATTERN.test(entry.name)) {
      results.push(fullPath);
    }
  }
  return results;
}

function parseCollectedStoryFiles(listOutput: string, storybookRoot: string): Set<string> {
  const files = new Set<string>();
  for (const line of listOutput.split('\n')) {
    const match = line.match(/^\[storybook \(chromium\)\] (\S+)/);
    if (match?.[1]) files.add(path.resolve(storybookRoot, match[1]));
  }
  return files;
}

function checkCollected(): number {
  const expected = new Set(
    COLLECT_SCAN_ROOTS.flatMap(findStoryFilesByPattern).filter(
      (file) => !hasExcludedMetaTag(fs.readFileSync(file, 'utf-8'), EXCLUDED_STORY_TAGS),
    ),
  );

  // vitest list の表示パスは storybook project の root（apps/storybook）基準
  const output = execFileSync('pnpm', ['exec', 'vitest', 'list', '--project', 'storybook'], {
    cwd: APP_ROOT,
    encoding: 'utf-8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 15 * 60 * 1000,
  });
  const collected = parseCollectedStoryFiles(output, STORYBOOK_ROOT);

  const missing = [...expected].filter((file) => !collected.has(file)).sort();
  const unexpected = [...collected].filter((file) => !expected.has(file)).sort();

  console.log('\n━━━ Storybook Test Collection ━━━\n');
  console.log(`Expected: ${expected.size} files / Collected: ${collected.size} files\n`);

  for (const [label, files] of [
    ['Not collected', missing],
    ['Collected but not expected', unexpected],
  ] as const) {
    if (files.length === 0) continue;
    console.log(`${label} (${files.length}):`);
    for (const file of files) console.log(`  ${path.relative(ROOT, file)}`);
    console.log('');
  }

  if (missing.length === 0 && unexpected.length === 0) {
    console.log('All testable story files are collected.\n');
  }
  return missing.length + unexpected.length;
}

// ─────────────────────────────────────────────────────────
// Report
// ─────────────────────────────────────────────────────────

function main(): void {
  if (isCollected) {
    const mismatches = checkCollected();
    if (mismatches > 0) {
      console.error(
        `ERROR: storybook project の collect 集合が Story ファイルと ${mismatches} 件食い違う`,
      );
      process.exit(1);
    }
    return;
  }

  // Coverage
  const coverageResults = checkCoverage();
  const covered = coverageResults.filter((r) => r.hasStory);
  const missing = coverageResults.filter((r) => !r.hasStory);

  console.log('\n━━━ Story Coverage ━━━\n');
  console.log(`Total: ${covered.length}/${coverageResults.length} components\n`);

  if (missing.length > 0) {
    console.log(`Missing stories (${missing.length}):`);
    for (const { component, label } of missing) {
      console.log(`  [${label}] ${component}`);
    }
  } else {
    console.log('All components have stories.');
  }

  // Quality
  const storyFiles = [
    ...findAllStoryFiles(path.join(APP_ROOT, 'src')),
    ...findAllStoryFiles(path.join(STORYBOOK_ROOT, '.storybook')),
  ];
  const qualityResults = checkQuality(storyFiles);

  const missingAllPatterns = qualityResults.filter((r) => !r.hasAllPatterns);
  const untypedStoryObj = qualityResults.filter((r) => !r.hasTypedStoryObj);

  console.log('\n━━━ Story Quality ━━━\n');
  console.log(`Total story files: ${qualityResults.length}\n`);

  if (missingAllPatterns.length > 0) {
    console.log(`Missing AllPatterns (${missingAllPatterns.length}):`);
    for (const { file } of missingAllPatterns) {
      console.log(`  ${file}`);
    }
  } else {
    console.log('All stories have AllPatterns.');
  }

  if (untypedStoryObj.length > 0) {
    console.log(`\nUntyped StoryObj (${untypedStoryObj.length}):`);
    for (const { file } of untypedStoryObj) {
      console.log(`  ${file}`);
    }
  } else {
    console.log('All StoryObj are properly typed.');
  }

  console.log('');

  // Strict mode
  if (isStrict && missing.length > 0) {
    console.error(`ERROR: ${missing.length} components missing stories (strict mode)`);
    process.exit(1);
  }
}

main();
