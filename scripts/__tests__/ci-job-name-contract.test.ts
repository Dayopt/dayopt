import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * CI の job 表示名は「名前で success を要求する」3 つの gate の入力になっている。
 * YAML の `name:` を変えるだけで gate が静かに壊れる（永久に missing で止まる /
 * 逆に誤って green と判定する）ため、名前と参照側の一致をここで固定する。
 *
 * 参照している gate:
 * - `scripts/tasks/finish-branch.sh` の REQUIRED_CI_CHECKS（ci.yml の 3 job、#2415 / #2539）
 *
 * **promote.yml の層 3 gate は 2026-09-03 に名前結合をやめた。** 層 3（E2E /
 * Web Build & E2E）を nightly.yml から promote.yml へ移設し、gate を check-run 名の
 * 照合から同一 run 内の `needs.*.result` へ置き換えたため、「表示名を変えると
 * promote が fail closed で止まる」class が消えている（契約は
 * `scripts/ci/release-workflow-contract.test.ts` が持つ）。それでも表示名の重複は
 * 別経路（finish-branch の名前照合、人が run を読む時の識別）で効くので、
 * **repo の全 workflow を横断した重複禁止**として残す。
 *
 * 併せて **ci.yml の checkout が資格情報を残さないこと**も固定する（#2539 のクロスレビュー
 * risk-reviewer P1）。ci.yml の job は PR branch のコードとその全依存（postinstall・vitest
 * transform・eslint plugin）を実行するため、`persist-credentials` を既定（true）のままに
 * すると `.git/config` の `http.extraheader` に GITHUB_TOKEN が残り、PR 側のコードから
 * `git config --get-all http.https://github.com/.extraheader` で読み出せる。unit job は
 * `pull-requests: write` / `issues: write` を持つので、これは書き込み権限の奪取に直結する。
 * この契約は **repo の全 workflow に適用する**。#2539 の時点で ci.yml は 4 件中 0 件、
 * nightly.yml は 6 件中 3 件が未指定だった（create-release.yml も未指定で、しかも
 * `contents: write` を持つ）。件数ではなく checkout ブロック単位で見る。
 */

const readWorkflow = (name: string) =>
  readFileSync(join(process.cwd(), '.github/workflows', name), 'utf8');

