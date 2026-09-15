import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { parseFrontmatter, validateDocumentMetadata } from '../checks/frontmatter-check.ts';

const temporaryDirectories: string[] = [];

function createRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dayopt-docs-metadata-'));
  temporaryDirectories.push(root);
  return root;
}

function createFile(root: string, path: string, content = ''): void {
  const absolutePath = join(root, path);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content);
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe('parseFrontmatter', () => {
  it('scalarとlistを解析する', () => {
    const parsed = parseFrontmatter(`---
status: current
code:
  - apps/product
  - packages/domain
---
`);

    expect(parsed.errors).toEqual([]);
    expect(parsed.fields.get('status')).toBe('current');
    expect(parsed.fields.get('code')).toEqual(['apps/product', 'packages/domain']);
  });
});

describe('validateDocumentMetadata', () => {
  it('正常系: stockのmetadataと実在code pathを受理する', () => {
    const root = createRoot();
    createFile(root, 'apps/product/index.ts');

    const reasons = validateDocumentMetadata({
      content: `---
status: current
last_verified: 2026-07-14
code: apps/product
---
`,
      relativePath: 'docs/product/specs/calendar.md',
      root,
      today: '2026-07-14',
    });

    expect(reasons).toEqual([]);
  });

  it('正常系: codeのarrayにある実在pathをすべて検証する', () => {
    const root = createRoot();
    createFile(root, 'apps/product/index.ts');
    createFile(root, 'packages/domain/index.ts');

    const reasons = validateDocumentMetadata({
      content: `---
status: current
last_verified: 2026-07-14
code:
  - apps/product
  - packages/domain
---
`,
      relativePath: 'docs/engineering/architecture.md',
      root,
      today: '2026-07-14',
    });

    expect(reasons).toEqual([]);
  });

  it('エラー系: codeのarrayに含まれる不在pathを報告する', () => {
    const root = createRoot();
    createFile(root, 'apps/product/index.ts');

    const reasons = validateDocumentMetadata({
      content: `---
status: current
last_verified: 2026-07-14
code:
  - apps/product
  - packages/missing
---
`,
      relativePath: 'docs/engineering/architecture.md',
      root,
      today: '2026-07-14',
    });

    expect(reasons).toEqual(['codeのpathが存在しない: packages/missing']);
  });

  it('エラー系: stockの不正status・未来日・不在pathを報告する', () => {
    const reasons = validateDocumentMetadata({
      content: `---
status: active
last_verified: 2026-07-15
code: apps/missing
---
`,
      relativePath: 'docs/engineering/architecture.md',
      root: createRoot(),
      today: '2026-07-14',
    });

    expect(reasons).toEqual([
      'stockのstatusが不正: active',
      'last_verifiedが有効な過去日付ではない: 2026-07-15',
      'codeのpathが存在しない: apps/missing',
    ]);
  });

  it('境界: docsルート直下に昇格したstock file（docs/strategy.md）にもstock契約を適用する', () => {
    const reasons = validateDocumentMetadata({
      content: `---
status: current
last_verified: 2026-07-14
---
`,
      relativePath: 'docs/strategy.md',
      root: createRoot(),
      today: '2026-07-14',
    });

    expect(reasons).toEqual([]);
  });

  it('境界: docsルート直下のstock fileもmetadata欠落を報告する', () => {
    const reasons = validateDocumentMetadata({
      content: '# Strategy\n',
      relativePath: 'docs/strategy.md',
      root: createRoot(),
      today: '2026-07-14',
    });

    expect(reasons).toEqual([
      'frontmatterがない',
      'frontmatterにstatusがない',
      'frontmatterにlast_verifiedがない',
    ]);
  });

  it('エラー系: stockの実在しないカレンダー日付を拒否する', () => {
    const reasons = validateDocumentMetadata({
      content: `---
status: current
last_verified: 2026-02-30
---
`,
      relativePath: 'docs/engineering/architecture.md',
      root: createRoot(),
      today: '2026-07-14',
    });

    expect(reasons).toEqual(['last_verifiedが有効な過去日付ではない: 2026-02-30']);
  });

  it('正常系: superseded_byが実在するrepo-relative pathなら受理する', () => {
    const root = createRoot();
    createFile(root, 'docs/product/superseding-doc.md');

    const reasons = validateDocumentMetadata({
      content: `---
status: superseded
last_verified: 2026-07-14
superseded_by: docs/product/superseding-doc.md
---
`,
      relativePath: 'docs/product/superseded-doc.md',
      root,
      today: '2026-08-01',
    });

    expect(reasons).toEqual([]);
  });

  it('エラー系: superseded_byの不在pathを拒否する', () => {
    const reasons = validateDocumentMetadata({
      content: `---
status: superseded
last_verified: 2026-07-14
superseded_by: docs/product/missing-doc.md
---
`,
      relativePath: 'docs/product/superseded-doc.md',
      root: createRoot(),
      today: '2026-08-01',
    });

    expect(reasons).toEqual(['superseded_byのpathが存在しない: docs/product/missing-doc.md']);
  });

  it('エラー系: superseded_byのarray指定を拒否する', () => {
    const root = createRoot();
    createFile(root, 'docs/product/superseding-doc.md');

    const reasons = validateDocumentMetadata({
      content: `---
status: superseded
last_verified: 2026-07-14
superseded_by:
  - docs/product/superseding-doc.md
---
`,
      relativePath: 'docs/product/superseded-doc.md',
      root,
      today: '2026-08-01',
    });

    expect(reasons).toEqual(['superseded_byはscalarのrepo-relative pathで指定する']);
  });

  it('境界: secrets.mdはstock契約の検証対象にする', () => {
    const reasons = validateDocumentMetadata({
      content: '# Secrets\n',
      relativePath: 'docs/operations/secrets.md',
      root: createRoot(),
      today: '2026-07-14',
    });

    expect(reasons).toEqual([
      'frontmatterがない',
      'frontmatterにstatusがない',
      'frontmatterにlast_verifiedがない',
    ]);
  });

  it('境界: RLS snapshotと似たpathはgenerated例外にしない', () => {
    const reasons = validateDocumentMetadata({
      content: '# snapshot\n',
      relativePath: 'docs/engineering/data/db/rls-snapshot-copy.md',
      root: createRoot(),
      today: '2026-07-14',
    });

    expect(reasons).toEqual([
      'frontmatterがない',
      'frontmatterにstatusがない',
      'frontmatterにlast_verifiedがない',
    ]);
  });

  it('generated snapshotは生成情報だけを検証する', () => {
    const reasons = validateDocumentMetadata({
      content: '# snapshot',
      relativePath: 'docs/engineering/data/db/rls-snapshot.md',
      root: createRoot(),
      today: '2026-07-14',
    });

    expect(reasons).toEqual(['generated snapshotに生成元・command・手編集禁止の表示がない']);
  });

  it('generated file ごとの契約（生成元 script / command）を GENERATED_DOC_CONTRACTS から引く', () => {
    const inventory = 'docs/engineering/data/architecture-inventory.md';
    const ok = validateDocumentMetadata({
      content:
        '# Architecture Inventory\n\n> 生成元: `scripts/tasks/generate-architecture-map.ts`（`pnpm architecture:generate`）。手で編集しない。',
      relativePath: inventory,
      root: createRoot(),
      today: '2026-07-14',
    });
    expect(ok).toEqual([]);

    // rls-snapshot の生成元を書いても inventory の契約は満たさない
    const wrongSource = validateDocumentMetadata({
      content:
        '> 生成元: `scripts/tasks/generate-rls-snapshot.ts`（`pnpm rls:snapshot`）。手で編集しない。',
      relativePath: inventory,
      root: createRoot(),
      today: '2026-07-14',
    });
    expect(wrongSource).toEqual(['generated snapshotに生成元・command・手編集禁止の表示がない']);
  });
});

