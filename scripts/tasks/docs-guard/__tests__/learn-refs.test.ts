import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { collectLearnData } from '../../../lib/learn/data.ts';
import { learnMarkers, renderLearnDocs } from '../../../lib/learn/render-markdown.ts';
import { checkLearnRefs, runLearnRefsCheck } from '../checks/learn-refs.ts';

const FM = '---\nstatus: current\nlast_verified: 2026-09-21\n---\n\n';
const MARK = (kind: string) =>
  `<!-- learn:generated:start — 正本 このファイルの learn:${kind} の JSON / 再生成 pnpm learn:generate / 検証 pnpm docs:check。この範囲は手編集しない -->\n\n<!-- learn:generated:end -->\n`;
const block = (kind: string, value: unknown) =>
  `\n\`\`\`json learn:${kind}\n${JSON.stringify(value, null, 2)}\n\`\`\`\n`;

const services = {
  services: { browser: { label: 'ブラウザ', var: '--svc-browser', sub: '' } },
  outages: { title: '停止', intro: 'i', features: [], items: [] },
};
const screenNode = {
  id: 'home',
  label: 'ホーム',
  url: '/',
  col: 1,
  row: 1,
  group: 'app',
  what: 'w',
  arrive: 'a',
  loads: 'l',
  svcs: [],
  fails: 'f',
  screen: { t: 'blank' },
  refs: [],
  flows: [],
};
const screens = { title: '画面', intro: 'i', columns: ['a'], nodes: [screenNode], edges: [] };
const journey = (find: string) => ({
  id: 'demo',
  title: 'デモ',
  order: 10,
  group: 'calendar',
  intro: 'i',
  play: '▶',
  lanes: ['browser'],
  hops: [
    {
      id: 'one',
      svc: 'browser',
      short: 's',
      title: 't',
      what: 'w',
      refs: [{ path: 'real.ts', find }],
      tests: [{ path: 'real.test.ts', find: "it('保存できる'" }],
      fails: [],
    },
  ],
});

const API_DIR = 'apps/product/src/app/api';
const entrypoints = {
  title: '入口',
  intro: 'i',
  notes: {
    '/api/health': { who: '監視', why: 'w', outage: 'o' },
    '/api/cron/tick': { who: 'cron', why: 'w', outage: 'o', journey: { id: 'demo', hop: 'one' } },
  },
};

function writeEntrypoints(root: string, value: unknown = entrypoints): void {
  writeFileSync(
    join(root, 'docs/learn/system/entrypoints.md'),
    `${FM}# e\n\n${learnMarkers('entrypoints').start}\n\n${learnMarkers('entrypoints').end}\n${block('entrypoints', value)}`,
  );
}

function fixture(find = 'createPlan'): string {
  const root = mkdtempSync(join(tmpdir(), 'learn-refs-'));
  mkdirSync(join(root, 'docs/learn/journeys'), { recursive: true });
  mkdirSync(join(root, 'docs/learn/system'), { recursive: true });
  mkdirSync(join(root, API_DIR, 'health'), { recursive: true });
  mkdirSync(join(root, API_DIR, 'cron/tick'), { recursive: true });
  writeFileSync(join(root, API_DIR, 'health/route.ts'), 'export function GET() {}\n');
  writeFileSync(join(root, API_DIR, 'cron/tick/route.ts'), 'export { h as GET };\n');
  mkdirSync(join(root, 'apps/product'), { recursive: true });
  writeFileSync(
    join(root, 'apps/product/vercel.json'),
    JSON.stringify({ crons: [{ path: '/api/cron/tick', schedule: '*/15 * * * *' }] }),
  );
  writeEntrypoints(root);
  writeFileSync(join(root, 'real.ts'), 'export function createPlan() {}\n');
  writeFileSync(join(root, 'real.test.ts'), "it('保存できる', () => {});\n");
  writeFileSync(
    join(root, 'docs/learn/system/services.md'),
    `${FM}# s\n\n${MARK('services')}${block('services', services)}`,
  );
  writeFileSync(
    join(root, 'docs/learn/system/screens.md'),
    `${FM}# s\n\n${MARK('screens')}${block('screens', screens)}`,
  );
  writeFileSync(
    join(root, 'docs/learn/journeys/demo.md'),
    `${FM}# デモ\n\n${MARK('journey')}${block('journey', journey(find))}`,
  );
  return root;
}