/** `jobs:` 配下の `name: "..."` を job 表示名として抜き出す（`\UXXXXXXXX` を復元する）。 */
function jobDisplayNames(yamlText: string): string[] {
  return [...yamlText.matchAll(/^ {4}name: (.+)$/gm)]
    .map((match) => match[1].trim())
    .map((raw) => raw.replace(/^["']|["']$/g, ''))
    .map((value) =>
      value.replace(/\\U([0-9A-Fa-f]{8})/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16))),
    );
}

const ciNames = jobDisplayNames(readWorkflow('ci.yml'));
const nightlyNames = jobDisplayNames(readWorkflow('nightly.yml'));
const promoteNames = jobDisplayNames(readWorkflow('promote.yml'));
const finishBranch = readFileSync(join(process.cwd(), 'scripts/tasks/finish-branch.sh'), 'utf8');

describe('CI job 名の契約', () => {
  it('ci.yml は impact / static / unit / integration の 4 job を持つ', () => {
    expect(ciNames).toEqual([
      '🧭 Impact',
      '🔍 Static Checks',
      '📦 Unit Tests',
      '🧪 Integration Tests',
    ]);
  });

  it('finish-branch.sh が要求する 3 job 名は ci.yml に実在する', () => {
    // 代入の形は 2 通りある（`REQUIRED_CI_CHECKS=("🔍 Static Checks")` と
    // 条件つきの `REQUIRED_CI_CHECKS+=("📦 Unit Tests")`）ので、配列リテラルの
    // 中身として現れることだけを見る。
    for (const name of ['🔍 Static Checks', '📦 Unit Tests', '🧪 Integration Tests']) {
      expect(finishBranch, `finish-branch.sh の REQUIRED_CI_CHECKS に「${name}」が無い`).toMatch(
        new RegExp(`REQUIRED_CI_CHECKS\\+?=\\("${name}"\\)`),
      );
      expect(ciNames, `ci.yml に「${name}」が無い`).toContain(name);
    }
  });

  it('promote.yml は impact と層 3 の 2 suite、失敗の起票、release を持つ', () => {
    // 層 3 は 2026-09-03 に nightly.yml から移設した。名前は check-run gate の
    // 入力ではなくなったが、run を読む人と `gh run view` の識別子として残る。
    // `File promote failure` は 2026-09-07（#2643）に足した失敗の可視化 job で、
    // contract の都合で release job より前に宣言している。
    expect(promoteNames).toEqual([
      '🧭 Release Impact',
      '🎭 E2E Tests',
      '🌐 Web Build & E2E',
      'File promote failure',
      'Promote Production',
    ]);
  });

  it('nightly.yml は層 3 を持たない（promote.yml へ移設済み）', () => {
    // ここへ戻すと同じ suite が 1 日 1 回と merge ごとの二重で走る。
    for (const name of ['🎭 E2E Tests', '🌐 Web Build & E2E', 'Integration Tests']) {
      expect(nightlyNames, `nightly.yml に「${name}」が残っている`).not.toContain(name);
    }
  });

  it('workflow を跨いで job 表示名が 1 つも重複しない', () => {
    const all = [...ciNames, ...nightlyNames, ...promoteNames];
    const duplicated = all.filter((name, index) => all.indexOf(name) !== index);

    expect(duplicated).toEqual([]);
  });

  it('job 表示名に variation selector（U+FE0F）を含めない', () => {
    // check run 名は文字列一致で照合される。`🗄️` のように VS16 が付く絵文字を
    // YAML の `\UXXXXXXXX` 記法と併記すると、bash 側のリテラルと不一致になりうる。
    for (const name of [...ciNames, ...nightlyNames, ...promoteNames]) {
      expect(name, `${name} に VS16 が含まれる`).not.toContain('️');
    }
  });

  // ── checkout の資格情報（#2539 クロスレビュー risk-reviewer P1）─────
  describe('checkout は資格情報を残さない', () => {
    /**
     * ── この guard の保証境界（#2557）───────────────────────────────
     *
     * 走査は YAML パーサを使わず、**行単位の正規表現**で `uses: actions/checkout@…`
     * を拾い、その step ブロック内に `persist-credentials: false` があるかを見る。
     *
     * **保証すること**:
     * - block style（1 step 1 行の `- uses: …`）で書かれた checkout を、
     *   `uses` の値が quote されていても検出する
     * - 走査対象は `.github/workflows/*.{yml,yaml}` に加えて
     *   `.github/actions/*​/action.{yml,yaml}`。**composite action は呼び出し元 job の
     *   token 権限で走る**ため、workflow に直接書いた checkout と同じ露出を持つ
     *   （ci.yml の全 job が `./.github/actions/setup` を呼ぶ）
     *
     * **保証しないこと**（意図的に諦めている範囲）:
     * - flow style（`- {uses: actions/checkout@sha}`）
     * - folded / block scalar や anchor / alias 経由で組み立てた `uses`
     * - 上の 2 つの glob の外に置かれた workflow / action 定義
     *   （`.github/actions/<dir>/<dir>/action.yml` のような入れ子を含む）
     * - `actions/checkout` の fork や別名の checkout 実装
     *
     * **同型（YAML を regex で読むことに起因する取りこぼし）の指摘が出ても、
     * 個別ケースを 1 つずつ regex へ足さないこと。** ここに書いた境界を更新するか、
     * YAML パーサで読む方式へ切り替えるかを先に判断する。点を足し続けると
     * 「何を保証している guard なのか」を誰も言えなくなる（#2554 → #2557 で同型の
     * 指摘が 2 巡した。AGENTS.md §レビュー「迷ったら点を塞ぐより class を閉じる」）。
     */

    // **件数比較にしない**（同レビュー P3）。`checkout の数 === persist-credentials の数`
    // だと、解説コメントに `persist-credentials: false` という文字列を 1 行足した上で
    // 未指定の checkout を 1 件足すと数が揃って素通りする。この repo の workflow は
    // 日本語コメントが密なので現実的な偽陰性経路になる。step ブロック単位で見る。
    function checkoutStepsWithoutPersistFalse(yamlText: string): number[] {
      const lines = yamlText.split('\n');
      const offenders: number[] = [];
      lines.forEach((line, index) => {
        // `['"]?` は quote した `- uses: 'actions/checkout@v7'` を拾うため（#2557 穴 2）。
        // 値の直後は必ず `@<ref>` が続く（GitHub は ref 無しの remote action を許さない）。
        if (!/^\s*(-\s+)?uses:\s*['"]?actions\/checkout@/.test(line)) return;
        // この checkout step のブロック = 次の `- ` 始まりの step まで
        let hasPersistFalse = false;
        for (let i = index + 1; i < lines.length; i += 1) {
          const current = lines[i];
          if (/^\s*-\s/.test(current)) break; // 次の step
          if (/^\s*\w[\w-]*:/.test(current) && !/^\s+/.test(current)) break; // 次の top-level key
          const withoutComment = current.replace(/#.*$/, ''); // コメントは数えない
          if (/persist-credentials:\s*false/.test(withoutComment)) {
            hasPersistFalse = true;
            break;
          }
        }
        if (!hasPersistFalse) offenders.push(index + 1);
      });
      return offenders;
    }

    // 走査対象は workflow だけでなく composite action 定義も含む（#2557 穴 1）。
    // **`.yaml` も拾う**（#2554 クロスレビュー risk-reviewer P2）。GitHub Actions は
    // 両方の拡張子を等しく受け付けるため、`.yml` だけを見ると `.yaml` で
    // 追加された定義が検査からも網羅性 assert からも同時に落ちる。
    function credentialScanTargets(): { label: string; path: string }[] {
      const workflowDir = join(process.cwd(), '.github/workflows');
      const actionDir = join(process.cwd(), '.github/actions');

      const workflows = readdirSync(workflowDir)
        .filter((file) => /\.ya?ml$/.test(file))
        .map((file) => ({ label: `workflows/${file}`, path: join(workflowDir, file) }));

      // `.github/actions/` が無い repo 状態（composite action の全廃など）で ENOENT を
      // 投げると、checkout の検査だけでなくこのファイルの全 test が collection 時に落ちる。
      // 消失自体は EXPECTED_SCAN_TARGETS の網羅性 assert が別途検出する。
      const actions = (existsSync(actionDir) ? readdirSync(actionDir, { withFileTypes: true }) : [])
        .filter((entry) => entry.isDirectory())
        .flatMap((dir) =>
          readdirSync(join(actionDir, dir.name))
            .filter((file) => /^action\.ya?ml$/.test(file))
            .map((file) => ({
              label: `actions/${dir.name}/${file}`,
              path: join(actionDir, dir.name, file),
            })),
        );

      return [...workflows, ...actions].sort((a, b) => a.label.localeCompare(b.label));
    }

    const SCAN_TARGETS = credentialScanTargets();

    // 網羅性 assert の入力。定義を足したらここも更新することになる（それが目的）。
    const EXPECTED_SCAN_TARGETS = [
      'actions/setup/action.yml',
      'workflows/ci.yml',
      'workflows/create-release.yml',
      'workflows/nightly.yml',
      'workflows/production-config-audit.yml',
      'workflows/promote.yml',
    ];

    it.each(SCAN_TARGETS.map((target) => [target.label, target.path]))(
      '%s の全 checkout が persist-credentials: false を持つ',
      (label, path) => {
        const offenders = checkoutStepsWithoutPersistFalse(readFileSync(path, 'utf8'));

        expect(offenders, `${label} の ${offenders.join(', ')} 行目の checkout が未指定`).toEqual(
          [],
        );
      },
    );

    it('検査対象が repo の全 workflow / composite action を覆っている（追加漏れの検出）', () => {
      expect(SCAN_TARGETS.map((target) => target.label)).toEqual(EXPECTED_SCAN_TARGETS);
    });

    it('未指定の checkout を検出できる（回帰確認）', () => {
      const regressed = [
        'jobs:',
        '  a:',
        '    steps:',
        '      - uses: actions/checkout@abc # v7',
        '      - uses: ./.github/actions/setup',
      ].join('\n');

      expect(checkoutStepsWithoutPersistFalse(regressed)).toEqual([4]);
    });

    it('コメント中の persist-credentials: false では通らない（偽陰性の回帰確認）', () => {
      // **コメントは checkout ブロックの内側に置く**（クロスレビュー risk-reviewer P3）。
      // 走査は checkout 行の次の行から始まるため、ブロックの外（前の行）へ置くと
      // 一度も評価されず、実装から comment-stripping を消してもこの test が通ってしまう
      // ＝ 主張している保証を証明できていない状態になる。
      const regressed = [
        'jobs:',
        '  a:',
        '    steps:',
        '      - uses: actions/checkout@abc # v7',
        '        with:',
        '          # persist-credentials: false を忘れないこと',
        '          fetch-depth: 0',
        '      - uses: ./.github/actions/setup',
      ].join('\n');

      expect(checkoutStepsWithoutPersistFalse(regressed)).toEqual([4]);
    });

    it('quote した uses の未指定 checkout を検出できる（#2557 穴 2 の回帰確認）', () => {
      // 旧 regex（`uses:\s*actions\/checkout@`）は quote した値に非一致で、
      // 未指定のまま it.each と網羅性 assert の両方を素通りしていた。
      const regressed = [
        'jobs:',
        '  a:',
        '    steps:',
        "      - uses: 'actions/checkout@abc' # v7",
        '      - uses: "actions/checkout@abc"',
        '        with:',
        '          persist-credentials: false',
      ].join('\n');

      expect(checkoutStepsWithoutPersistFalse(regressed)).toEqual([4]);
    });

    it('composite action 定義も走査対象に入っている（#2557 穴 1 の回帰確認）', () => {
      // 走査が `.github/workflows/` 直下だけだった頃は、`.github/actions/setup/action.yml`
      // へ checkout を 1 step 足すと未指定でも it.each の対象外・網羅性 assert も green
      // のまま通った。composite action は呼び出し元 job の token 権限で走るため、
      // ci.yml unit job（`pull-requests: write`）経由で同じ露出が復活する。
      expect(SCAN_TARGETS.map((target) => target.label)).toContain('actions/setup/action.yml');

      const regressed = [
        'runs:',
        '  using: composite',
        '  steps:',
        '    - uses: actions/checkout@abc',
      ].join('\n');

      expect(checkoutStepsWithoutPersistFalse(regressed)).toEqual([4]);
    });
  });

  // ── 検出力の確認（上の assert が「たまたま通っている」のではないこと）──
  describe('回帰確認', () => {
    it('jobDisplayNames は `\\UXXXXXXXX` 記法を実際の絵文字へ復元する', () => {
      const yaml = ['jobs:', '  unit:', '    name: "\\U0001F4E6 Unit Tests"'].join('\n');

      expect(jobDisplayNames(yaml)).toEqual(['📦 Unit Tests']);
    });

    it('workflow を跨いだ同名 job を重複として検出できる', () => {
      const regressed = ['jobs:', '  e2e:', '    name: "\\U0001F3AD E2E Tests"'].join('\n');
      const all = [...jobDisplayNames(regressed), ...promoteNames];

      expect(all.filter((name, index) => all.indexOf(name) !== index)).toEqual(['🎭 E2E Tests']);
    });

    it('VS16 付きの job 名を検出できる', () => {
      const regressed = ['jobs:', '  integration:', '    name: "🗄️ Integration Tests"'].join('\n');

      expect(jobDisplayNames(regressed)[0]).toContain('️');
    });

    it('実ファイルから名前を 1 つ以上抜けている（regex の空振りで全 assert が素通りしない）', () => {
      expect(ciNames.length).toBe(4);
      expect(nightlyNames.length).toBeGreaterThanOrEqual(3);
      expect(promoteNames.length).toBe(5);
    });
  });
});
