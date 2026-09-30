import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderLiveDocument } from './render.ts';

let root: string;
const block = (view: string) =>
  `<!-- docs-live:${view}:start -->\n\n正本へのリンク\n\n<!-- docs-live:${view}:end -->\n`;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dayopt-docs-live-'));
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'fixture', scripts: { check: 'old-command' } }),
  );
  writeFileSync(join(root, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('閲覧時の生成', () => {
  it('package の実ファイル追加・削除を次の読取に反映する', () => {
    mkdirSync(join(root, 'packages/model/src'), { recursive: true });
    writeFileSync(join(root, 'packages/model/README.md'), block('files'));
    writeFileSync(join(root, 'packages/model/src/old.ts'), '');
    expect(renderLiveDocument(root, 'packages/model/README.md')).toContain('[old.ts](src/old.ts)');
    rmSync(join(root, 'packages/model/src/old.ts'));
    writeFileSync(join(root, 'packages/model/src/new.ts'), '');
    const next = renderLiveDocument(root, 'packages/model/README.md');
    expect(next).toContain('[new.ts](src/new.ts)');
    expect(next).not.toContain('old.ts');
  });

  it('Markdown 名の symlink から秘密ファイルへ読取を迂回させない', () => {
    writeFileSync(join(root, 'secret.txt'), 'secret');
    symlinkSync(join(root, 'secret.txt'), join(root, 'README.md'));
    expect(() => renderLiveDocument(root, 'README.md')).toThrow('symlink');
  });
  it('同じ process で正本を変更すると次の読取に反映し、生成本文を保存しない', () => {
    writeFileSync(join(root, 'README.md'), block('commands'));
    expect(renderLiveDocument(root, 'README.md')).toContain('old-command');
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'fixture', scripts: { build: 'new-command' } }),
    );
    const next = renderLiveDocument(root, 'README.md');
    expect(next).toContain('| pnpm build | new-command |');
    expect(next).not.toContain('old-command');
    expect(next).not.toContain('pnpm check');
    expect(readFileSync(join(root, 'README.md'), 'utf8')).toBe(block('commands'));
  });

  it('workspace の追加・除外を pnpm の selector から再発見する', () => {
    writeFileSync(join(root, 'README.md'), block('workspace'));
    mkdirSync(join(root, 'packages/new'), { recursive: true });
    writeFileSync(join(root, 'packages/new/package.json'), '{"name":"@fixture/new"}');
    expect(renderLiveDocument(root, 'README.md')).toContain('@fixture/new');
    writeFileSync(join(root, 'pnpm-workspace.yaml'), "packages:\n  - 'apps/*'\n");
    expect(renderLiveDocument(root, 'README.md')).not.toContain('@fixture/new');
  });

  it('入力が壊れた時に以前の結果や fallback 本文を返さない', () => {
    writeFileSync(join(root, 'README.md'), block('commands'));
    renderLiveDocument(root, 'README.md');
    writeFileSync(join(root, 'package.json'), '{');
    expect(() => renderLiveDocument(root, 'README.md')).toThrow();
  });

  it('不明な view・閉じ忘れは拒否し、コード例は変換しない', () => {
    writeFileSync(join(root, 'README.md'), block('unknown'));
    expect(() => renderLiveDocument(root, 'README.md')).toThrow('不正な');
    writeFileSync(join(root, 'README.md'), '<!-- docs-live:commands:start -->');
    expect(() => renderLiveDocument(root, 'README.md')).toThrow('end marker');
    const example = '```md\n' + block('commands') + '```\n';
    writeFileSync(join(root, 'README.md'), example);
    expect(renderLiveDocument(root, 'README.md')).toBe(example);
  });

  it.each([
    ['blockquote', '> ' + block('commands').replaceAll('\n', '\n> ')],
    ['list', '- ' + block('commands').replaceAll('\n', '\n  ')],
    ['list の blockquote', '- > ' + block('commands').replaceAll('\n', '\n  > ')],
  ])('%s 内の実 marker を古い本文のまま返さず拒否する', (_container, markdown) => {
    writeFileSync(join(root, 'README.md'), markdown);
    expect(() => renderLiveDocument(root, 'README.md')).toThrow('最上位');
  });

  it('blockquote 内でもコードフェンスの marker 例は変換しない', () => {
    const example = '> ```md\n> ' + block('commands').replaceAll('\n', '\n> ') + '```\n';
    writeFileSync(join(root, 'README.md'), example);
    expect(renderLiveDocument(root, 'README.md')).toBe(example);
  });

  it('異なる view の対応・入れ子を拒否する', () => {
    writeFileSync(
      join(root, 'README.md'),
      '<!-- docs-live:commands:start -->\n\n<!-- docs-live:workspace:end -->',
    );
    expect(() => renderLiveDocument(root, 'README.md')).toThrow('対応');
    writeFileSync(
      join(root, 'README.md'),
      '<!-- docs-live:commands:start -->\n\n' + block('workspace'),
    );
    expect(() => renderLiveDocument(root, 'README.md')).toThrow('入れ子');
  });
});

it('イベントの正本変更を次のfacts読取に反映し、古い定数や壊れた入力へfallbackしない', () => {
  const document = 'docs/operations/product-analytics.md';
  const source = 'apps/product/src/lib/analytics/product-events.ts';
  mkdirSync(join(root, 'docs/operations'), { recursive: true });
  mkdirSync(join(root, 'apps/product/src/lib/analytics'), { recursive: true });
  writeFileSync(join(root, document), block('facts'));
  writeFileSync(
    join(root, source),
    "export const PRODUCT_EVENT_NAMES = ['plan_created'] as const;",
  );
  expect(renderLiveDocument(root, document)).toContain('plan_created');
  writeFileSync(
    join(root, source),
    "export const PRODUCT_EVENT_NAMES = ['record_created'] as const;",
  );
  const next = renderLiveDocument(root, document);
  expect(next).toContain('record_created');
  expect(next).not.toContain('plan_created');
  expect(readFileSync(join(root, document), 'utf8')).toBe(block('facts'));
  writeFileSync(join(root, source), 'export const unrelated = 1;');
  expect(() => renderLiveDocument(root, document)).toThrow('PRODUCT_EVENT_NAMES');
});