describe('checkLearnRefs', () => {
  const root = mkdtempSync(join(tmpdir(), 'learn-refs-unit-'));
  writeFileSync(join(root, 'real.ts'), 'export function createPlan() {}\n');
  const file = 'docs/learn/journeys/demo.md';

  it('在るファイルの在る文字列は通す', () => {
    expect(checkLearnRefs([{ file, ref: { path: 'real.ts', find: 'createPlan' } }], root)).toEqual(
      [],
    );
  });

  it('消えたファイルを報告する', () => {
    const violations = checkLearnRefs(
      [{ file, ref: { path: 'gone.ts', find: 'createPlan' } }],
      root,
    );
    expect(violations.map((v) => v.reason)).toEqual(['ファイルが存在しない']);
  });

  it('改名された symbol を報告する', () => {
    const violations = checkLearnRefs(
      [{ file, ref: { path: 'real.ts', find: 'createPlanV2' } }],
      root,
    );
    expect(violations.map((v) => v.reason)).toEqual(['find の文字列がファイルに無い']);
  });

  it('repo の外を指す path を報告する', () => {
    const violations = checkLearnRefs([{ file, ref: { path: '../outside.ts', find: 'x' } }], root);
    expect(violations.map((v) => v.reason)).toEqual(['repo の外を指している']);
  });
});

describe('runLearnRefsCheck', () => {
  it('再生成した後は違反 0 件（drift 検出が常に鳴るわけではない）', async () => {
    const root = fixture();
    for (const doc of await renderLearnDocs(root, collectLearnData(root))) {
      writeFileSync(join(root, doc.file), doc.expected);
    }
    expect(await runLearnRefsCheck(root)).toEqual([]);
  });

  it('生成ブロックが空のままなら drift として報告する', async () => {
    const violations = await runLearnRefsCheck(fixture());
    expect(violations.map((v) => v.reason)).toContain(
      '生成ブロックが正本と一致しない。pnpm learn:generate を実行する',
    );
  });

  it('テストへの参照（tests）も検査する', async () => {
    const root = fixture();
    writeFileSync(join(root, 'real.test.ts'), "it('別の題', () => {});\n");
    const violations = await runLearnRefsCheck(root);
    expect(violations.some((v) => v.ref.includes("real.test.ts :: it('保存できる'"))).toBe(true);
  });

  it('schema 違反（lanes に無いサービスの段）を報告する', async () => {
    const root = fixture();
    const path = join(root, 'docs/learn/journeys/demo.md');
    writeFileSync(path, readFileSync(path, 'utf8').replace('"svc": "browser"', '"svc": "vercel"'));
    const violations = await runLearnRefsCheck(root);
    expect(violations.some((v) => v.reason.includes('hop one の svc vercel が lanes に無い'))).toBe(
      true,
    );
  });

  it('章や lab の learn:refs が指すコードの消失を報告する', async () => {
    const root = fixture();
    writeFileSync(
      join(root, 'docs/learn/00-chapter.md'),
      `${FM}# 章\n${block('refs', [{ path: 'real.ts', find: 'removedSymbol' }])}`,
    );
    const violations = await runLearnRefsCheck(root);
    expect(violations.some((v) => v.ref.includes('00-chapter.md: real.ts :: removedSymbol'))).toBe(
      true,
    );
  });

  it('言語が json でない learn: block を黙って無視しない', async () => {
    const root = fixture();
    writeFileSync(
      join(root, 'docs/learn/00-chapter.md'),
      `${FM}# 章\n\n\`\`\`jsonc learn:refs\n[]\n\`\`\`\n`,
    );
    const violations = await runLearnRefsCheck(root);
    expect(violations.some((v) => v.reason.includes('言語が json ではない'))).toBe(true);
  });

  it('片方向の twin を報告する', async () => {
    const root = fixture();
    const other = { ...journey('createPlan'), id: 'other', order: 20, twin: 'demo' };
    writeFileSync(
      join(root, 'docs/learn/journeys/other.md'),
      `${FM}# 別\n\n${MARK('journey')}${block('journey', other)}`,
    );
    const violations = await runLearnRefsCheck(root);
    expect(violations.some((v) => v.reason.includes('twin が片方向'))).toBe(true);
  });

  it('生成範囲のマーカーが複製されていたら報告する（後ろの範囲が drift 検査をすり抜けない）', async () => {
    const root = fixture();
    const path = join(root, 'docs/learn/journeys/demo.md');
    writeFileSync(
      path,
      readFileSync(path, 'utf8').replace(MARK('journey'), MARK('journey') + MARK('journey')),
    );
    const violations = await runLearnRefsCheck(root);
    expect(violations.some((v) => v.reason.includes('マーカーが 2 個ある'))).toBe(true);
  });

  it('.. を含む参照パスを拒否する（同じファイルが別表記になり逆引きから外れる）', async () => {
    const root = fixture('createPlan');
    const path = join(root, 'docs/learn/journeys/demo.md');
    writeFileSync(
      path,
      readFileSync(path, 'utf8').replace('"path": "real.ts"', '"path": "sub/../real.ts"'),
    );
    const violations = await runLearnRefsCheck(root);
    expect(violations.some((v) => v.reason.includes('正規化した repo 相対パスで書く'))).toBe(true);
  });

  it('壊れた JSON を報告する', async () => {
    const root = fixture();
    const path = join(root, 'docs/learn/journeys/demo.md');
    writeFileSync(path, readFileSync(path, 'utf8').replace('"order": 10,', '"order": 10'));
    const violations = await runLearnRefsCheck(root);
    expect(violations.some((v) => v.reason.includes('JSON が壊れている'))).toBe(true);
  });
});