describe('product specのレジストリ形式', () => {
  function validateSpec(frontmatter: string): string[] {
    return validateDocumentMetadata({
      content: `---\nstatus: current\nlast_verified: 2026-07-14\n${frontmatter}---\n`,
      relativePath: 'docs/product/specs/review.md',
      root: createRoot(),
      today: '2026-07-14',
    });
  }

  it('正常系: slugのlistと空配列を受理する', () => {
    expect(validateSpec("public_docs:\n  - review\nlp:\n  - 'Core Review metrics'\n")).toEqual([]);
    expect(validateSpec('public_docs: []\nlp: []\n')).toEqual([]);
  });

  it('エラー系: public_docsにpathや拡張子を書いたら拒否する', () => {
    expect(
      validateSpec('public_docs:\n  - apps/web/content/docs/en/features/review.mdx\n'),
    ).toEqual([
      'public_docsはkebab-caseのslugで書く（pathや拡張子は書かない）: apps/web/content/docs/en/features/review.mdx',
    ]);
  });

  it('エラー系: scalarで書いたら配列を要求する', () => {
    expect(validateSpec('public_docs: review\n')).toEqual([
      'public_docsは配列で書く（公開docsが無い場合は空配列）',
    ]);
  });

  it('境界: spec以外のstockには適用しない', () => {
    const reasons = validateDocumentMetadata({
      content: `---\nstatus: current\nlast_verified: 2026-07-14\npublic_docs: review\n---\n`,
      relativePath: 'docs/product/principles.md',
      root: createRoot(),
      today: '2026-07-14',
    });

    expect(reasons).toEqual([]);
  });
});
