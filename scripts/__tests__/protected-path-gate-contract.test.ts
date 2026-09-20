/**
 * `PROTECTED_PATH_GLOBS`（`scripts/ci/protected-path-gate.mjs`）の drift 検出（#2503）。
 *
 * このリストは「標準の GitHub `@codex review` で重点的に読む範囲を示す」という
 * 意味を持つ。リテラルとして書かれているため、次の 2 種類の drift が
 * 機械には見えない:
 *   1. glob が実際には 1 件も既存ファイルに一致しない（親ディレクトリが残って
 *      いても、対象ファイルがリネーム/移動されると gate が黙って「マッチしない
 *      = 保護されない」へ縮退する。例えば `mcp-*` に一致するファイルが全て
 *      移動されても `mcp/` ディレクトリ自体は残り得る。Codex 指摘 #2546:
 *      static prefix ディレクトリの実在チェックだけでは検出できない）
 *   2. `.github/workflows/production-config-audit.yml` に置いた同じ 4 path の
 *      コピー（self-change 検出の grep 正規表現と、#2571 で足した
 *      `pull_request_target` の `paths` filter）と、ここに載せた定数のうち
 *      一部だけが変わる
 *
 * ここでは (1) を `resolveProtectedPathGate`（gate 本体が使う実際の matcher）に
 * 対して repo の全 tracked file を1件ずつ通し、各 glob が少なくとも1件へ実際に
 * 一致することで固定する。(2) は workflow の grep 正規表現と `paths` filter を
 * それぞれ実際にパースして `PRODUCTION_CONFIG_AUDIT_CONTRACT_PATHS` と
 * 突き合わせることで固定する（コピーは 3 箇所ある）。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  PRODUCTION_CONFIG_AUDIT_CONTRACT_PATHS,
  PROTECTED_PATH_GLOBS,
  resolveProtectedPathGate,
} from '../ci/protected-path-gate.mjs';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function listTrackedFiles(): string[] {
  return execFileSync('git', ['ls-files'], { cwd: rootDir, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
}

describe('PROTECTED_PATH_GLOBS の drift 検出（#2503）', () => {
  it('各 glob（リテラル含む）は少なくとも1件の既存 tracked file に実際に一致する', () => {
    // 判定そのものが空リストで無意味化していないことを保証する。
    expect(PROTECTED_PATH_GLOBS.length).toBeGreaterThan(0);

    const trackedFiles = listTrackedFiles();
    expect(trackedFiles.length).toBeGreaterThan(0);

    // gate 本体（scripts/tasks/finish-branch.sh から呼ばれる実際の matcher）を
    // そのまま使う。glob 展開ロジックをここで再実装すると、実装と検証が別々に
    // driftする経路を新たに作ってしまうため避ける。
    const matchedGlobs = new Set<string>();
    for (const file of trackedFiles) {
      const result = resolveProtectedPathGate([file]);
      if (result.required) matchedGlobs.add(result.reason);
    }

    const unmatched = PROTECTED_PATH_GLOBS.filter((glob) => !matchedGlobs.has(glob));
    expect(unmatched).toEqual([]);
  });

  it('production-config-audit.yml の self-change grep と PRODUCTION_CONFIG_AUDIT_CONTRACT_PATHS は同じ 4 path を指す', () => {
    const workflow = readFileSync(
      join(rootDir, '.github/workflows/production-config-audit.yml'),
      'utf8',
    );

    // 対象の grep 行を取り出す: grep -Eq '^(path1|path2|...)$'
    const grepLineMatch = workflow.match(/grep -Eq '\^\(([^)]+)\)\$'/);
    expect(grepLineMatch).not.toBeNull();
    // 将来 workflow に別の `grep -Eq '^(...)$'` が先行して追加されると、この
    // match() は無関係な最初の 1 件を契約として検証してしまい、本来の
    // self-change 検出リストの drift を見逃したまま green になる（risk-reviewer
    // 指摘 #2503）。同じ形の行が複数存在しないことを固定する。
    expect([...workflow.matchAll(/grep -Eq '\^\([^)]+\)\$'/g)]).toHaveLength(1);

    const alternation = grepLineMatch![1];
    // 各 alternative は shell 経由で ERE リテラルとして書かれており、正規表現の
    // メタ文字（`.`）だけがエスケープされている（`\.` -> `.`）。それ以外の
    // エスケープは想定していないため、他の文字が来たら気づけるよう安全側で
    // 単純な `\X -> X` の unescape に留める。
    const paths = alternation.split('|').map((segment) => segment.replace(/\\(.)/g, '$1'));

    expect(new Set(paths)).toEqual(new Set(PRODUCTION_CONFIG_AUDIT_CONTRACT_PATHS));
    // 重複や空文字列が紛れて Set 比較をすり抜けていないことも確認する。
    expect(paths.length).toBe(PRODUCTION_CONFIG_AUDIT_CONTRACT_PATHS.length);
  });

  it('pull_request_target の paths filter も同じ 4 path を指す（#2571）', () => {
    // #2571 で PR ごとの実行を contract 変更 PR だけに絞った。この `paths` が
    // `PRODUCTION_CONFIG_AUDIT_CONTRACT_PATHS` から drift すると、静かに次の
    // どちらかへ倒れる:
    //   - 広すぎる: 削減が効かず Actions を食い続ける（気づきにくい）
    //   - 狭すぎる: **contract 変更 PR で guard が発火せず**、PR code に
    //     contract 変更を自己検証させない設計そのものが無効化される（危険側）
    // 同じ 4 path のコピーは grep 正規表現・定数・この `paths` の 3 箇所になったので、
    // 3 箇所すべてを 1 つの契約として固定する。
    const workflow = readFileSync(
      join(rootDir, '.github/workflows/production-config-audit.yml'),
      'utf8',
    );

    // `push:` 側にも別の `paths:`（`supabase/**` を含む）があるため、切り出しは
    // `pull_request_target:` 〜 次のトリガー（`push:`）に限定する。YAML パーサを
    // 使わないのは release-workflow-contract.test.ts と同じ理由（生の記述を
    // そのまま契約として読む）。
    const startIndex = workflow.indexOf('\n  pull_request_target:');
    expect(startIndex).toBeGreaterThan(-1);
    const endIndex = workflow.indexOf('\n  push:', startIndex);
    expect(endIndex).toBeGreaterThan(startIndex);
    const block = workflow.slice(startIndex, endIndex);

    // 切り出した範囲に `paths:` がちょうど 1 つあること（`paths-ignore:` の
    // 混入や、将来の重複定義に気づけるようにする）。
    expect([...block.matchAll(/^\s+paths:$/gm)]).toHaveLength(1);
    expect(block).not.toContain('paths-ignore');

    const paths = [...block.matchAll(/^\s+- '([^']+)'$/gm)].map((match) => match[1]);

    expect(new Set(paths)).toEqual(new Set(PRODUCTION_CONFIG_AUDIT_CONTRACT_PATHS));
    expect(paths.length).toBe(PRODUCTION_CONFIG_AUDIT_CONTRACT_PATHS.length);
  });

  it('auditContract は 4 path すべてで true になる（判定器の取りこぼしを止める）', () => {
    // 他の 3 コピー（`paths` filter / workflow の grep / PROTECTED_PATH_GLOBS）は
    // すべてパターンとして解釈される。ここだけ完全一致にすると、将来リストの 1 要素を
    // glob へ畳んだ瞬間に **他は動くのにこの判定だけ永久に false へ落ち**、
    // #2571 の trusted-head checkpoint がまるごと無効化される。
    for (const path of PRODUCTION_CONFIG_AUDIT_CONTRACT_PATHS) {
      expect(resolveProtectedPathGate([path]).auditContract).toBe(true);
    }
  });

  it('audit contract 以外の保護対象では auditContract を立てない', () => {
    // ここまで広げると、migration を触るだけの PR が毎回 trusted dispatch を要求される。
    const result = resolveProtectedPathGate(['supabase/migrations/20260903000000_x.sql']);
    expect(result.required).toBe(true);
    expect(result.auditContract).toBe(false);
  });

  it('PRODUCTION_CONFIG_AUDIT_CONTRACT_PATHS は PROTECTED_PATH_GLOBS に含まれる', () => {
    for (const path of PRODUCTION_CONFIG_AUDIT_CONTRACT_PATHS) {
      expect(PROTECTED_PATH_GLOBS).toContain(path);
    }
  });
});