describe('入口の一覧と説明の対応', () => {
  const reasons = (root: string) => collectLearnData(root).errors;

  it('一覧と説明が揃っていれば error 0 件', () => {
    expect(reasons(fixture())).toEqual([]);
  });

  it('route.ts を足したのに説明が無ければ止める', () => {
    const root = fixture();
    mkdirSync(join(root, API_DIR, 'fresh'), { recursive: true });
    writeFileSync(join(root, API_DIR, 'fresh/route.ts'), 'export const POST = () => {};\n');
    expect(reasons(root)).toEqual([expect.stringContaining('入口 /api/fresh')]);
  });

  it('route.ts が消えたのに説明が残っていれば止める', () => {
    const root = fixture();
    writeEntrypoints(root, {
      ...entrypoints,
      notes: { ...entrypoints.notes, '/api/gone': { who: 'x', why: 'y', outage: 'z' } },
    });
    expect(reasons(root)).toEqual([expect.stringContaining('入口 /api/gone の説明があるが')]);
  });

  it('vercel.json の cron が無い route を指していれば止める', () => {
    const root = fixture();
    writeFileSync(
      join(root, 'apps/product/vercel.json'),
      JSON.stringify({ crons: [{ path: '/api/cron/ghost', schedule: '0 0 * * *' }] }),
    );
    expect(reasons(root)).toEqual([expect.stringContaining('cron /api/cron/ghost')]);
  });

  it('説明が存在しない段を指していれば止める', () => {
    const root = fixture();
    writeEntrypoints(root, {
      ...entrypoints,
      notes: {
        ...entrypoints.notes,
        '/api/cron/tick': { who: 'c', why: 'w', outage: 'o', journey: { id: 'demo', hop: 'nine' } },
      },
    });
    expect(reasons(root)).toEqual([expect.stringContaining('無い段を指す: nine')]);
  });

  it('生成した表に cron の間隔と経路の段が載る', async () => {
    const root = fixture();
    const doc = (await renderLearnDocs(root, collectLearnData(root))).find((d) =>
      d.file.endsWith('entrypoints.md'),
    );
    expect(doc?.expected).toContain('15 分ごと');
    expect(doc?.expected).toContain('の 1 ');
    expect(doc?.expected).toContain('| GET ');
  });
});
