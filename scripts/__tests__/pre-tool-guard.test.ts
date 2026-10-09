import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// security guard の test は、正常系の確認ではなく **敵対的な試行を先に列挙する**。
// 「許可すべき形が通る / 明らかに違う形が落ちる」だけを書くと、境界の 1 文字ずらし・
// 区切りの省略・類似名が抜ける。実際 2026-08-11 に guard の正規表現へ 2 回続けて
// 穴が空き（basename 判定、optional group による区切りの任意化）、どちらもこの
// file の test では捕まらず外部レビューが見つけた。判定を足す時は、
// まず「どう書けば通ってしまうか」を数え上げてから allow 側を書く。
//
// guard 実装側の対の教訓は「許可形を省略記法で組み立てず選択肢で列挙する」
// （scripts/hooks/pre-tool-guard-rules.mjs のコメント参照）。
//
// このファイルは scripts/__tests__/pre-tool-guard.test.ts（bash 版 guard の
// contract test）の Node/ESM 移植。各 describe/it の意図と assert は元ファイル
// と同一に保つ——変えたのは spawn 対象（bash loader → node loader）と、bash の
// 構文エラー・exit code を前提にしていた「script 自体の健全性」「loader/rules
// 分離」の 2 describe block だけ（Node の import 失敗・例外送出へ書き換えた）。
const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
// pre-tool-guard.mjs は薄い loader（bash 版 #1961 の教訓を踏襲した Node/ESM
// 移植）。実際のロジックは pre-tool-guard-rules.mjs にある（settings.json の
// hooks 登録も同じ PR でこの loader へ切り替え済み。通常の test はすべて
// loaderPath 経由で書ける）。
const loaderPath = resolve(rootDir, 'scripts/hooks/pre-tool-guard.mjs');
const rulesPath = resolve(rootDir, 'scripts/hooks/pre-tool-guard-rules.mjs');

type Decision = 'block' | 'allow';

function runGuard(
  input: Record<string, unknown>,
  cwd: string = rootDir,
  env?: Record<string, string>,
): Decision {
  const result = spawnSync(process.execPath, [loaderPath], {
    cwd,
    encoding: 'utf8',
    input: JSON.stringify(input),
    env: env ? { ...process.env, ...env } : process.env,
  });
  return result.status === 2 ? 'block' : 'allow';
}

function bash(command: string): Record<string, unknown> {
  return { tool_name: 'Bash', tool_input: { command } };
}

function readTool(filePath: string): Record<string, unknown> {
  return { tool_name: 'Read', tool_input: { file_path: filePath } };
}

// setup が黙って失敗すると、以降の assert が「たまたま通る」形で緑になる。
// 失敗は即座に投げる。
function git(args: string[], cwd: string): void {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${result.stderr}`);
  }
}

// 対象 path を commit して origin/main へ push し、`refs/remotes/origin/main` を生やす。
// migration ガードの「適用済み」判定はこの ref を見る（#2185）。
function commitAndPush(cwd: string, ...paths: string[]): void {
  git(['add', '--', ...paths], cwd);
  git(['-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '-m', 'm'], cwd);
  git(['push', '-q', 'origin', 'HEAD:main'], cwd);
}

// commit だけして push しない（origin/main には載らない）。
function commitOnly(cwd: string, ...paths: string[]): void {
  git(['add', '--', ...paths], cwd);
  git(['-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '-m', 'local'], cwd);
}

function write(filePath: string, content = ''): Record<string, unknown> {
  return { tool_name: 'Write', tool_input: { file_path: filePath, content } };
}

function edit(filePath: string, newString = ''): Record<string, unknown> {
  return { tool_name: 'Edit', tool_input: { file_path: filePath, new_string: newString } };
}

// #2334（同乗タスク、P3）: MultiEdit は edits[].new_string、NotebookEdit は
// new_source に書き込み内容が入る。impl の抽出 jq（WRITTEN 変数）が両方を
// 拾えていることを block 側で固定する。
function multiEdit(filePath: string, newStrings: string[]): Record<string, unknown> {
  return {
    tool_name: 'MultiEdit',
    tool_input: { file_path: filePath, edits: newStrings.map((new_string) => ({ new_string })) },
  };
}

function notebookEdit(notebookPath: string, newSource: string): Record<string, unknown> {
  return {
    tool_name: 'NotebookEdit',
    tool_input: { notebook_path: notebookPath, new_source: newSource },
  };
}

// guard 自体が壊れると全 tool がブロックされ、guard を直す編集まで塞がれる。
// bash 版は 2026-08-12 に実際に起きた（[[ ]] の中へ引用符入りの正規表現を
// 直接書いて構文エラーになり、Bash / Write / Edit がすべて拒否されて別
// セッションからの復旧が必要になった、#1961）。Node/ESM 版でも同じ class の
// 障害モードが起きる: `import()` は構文エラーを持つモジュールを読み込めない
// （import 自体が reject し、モジュール内のどんなコードも実行されない）。
// エディタ上の規律ではなく test で固定する。
describe('pre-tool-guard.mjs: script 自体の健全性', () => {
  it('loader の構文チェックを通る（node --check）', () => {
    const result = spawnSync(process.execPath, ['--check', loaderPath], { encoding: 'utf8' });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  it('rules の構文チェックを通る（node --check）', () => {
    const result = spawnSync(process.execPath, ['--check', rulesPath], { encoding: 'utf8' });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });
});

// #1961 の Node 移植: guard 自体（rules）が壊れた時、loader は fail closed を
// 既定にしつつ、**rules ファイル自身への Write/Edit だけ**を復旧目的で例外的に
// 通す。1 ファイル構成では自己検査コードごと構文エラーで実行されなくなるため、
// loader/rules の 2 ファイル分離だけがこの中間案を実装できる（bash 版 #1961
// コメント参照）。
//
// bash 版との対応: 「impl の構文エラー」→「rules の import 失敗」、
// 「impl の構文は健全だが非 0 exit」→「rules の import は成功するが evaluate()
// が例外を投げる」。loader はどちらも「import/評価に成功して decision が
// 'allow' の時だけ 0、それ以外は全部 2」という同じ fail-closed 規則で捌く。
describe('pre-tool-guard.mjs: loader/rules 分離（#1961 の Node 移植）', () => {
  let fixtureRoot: string;
  let healthyLoader: string;
  let degradedLoader: string;
  let degradedRules: string;
  let badExitLoader: string;
  let badExitRules: string;
  let renamedLoader: string;
  let renamedRules: string;
  let throwingDecisionLoader: string;
  let symlinkedLoader: string;
  let symlinkedRules: string;

  beforeAll(() => {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'pre-tool-guard-loader-'));

    // loader は import('./pre-tool-guard-rules.mjs') で自分と同じディレクトリの
    // rules を見る。rules は node 標準ライブラリ（node:child_process / node:fs /
    // node:path）しか import しない——復旧経路（rules 自身への Write だけ通す）が
    // repo 内 helper の破損で塞がらないようにするための不変条件なので、fixture も
    // loader + rules の 2 ファイルだけで組む。
    const healthyDir = join(fixtureRoot, 'healthy');
    mkdirSync(healthyDir);
    writeFileSync(join(healthyDir, 'pre-tool-guard.mjs'), readFileSync(loaderPath, 'utf8'));
    writeFileSync(join(healthyDir, 'pre-tool-guard-rules.mjs'), readFileSync(rulesPath, 'utf8'));
    healthyLoader = join(healthyDir, 'pre-tool-guard.mjs');

    const degradedDir = join(fixtureRoot, 'degraded');
    mkdirSync(degradedDir);
    writeFileSync(join(degradedDir, 'pre-tool-guard.mjs'), readFileSync(loaderPath, 'utf8'));
    // 構文エラーを注入（未閉じの関数呼び出し）。2026-08-12 の bash 実障害
    // （未閉じの [[ ）と同型の「ファイル末尾が壊れている」形。
    writeFileSync(
      join(degradedDir, 'pre-tool-guard-rules.mjs'),
      `${readFileSync(rulesPath, 'utf8')}\nfunction __brokenSyntax(x {\n`,
    );
    degradedLoader = join(degradedDir, 'pre-tool-guard.mjs');
    degradedRules = join(degradedDir, 'pre-tool-guard-rules.mjs');

    const badExitDir = join(fixtureRoot, 'bad-exit');
    mkdirSync(badExitDir);
    writeFileSync(join(badExitDir, 'pre-tool-guard.mjs'), readFileSync(loaderPath, 'utf8'));
    // import（構文）は健全だが、evaluate() が常に例外を投げる rules
    // （bash 版の「構文は健全だが実行時に想定外の非 0 を返す impl」の Node 版。
    // lib への相対 import が無くても import 自体は成立する最小 stub）。
    writeFileSync(
      join(badExitDir, 'pre-tool-guard-rules.mjs'),
      "export function evaluate() {\n  throw new Error('unexpected failure');\n}\n",
    );
    badExitLoader = join(badExitDir, 'pre-tool-guard.mjs');
    badExitRules = join(badExitDir, 'pre-tool-guard-rules.mjs');

    // import は成功するが `evaluate` が export されていない rules（編集中に export を
    // 落とした / 関数名を変えた形。Codex review P2、PR #2563）。import 失敗と同じ
    // 復旧経路に倒さないと、別セッション無しでは直せない。
    const renamedDir = join(fixtureRoot, 'renamed-export');
    mkdirSync(renamedDir);
    writeFileSync(join(renamedDir, 'pre-tool-guard.mjs'), readFileSync(loaderPath, 'utf8'));
    writeFileSync(
      join(renamedDir, 'pre-tool-guard-rules.mjs'),
      "export const renamedEvaluate = () => ({ decision: 'allow' });\n",
    );
    renamedLoader = join(renamedDir, 'pre-tool-guard.mjs');
    renamedRules = join(renamedDir, 'pre-tool-guard-rules.mjs');

    // evaluate() は返るが、その戻り値の参照（loader の `result.decision`）が例外を
    // 投げる rules。この参照は try の外側にあり、bash 版 loader が構造として持って
    // いた「0 か 2 以外を返さない」不変条件が Node では async 関数の未捕捉 rejection
    // = exit 1（harness では block ではなく non-blocking error）へ落ちる。exit 1 に
    // なると guard が判定を下せなかった操作が素通りするため fail closed が崩れる
    // （#2563 内製クロスレビュー P2）。
    const throwingDecisionDir = join(fixtureRoot, 'throwing-decision');
    mkdirSync(throwingDecisionDir);
    writeFileSync(
      join(throwingDecisionDir, 'pre-tool-guard.mjs'),
      readFileSync(loaderPath, 'utf8'),
    );
    writeFileSync(
      join(throwingDecisionDir, 'pre-tool-guard-rules.mjs'),
      "export function evaluate() {\n  return Object.defineProperty({}, 'decision', {\n    get() {\n      throw new Error('unexpected failure after evaluate');\n    },\n  });\n}\n",
    );
    throwingDecisionLoader = join(throwingDecisionDir, 'pre-tool-guard.mjs');

    // path の途中に symlink がある配置。ESM の `import.meta.url` は realpath を返す
    // 一方 harness が渡す `file_path` は解決されていないため、素の文字列比較では
    // 復旧経路が常に block へ落ちる（macOS の tmpdir は `/var` -> `/private/var` で
    // 実際にこの形。#2563 内製クロスレビュー P2、Linux CI では tmpdir が symlink で
    // ないため素通りしていた）。symlink を明示的に作って両 OS で固定する。
    const symlinkTargetDir = join(fixtureRoot, 'symlink-target');
    mkdirSync(symlinkTargetDir);
    writeFileSync(join(symlinkTargetDir, 'pre-tool-guard.mjs'), readFileSync(loaderPath, 'utf8'));
    writeFileSync(
      join(symlinkTargetDir, 'pre-tool-guard-rules.mjs'),
      `${readFileSync(rulesPath, 'utf8')}\nfunction __brokenSyntax(x {\n`,
    );
    const symlinkDir = join(fixtureRoot, 'symlink-alias');
    symlinkSync(symlinkTargetDir, symlinkDir, 'dir');
    symlinkedLoader = join(symlinkDir, 'pre-tool-guard.mjs');
    symlinkedRules = join(symlinkDir, 'pre-tool-guard-rules.mjs');
  });

  afterAll(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  function runVia(loaderFixturePath: string, input: Record<string, unknown>): Decision {
    const result = spawnSync(process.execPath, [loaderFixturePath], {
      cwd: rootDir,
      encoding: 'utf8',
      input: JSON.stringify(input),
    });
    return result.status === 2 ? 'block' : 'allow';
  }

  it('rules が健全なら loader は通常どおり委譲する（stdin forward が正しい）', () => {
    expect(runVia(healthyLoader, write('/x/.op-env.human'))).toBe('allow');
    expect(runVia(healthyLoader, write('/x/.env'))).toBe('block');
    expect(runVia(healthyLoader, bash('git status'))).toBe('allow');
  });

  it('rules が構文エラー（import 失敗）の時、無関係な Bash 操作は fail closed', () => {
    expect(runVia(degradedLoader, bash('git status'))).toBe('block');
  });

  it('rules が構文エラーの時、rules 以外への Write/Edit は fail closed', () => {
    expect(runVia(degradedLoader, write('/x/notes.md'))).toBe('block');
  });

  it('rules が構文エラーの時、rules ファイル自身への Write/Edit だけは復旧目的で通る', () => {
    expect(runVia(degradedLoader, write(degradedRules))).toBe('allow');
    expect(runVia(degradedLoader, edit(degradedRules))).toBe('allow');
  });

  it('loader 自身への Write は例外対象外（fail closed のまま）', () => {
    expect(runVia(degradedLoader, write(degradedLoader))).toBe('block');
  });

  it('rules の構文は健全でも evaluate() が例外を投げたら fail closed（exit code を 2 へ写す）', () => {
    expect(runVia(badExitLoader, bash('git status'))).toBe('block');
  });

  it('evaluate が export されていない（import は成功）時、無関係な操作は fail closed で rules 自身への Write/Edit だけ通る', () => {
    expect(runVia(renamedLoader, bash('git status'))).toBe('block');
    expect(runVia(renamedLoader, write('/x/notes.md'))).toBe('block');
    expect(runVia(renamedLoader, write(renamedRules))).toBe('allow');
    expect(runVia(renamedLoader, edit(renamedRules))).toBe('allow');
  });

  it('path の途中が symlink でも、rules 自身への Write/Edit の復旧経路は働く', () => {
    expect(runVia(symlinkedLoader, write(symlinkedRules))).toBe('allow');
    expect(runVia(symlinkedLoader, edit(symlinkedRules))).toBe('allow');
    // 例外は rules 自身に限る。symlink 経由でも他 path は fail closed のまま
    expect(runVia(symlinkedLoader, write(join(dirname(symlinkedRules), 'notes.md')))).toBe('block');
  });

  it('try の外側で例外が起きても exit 1 ではなく 2 を返す（loader は 0 か 2 以外を返さない）', () => {
    const result = spawnSync(process.execPath, [throwingDecisionLoader], {
      cwd: rootDir,
      encoding: 'utf8',
      input: JSON.stringify(bash('git status')),
    });
    expect(result.status).toBe(2);
  });

  it('evaluate() が例外を投げる時も、rules 自身への Write/Edit だけは復旧目的で通る', () => {
    expect(runVia(badExitLoader, write('/x/notes.md'))).toBe('block');
    expect(runVia(badExitLoader, write(badExitRules))).toBe('allow');
  });
});

// #1944: heredoc 本文も危険コマンド検査の対象に**残す**（誤検知を受け入れる）。
//
// 「本文はデータだから外す」を実装したが、**どの行が本当に heredoc を開いていて
// 本文がどこへ行くのかは、shell の引用状態とコマンド位置を解釈しないと決まらない。**
// 外部レビュー 3 巡で 4 通りの取りこぼしが実測で見つかり、いずれも変更前は
// ブロックできていた形が通るようになる方向だった。下の block ケース群は、
// その実測で見つかった形をそのまま回帰テストとして残したもの。
//
// force-push / reset ガードは agent 自身の逸脱を止めるためのもので、ブロック側の
// 後退は P3 の誤検知より重い。誤検知（コミットメッセージに文字列を書くと落ちる）は
// 受け入れて docs に書く。判断の記録は scripts/hooks/pre-tool-guard-rules.mjs のコメントと
// #1944 のコメント。
describe('pre-tool-guard.mjs: heredoc 本文と危険コマンド', () => {
  const heredoc = (intro: string, body: string, delim = 'EOF') => `${intro}\n${body}\n${delim}`;

  // 受け入れる誤検知。回避策は文面を変えるか、Write / Edit で file へ書いてから渡す。
  it.each([
    [
      'commit message 本文での言及',
      heredoc(
        "git commit -F - <<'EOF'",
        'fix: guard\n\ngit push --no-verify を禁止する規約に触れた',
      ),
    ],
    ['cat のリダイレクト', heredoc('cat <<EOF > /tmp/note.md', 'git push --force は禁止')],
    ['reset --hard の言及', heredoc("git commit -F - <<'EOF'", 'docs: git reset --hard の注意')],
  ])('本文での言及も落ちる（受け入れる誤検知）: %s', (_label, command) => {
    expect(runGuard(bash(command))).toBe('block');
  });

  it.each([
    ['素の force push', 'git push --force origin main'],
    ['素の no-verify', 'git push --no-verify'],
    ['セパレータ後の no-verify', 'pnpm check && git push --no-verify'],
    ['sh -c でくるむ force', 'sh -c "git push --force"'],
    ['素の reset --hard', 'git reset --hard origin/main'],
    // 以下は heredoc 除外を実装した時に「通るようになっていた」形。除外を
    // やめたので素直に落ちる。除外を再導入するなら、まずここが緑のままかを見る。
    ['heredoc を bash へ食わせる', heredoc('bash <<EOF', 'git push --no-verify')],
    ['cat heredoc を bash へ pipe', heredoc('cat <<EOF | bash', 'git reset --hard')],
    ['eval + heredoc', 'eval "$(cat <<\'EOF\'\ngit push --no-verify\nEOF\n)"'],
    ['コマンド置換 + heredoc', 'x=$(cat <<EOF\ngit reset --hard\nEOF\n)'],
    ['プロセス置換', 'bash <(cat <<EOF\ngit push --no-verify\nEOF\n)'],
    [
      '導入行の ; で後続実行',
      'cat <<EOF > /tmp/run.sh; bash /tmp/run.sh\ngit push --force origin main\nEOF',
    ],
    // consumer 名が実行コマンドではなく引数の位置にある形。実際は bash が stdin を実行する
    [
      'bash -s に consumer 名を混ぜる',
      heredoc('bash -s git <<EOF', 'git push --force origin main'),
    ],
    // 引用符やコメントの中の << は heredoc ではない。次行は普通に実行される
    ['引用文字列の中の <<EOF', 'echo "x cat <<EOF"\ngit push --force origin main\nEOF'],
    ['コメント内の <<EOF', '# cat <<EOF\ngit push --force origin main\nEOF'],
    ['heredoc の後続行', `${heredoc("git commit -F - <<'EOF'", 'msg')}\ngit push --no-verify`],
    ['here-string の後の実コマンド', 'cat <<< "x"; git push --no-verify'],
  ])('実コマンドは落とす: %s', (_label, command) => {
    expect(runGuard(bash(command))).toBe('block');
  });

  it('--force-with-lease は通す', () => {
    expect(runGuard(bash('git push --force-with-lease origin main'))).toBe('allow');
  });

  it('--hard 以外の reset は通す', () => {
    expect(runGuard(bash('git reset --soft HEAD~1'))).toBe('allow');
    expect(runGuard(bash('git reset HEAD -- notes.md'))).toBe('allow');
  });
});

// worktree 外ファイル編集ガード（2026-08-24, #2359）。
// レーンは自分の worktree 外を書き換えない（AGENTS.md §委任・報告の作法
// の writer 4 条件）。判定は resolveRoots() を
// working tree root ベースで行うため、fixture は main + 2 linked worktree で組む。
describe('pre-tool-guard.mjs: worktree 外ファイル編集ガード（#2359）', () => {
  let fixtureRoot: string;
  let mainDir: string;
  let laneADir: string;
  let laneBDir: string;
  let plainDir: string;

  beforeAll(() => {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'pre-tool-guard-boundary-'));
    mainDir = join(fixtureRoot, 'main');
    laneADir = join(fixtureRoot, 'laneA');
    laneBDir = join(fixtureRoot, 'laneB');
    plainDir = join(fixtureRoot, 'plain');
    mkdirSync(mainDir);
    mkdirSync(plainDir);
    git(['init', '-q', '.'], mainDir);
    git(
      [
        '-c',
        'user.email=t@example.com',
        '-c',
        'user.name=t',
        'commit',
        '-q',
        '--allow-empty',
        '-m',
        'init',
      ],
      mainDir,
    );
    git(['worktree', 'add', '-q', laneADir, '-b', 'laneA'], mainDir);
    git(['worktree', 'add', '-q', laneBDir, '-b', 'laneB'], mainDir);
  });

  afterAll(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  it('自分の worktree 内への Write は許可する', () => {
    expect(runGuard(write(join(laneADir, 'foo.ts')), laneADir)).toBe('allow');
  });

  it('他レーンの worktree への Write は block する', () => {
    expect(runGuard(write(join(laneBDir, 'foo.ts')), laneADir)).toBe('block');
  });

  it('他レーンの worktree への Edit も block する', () => {
    expect(runGuard(edit(join(laneBDir, 'foo.ts')), laneADir)).toBe('block');
  });

  it('他レーンの worktree への MultiEdit も block する', () => {
    expect(runGuard(multiEdit(join(laneBDir, 'foo.ts'), ['x']), laneADir)).toBe('block');
  });

  it('".." traversal で他レーンへ抜ける形も block する（prefix 比較のすり抜け対策）', () => {
    expect(runGuard(write(join(laneADir, '..', 'laneB', 'foo.ts')), laneADir)).toBe('block');
  });

  it('相対パスの file_path は block する（tool 仕様への依存を guard としては信頼しない）', () => {
    expect(runGuard(write('relative/foo.ts'), laneADir)).toBe('block');
  });

  it('repo 外（scratchpad 相当、存在しないディレクトリ）への Write は許可する', () => {
    const outside = join(fixtureRoot, 'outside-not-yet-created', 'foo.md');
    expect(runGuard(write(outside), laneADir)).toBe('allow');
  });

  it('自分の worktree 内の未存在サブディレクトリへの Write は許可する（新規ディレクトリ作成を壊さない）', () => {
    expect(runGuard(write(join(laneADir, 'new', 'nested', 'foo.ts')), laneADir)).toBe('allow');
  });

  it('main checkout から自分自身への Write は許可する', () => {
    expect(runGuard(write(join(mainDir, 'foo.ts')), mainDir)).toBe('allow');
  });

  it('main checkout から他レーンの worktree への Write は block する（Main はコードを書かない）', () => {
    expect(runGuard(write(join(laneADir, 'foo.ts')), mainDir)).toBe('block');
  });

  it('git 管理外のディレクトリでは fail-open（Write/Edit は高頻度操作のため）', () => {
    expect(runGuard(write('/tmp/anywhere/foo.ts'), plainDir)).toBe('allow');
  });
});

// symlink 経由の別名で保護境界が外れないこと（2026-09-05, #2566）。
//
// 保護判定（.env 系 / 既存 migration / local dev env-file）が **生の file_path の
// 文字列一致**だった頃は、`ln -s .env tmp/foo` のように保護対象を指す symlink を
// 1 本置けば、basename が `.env` で終わらないので判定を素通りし、書き込みは実体の
// `.env` へ着地した。`.env` / `.env.local` は AGENTS.md §Non-Negotiables で
// 「読みも書きもしない」と定めた境界で、その機械強制が symlink 1 本で外れていた。
//
// fixture は worktree 境界ガードを通すために git repo として作る（repo 外への
// Write は worktree 境界の側で落ちてしまい、保護判定を証明できないため）。
// 「無関係な symlink は allow のまま」も併せて固定し、誤検知が増えていないことを示す。
describe('pre-tool-guard.mjs: symlink 経由の保護ファイル判定（#2566）', () => {
  let fixtureRoot: string;
  let repoDir: string;
  let migrationPath: string;

  beforeAll(() => {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'pre-tool-guard-symlink-'));
    repoDir = join(fixtureRoot, 'repo');
    mkdirSync(repoDir);
    git(['init', '-q', '.'], repoDir);
    git(
      [
        '-c',
        'user.email=t@example.com',
        '-c',
        'user.name=t',
        'commit',
        '-q',
        '--allow-empty',
        '-m',
        'init',
      ],
      repoDir,
    );
    // migration 判定は origin/main 基準になった（#2185）。この describe が証明したいのは
    // 「symlink 別名でも保護判定が外れない」ことなので、origin/main 不在による
    // fail-closed で block が出る状態にはしない（それでは symlink 解決が壊れても緑になる）。
    const remoteDir = join(fixtureRoot, 'remote.git');
    git(['init', '-q', '--bare', remoteDir], fixtureRoot);
    git(['remote', 'add', 'origin', remoteDir], repoDir);

    // 実体（保護対象）
    writeFileSync(join(repoDir, '.env'), 'SECRET=1\n');
    writeFileSync(join(repoDir, '.env.local'), 'SECRET=2\n');
    writeFileSync(join(repoDir, 'notes.md'), '');
    mkdirSync(join(repoDir, 'supabase', 'migrations'), { recursive: true });
    migrationPath = join(repoDir, 'supabase', 'migrations', '20260101000000_init.sql');
    writeFileSync(migrationPath, 'select 1;\n');
    commitAndPush(repoDir, 'supabase/migrations/20260101000000_init.sql');

    // 保護対象を指す別名（basename からは保護対象と分からない形）
    mkdirSync(join(repoDir, 'tmp'));
    symlinkSync(join(repoDir, '.env'), join(repoDir, 'tmp', 'alias-a'), 'file');
    symlinkSync(join(repoDir, '.env.local'), join(repoDir, 'tmp', 'alias-b'), 'file');
    symlinkSync(migrationPath, join(repoDir, 'tmp', 'alias-d'), 'file');
    symlinkSync(join(repoDir, 'notes.md'), join(repoDir, 'tmp', 'alias-e'), 'file');
  });

  afterAll(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  it('.env / .env.local の Read は block し、通常ファイルの Read は通す', () => {
    expect(runGuard(readTool(join(repoDir, '.env')), repoDir)).toBe('block');
    expect(runGuard(readTool(join(repoDir, '.env.local')), repoDir)).toBe('block');
    expect(runGuard(readTool(join(repoDir, 'tmp', 'alias-a')), repoDir)).toBe('block');
    expect(runGuard(readTool(join(repoDir, 'notes.md')), repoDir)).toBe('allow');
  });

  it('直接 path での .env / .env.local への Write は従来どおり block（回帰確認）', () => {
    expect(runGuard(write(join(repoDir, '.env')), repoDir)).toBe('block');
    expect(runGuard(write(join(repoDir, '.env.local')), repoDir)).toBe('block');
  });

  it('.env を指す symlink への Write を block する', () => {
    expect(runGuard(write(join(repoDir, 'tmp', 'alias-a')), repoDir)).toBe('block');
  });

  it('.env.local を指す symlink への Write を block する', () => {
    expect(runGuard(write(join(repoDir, 'tmp', 'alias-b')), repoDir)).toBe('block');
  });

  it('.env を指す symlink への Edit / MultiEdit / NotebookEdit も block する', () => {
    const alias = join(repoDir, 'tmp', 'alias-a');
    expect(runGuard(edit(alias), repoDir)).toBe('block');
    expect(runGuard(multiEdit(alias, ['x']), repoDir)).toBe('block');
    expect(runGuard(notebookEdit(alias, 'x'), repoDir)).toBe('block');
  });

  it('origin/main に載っている migration を指す symlink への Write も block する', () => {
    expect(runGuard(write(join(repoDir, 'tmp', 'alias-d')), repoDir)).toBe('block');
  });

  it('保護対象でないファイルを指す symlink は allow のまま（誤検知を増やしていない）', () => {
    expect(runGuard(write(join(repoDir, 'tmp', 'alias-e')), repoDir)).toBe('allow');
  });

  it('symlink でない通常ファイルへの Write は allow のまま', () => {
    expect(runGuard(write(join(repoDir, 'notes.md')), repoDir)).toBe('allow');
    expect(runGuard(write(join(repoDir, 'new', 'nested', 'foo.ts')), repoDir)).toBe('allow');
  });
});

// 逆向きの symlink（保護対象の**名前**が非保護名の実体を指す）(#2566 の 2 巡目レビュー P2)。
//
// #2566 の修正を「raw path の判定を canonical path の判定へ**置き換える**」形で書くと、
// `.env` / `.env.local` 自身を symlink にしている checkout（env を 1 箇所へ集約する構成）で、
// 実体側の名前が保護パターンに当たらないため `.env` への Write が素通りする。
// 判定は raw と canonical の**両方**で行う（どちらかが当たれば block）。
//
// `.claude/settings.json` の `permissions.deny` は `Read(**/.env*)` しか持たず Write を
// 塞いでいないため、AGENTS.md §Non-Negotiables の書き込み禁止はこの guard が唯一の強制。
describe('pre-tool-guard.mjs: 保護対象の名前が非保護名の実体を指す symlink（#2566）', () => {
  let fixtureRoot: string;
  let repoDir: string;

  beforeAll(() => {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'pre-tool-guard-reverse-symlink-'));
    repoDir = join(fixtureRoot, 'repo');
    mkdirSync(repoDir);
    git(['init', '-q', '.'], repoDir);
    git(
      [
        '-c',
        'user.email=t@example.com',
        '-c',
        'user.name=t',
        'commit',
        '-q',
        '--allow-empty',
        '-m',
        'init',
      ],
      repoDir,
    );

    // 実体は保護対象の名前を持たない
    mkdirSync(join(repoDir, 'secrets'));
    writeFileSync(join(repoDir, 'secrets', 'dev-config'), 'SECRET=1\n');
    writeFileSync(join(repoDir, 'secrets', 'creds'), 'SECRET=2\n');
    symlinkSync(join(repoDir, 'secrets', 'dev-config'), join(repoDir, '.env'), 'file');
    symlinkSync(join(repoDir, 'secrets', 'creds'), join(repoDir, '.env.local'), 'file');

    // dangling symlink（実体がまだ存在しない `.env` を指す別名）
    mkdirSync(join(repoDir, 'tmp'));
    symlinkSync(join(repoDir, 'not-created-yet', '.env'), join(repoDir, 'tmp', 'dangling'), 'file');
  });

  afterAll(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  it('.env 自体が非保護名の実体を指す symlink でも Write を block する', () => {
    expect(runGuard(write(join(repoDir, '.env')), repoDir)).toBe('block');
  });

  it('.env.local 自体が非保護名の実体を指す symlink でも Write を block する', () => {
    expect(runGuard(write(join(repoDir, '.env.local')), repoDir)).toBe('block');
  });

  it('実体が未作成の .env を指す dangling symlink への Write も block する', () => {
    // realpathSync は途中で ENOENT になると何も返さないため、lstat + readlink で
    // 手で辿らないと link 先が見えず素通りする。
    expect(runGuard(write(join(repoDir, 'tmp', 'dangling')), repoDir)).toBe('block');
  });

  it('実体（非保護名）へ直接書くのは allow のまま（誤検知を増やしていない）', () => {
    expect(runGuard(write(join(repoDir, 'secrets', 'dev-config')), repoDir)).toBe('allow');
  });
});

// nested 配置（このリポジトリの実際の運用: worktree は main の配下の
// `.claude/worktrees/<name>` に nested される）専用の fixture。
// merge 前クロスレビュー risk-reviewer 指摘: sibling 配置の fixture（上の
// describe）だけでは「Main（CURRENT_ROOT = 家系の親）から見ると、他
// レーンのパスも $GUARD_CURRENT_ROOT/* に該当してしまい先に許可側へ倒れる」
// class を検出できない。longest-prefix-match で修正済み（guard_path_belongs_to_current_root）。
describe('pre-tool-guard.mjs: worktree 外ファイル編集ガード（nested 配置、#2359）', () => {
  let fixtureRoot: string;
  let mainDir: string;
  let laneBDir: string;

  beforeAll(() => {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'pre-tool-guard-nested-'));
    mainDir = join(fixtureRoot, 'main');
    laneBDir = join(mainDir, '.claude', 'worktrees', 'laneB');
    mkdirSync(mainDir);
    git(['init', '-q', '.'], mainDir);
    git(
      [
        '-c',
        'user.email=t@example.com',
        '-c',
        'user.name=t',
        'commit',
        '-q',
        '--allow-empty',
        '-m',
        'init',
      ],
      mainDir,
    );
    mkdirSync(join(mainDir, '.claude', 'worktrees'), { recursive: true });
    git(['worktree', 'add', '-q', laneBDir, '-b', 'laneB'], mainDir);
  });

  afterAll(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  it('main checkout から自分自身への Write は許可する', () => {
    expect(runGuard(write(join(mainDir, 'foo.ts')), mainDir)).toBe('allow');
  });

  it('main checkout から nested な他レーンへの Write は block する', () => {
    expect(runGuard(write(join(laneBDir, 'foo.ts')), mainDir)).toBe('block');
  });

  it('nested レーンから自分自身への Write は許可する', () => {
    expect(runGuard(write(join(laneBDir, 'foo.ts')), laneBDir)).toBe('allow');
  });

  it('nested レーンから main への Write は block する', () => {
    expect(runGuard(write(join(mainDir, 'foo.ts')), laneBDir)).toBe('block');
  });
});

// rm -rf 系（2026-08-24, #2359）。危険なシェイプの列挙（他 worktree 名を数え
// 上げる等）ではなく、worktree 外へ抜けうる対象の指標（絶対パス起動・`~`・
// 変数展開・`..`）で判定する（AGENTS.md §PR / git 運用 §同型指摘の打ち切り
// 「denylist をやめて allowlist にする」）。worktree 内で完結する日常的な
// キャッシュ削除は通す。
describe('pre-tool-guard.mjs: rm -rf 系（#2359）', () => {
  it.each([
    ['rm -rf node_modules', 'rm -rf node_modules'],
    ['rm -rf .next', 'rm -rf .next'],
    ['rm -rf apps/product/.next tsbuildinfo', 'rm -rf apps/product/.next tsbuildinfo'],
    ['非recursive の rm', 'rm /tmp/foo'],
  ])('worktree 内で完結する形は通す: %s', (_label, cmd) => {
    expect(runGuard(bash(cmd))).toBe('allow');
  });

  it.each([
    ['".." traversal', 'rm -rf ../other-lane'],
    ['".." のみ', 'rm -rf ..'],
    ['$HOME 参照', 'rm -rf $HOME/Desktop'],
    ['~ 参照', 'rm -rf ~/Desktop/dayopt/apps'],
    ['変数展開', 'rm -rf $VAR'],
    ['-r（force なし）でも traversal なら block', 'rm -r ../other-lane'],
    ['同一 segment 内の変数展開（区切りあり）', 'rm -rf $VAR && echo hi'],
  ])('worktree 外を指しうる対象は block する: %s', (_label, cmd) => {
    expect(runGuard(bash(cmd))).toBe('block');
  });

  it('binary path 前置（/bin/rm）+ 相対パス target は通す', () => {
    expect(runGuard(bash('/bin/rm -rf .next'))).toBe('allow');
  });

  // 回帰テスト（DoD 動作確認中に自己検出）: escape-target 判定をコマンド全体で
  // 見ると、rm と無関係な別 segment の `$` が誤って block を引き起こしていた
  // （`rm -rf <安全な相対パス> && echo "done: $?"` が block される事故）。
  // 判定は rm を含む segment（; & | で区切った 1 文）に限定する。
  it('rm と無関係な別 segment の $ では誤 block しない（絶対パス、family 外）', () => {
    expect(runGuard(bash('rm -rf /tmp/scratch-dir && echo "done: $?"'))).toBe('allow');
  });

  it('rm と無関係な別 segment の $ では誤 block しない（安全な相対パス）', () => {
    expect(runGuard(bash('rm -rf .next && echo "done: $?"'))).toBe('allow');
  });
});

// rm -rf の絶対パス target と家系判定（2026-08-24, #2359）。
// merge 前クロスレビュー P2 是正: block メッセージは「相対パスのみ許可」と
// 宣言していたのに実装は絶対パスを見ておらず素通りしていた。
// 直後の risk-reviewer 指摘: 単純な「絶対パスは全部 block」だと scratchpad
// 掃除（family 外の絶対パス）まで壊れる。guard_resolve_roots の家系 root と
// 突合し、**自分以外の worktree root に属する時だけ** block する。
describe('pre-tool-guard.mjs: rm -rf の絶対パス target（家系判定、#2359）', () => {
  let fixtureRoot: string;
  let mainDir: string;
  let laneBDir: string;
  let outsideDir: string;

  beforeAll(() => {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'pre-tool-guard-rm-abs-'));
    mainDir = join(fixtureRoot, 'main');
    laneBDir = join(mainDir, '.claude', 'worktrees', 'laneB');
    outsideDir = join(fixtureRoot, 'scratchpad-like');
    mkdirSync(mainDir);
    mkdirSync(outsideDir);
    git(['init', '-q', '.'], mainDir);
    git(
      [
        '-c',
        'user.email=t@example.com',
        '-c',
        'user.name=t',
        'commit',
        '-q',
        '--allow-empty',
        '-m',
        'init',
      ],
      mainDir,
    );
    mkdirSync(join(mainDir, '.claude', 'worktrees'), { recursive: true });
    git(['worktree', 'add', '-q', laneBDir, '-b', 'laneB'], mainDir);
  });

  afterAll(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  it('family 外（scratchpad 相当）の絶対パスへの rm -rf は許可する', () => {
    expect(runGuard(bash(`rm -rf ${outsideDir}/subdir`), mainDir)).toBe('allow');
  });

  it('自分自身の絶対パスへの rm -rf は許可する', () => {
    expect(runGuard(bash(`rm -rf ${mainDir}/node_modules`), mainDir)).toBe('allow');
  });

  it('main checkout から nested な他 worktree への絶対パス rm -rf は block する', () => {
    expect(runGuard(bash(`rm -rf ${laneBDir}`), mainDir)).toBe('block');
  });

  it('レーンから main への絶対パス rm -rf は block する', () => {
    expect(runGuard(bash(`rm -rf ${mainDir}`), laneBDir)).toBe('block');
  });

  // desktop app の worktree session では hook の process が main checkout を cwd に起動し、
  // session の作業先は入力の cwd にだけ現れる（2026-10-09 実測、#3053）。
  describe('hook 入力の cwd が process の cwd より優先される', () => {
    const withCwd = (input: Record<string, unknown>, cwd: string) => ({ ...input, cwd });

    it('入力の cwd の worktree への Write と rm -r は通す', () => {
      expect(runGuard(withCwd(write(join(laneBDir, 'notes.md')), laneBDir), mainDir)).toBe('allow');
      expect(runGuard(withCwd(bash(`rm -rf ${laneBDir}/node_modules`), laneBDir), mainDir)).toBe(
        'allow',
      );
    });

    it('入力の cwd から見た他の worktree への Write と rm -r は block する', () => {
      expect(runGuard(withCwd(write(join(mainDir, 'notes.md')), laneBDir), mainDir)).toBe('block');
      expect(runGuard(withCwd(bash(`rm -rf ${mainDir}/.claude`), laneBDir), mainDir)).toBe('block');
    });

    it('入力の cwd が実在しない時は process の cwd で判定する', () => {
      expect(
        runGuard(withCwd(write(join(laneBDir, 'notes.md')), '/nonexistent/dir'), mainDir),
      ).toBe('block');
    });
  });
});

// supabase db reset の生呼び出し block（2026-08-24, #2359）。ローカル Supabase
// は複数 worktree セッションが共有する単一インスタンスのため、reset は他
// レーンの進行中データも巻き戻す。CLAUDE.md Commands に明記された既定コマンド
// （pnpm db:reset / db:fresh）は対象外にし、生の CLI 呼び出しだけを block する。
describe('pre-tool-guard.mjs: supabase db reset の生呼び出し（#2359）', () => {
  it.each([
    ['supabase db reset', 'supabase db reset'],
    ['npx 経由', 'npx supabase db reset --local'],
    // pnpm exec / pnpm dlx（merge 前クロスレビュー P3 是正: npx を列挙した
    // 以上、同じ粒度の兄弟実行ラッパーだけ抜けているのは片手落ち）
    ['pnpm exec 経由', 'pnpm exec supabase db reset'],
    ['pnpm dlx 経由', 'pnpm dlx supabase db reset'],
  ])('生の CLI 呼び出しは block する: %s', (_label, cmd) => {
    expect(runGuard(bash(cmd))).toBe('block');
  });

  it.each([
    ['pnpm db:reset', 'pnpm db:reset'],
    ['pnpm db:fresh', 'pnpm db:fresh'],
  ])('既定コマンド（pnpm wrapper）は通す: %s', (_label, cmd) => {
    expect(runGuard(bash(cmd))).toBe('allow');
  });
});

// git commit --no-verify（2026-08-24, #2359）。pre-commit に gitleaks が乗った
// ため、既存の git push --no-verify block を commit にも拡張する。短縮形 `-n`
// は tail -n / grep -n 等との誤検知リスクが高いため対象外にする
// （既存の --no-verify トレードオフとは非対称）。
describe('pre-tool-guard.mjs: git commit --no-verify（#2359）', () => {
  it('長形式 --no-verify は block する', () => {
    expect(runGuard(bash('git commit -m "x" --no-verify'))).toBe('block');
  });

  it('短縮形 -n は意図的に対象外（既知のギャップ）', () => {
    expect(runGuard(bash('git commit -n'))).toBe('allow');
  });

  it('コミットメッセージ本文の "-n" 相当の文字列で誤検知しない', () => {
    expect(runGuard(bash('git commit -m "tail -n 5 output"'))).toBe('allow');
  });

  it('git push -n（dry-run、別意味）は対象外のまま', () => {
    expect(runGuard(bash('git push -n origin main'))).toBe('allow');
  });

  it('git push --no-verify は既存どおり block する（回帰確認）', () => {
    expect(runGuard(bash('git push --no-verify origin foo'))).toBe('block');
  });
});

// #2293: agent-ops secret 露出の出力段 redaction。過去 4 件の露出 incident
// （07-22 Vercel CLI token / 08-11 Supabase branches credential / 08-11
// Turnstile secret via Management API ×2）はいずれも「生表示 command を
// denylist keyword や部分一致フィルタで塞ごうとして漏れた」class。本節は
// denylist の穴埋めではなく、危険な command shape そのものを block し、
// field allowlist projection を持つ安全な代替（scripts/agent/supabase-mgmt-safe-get.mjs
// 等）へ一本化する構造の contract を固定する。
describe('pre-tool-guard.mjs: #2293 op item get の --reveal / --format=json', () => {
  it('--reveal を伴うと落ちる（concealed field の実値が出力される）', () => {
    expect(runGuard(bash('op item get "human/supabase" --fields password --reveal'))).toBe('block');
  });

  it('--format=json を伴うと --reveal なしでも落ちる（1Password CLI は --reveal と無関係に .value へ実値を含める仕様）', () => {
    expect(runGuard(bash('op item get "human/supabase" --format=json'))).toBe('block');
  });

  it('--format json（空白区切り）でも落ちる', () => {
    expect(runGuard(bash('op item get "human/supabase" --format json'))).toBe('block');
  });

  it('OP_FORMAT=json 環境変数指定でも落ちる', () => {
    expect(runGuard(bash('OP_FORMAT=json op item get "human/supabase"'))).toBe('block');
  });

  it('quote された --reveal でも落ちる（raw+unquoted 2 写し評価）', () => {
    expect(runGuard(bash(`op item get 'human/supabase' --fields password '--reveal'`))).toBe(
      'block',
    );
  });

  it('既定の human-readable 形式・--reveal なしは通す（concealed field は masked のまま出る）', () => {
    expect(runGuard(bash('op item get "human/supabase" --fields password'))).toBe('allow');
  });

  it('存在確認（--vault のみ）は通す', () => {
    expect(runGuard(bash('op item get "human/supabase" --vault human'))).toBe('allow');
  });
});

describe('pre-tool-guard.mjs: #2293 Supabase Management API secret endpoint（08-11 incident 再現 ×2）', () => {
  it('08-11 incident 1 の実行形（config/auth への直接 curl）は落ちる', () => {
    expect(
      runGuard(
        bash(
          'curl -s "https://api.supabase.com/v1/projects/ref/config/auth" -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN"',
        ),
      ),
    ).toBe('block');
  });

  it('jq allowlist 射影を挟んでも落ちる（jq 形状の妥当性は検証しない設計）', () => {
    expect(
      runGuard(
        bash(
          'curl -s "https://api.supabase.com/v1/projects/ref/config/auth" | jq \'{security_captcha_enabled}\'',
        ),
      ),
    ).toBe('block');
  });

  it('08-11 incident 2 の実行形（branches/{id} への直接アクセス）は落ちる', () => {
    expect(
      runGuard(bash('curl -s "https://api.supabase.com/v1/branches/efqkuihquhzhuhnwvffk"')),
    ).toBe('block');
  });

  it('projects/{ref}/branches（一覧形）も落ちる', () => {
    expect(runGuard(bash('curl -s "https://api.supabase.com/v1/projects/ref/branches"'))).toBe(
      'block',
    );
  });

  it('config / branches 以外の endpoint（例: actions）は落とさない', () => {
    expect(runGuard(bash('curl -s "https://api.supabase.com/v1/projects/ref/actions"'))).toBe(
      'allow',
    );
  });

  it('無関係な host への curl は落とさない', () => {
    expect(runGuard(bash('curl -s "https://example.com/foo"'))).toBe('allow');
  });

  // push前反証レビューで発見: invoke 判定を「コマンド先頭・shell separator直後」
  // に限定していたため、`--` の後ろに空白1つで置かれる形が anchor に一致せず
  // 素通りした。本ファイルの env-file 判定が既に採用している「コマンド名では
  // なく引数で判定する（位置に依存しない）」原則に揃え、空白境界のみを要求する
  // 形へ修正した。この test はその修正の回帰防止。
  it('op run -- の後ろに空白1つで置かれた curl も落ちる（anchor 限定の抜け穴修正）', () => {
    expect(
      runGuard(
        bash(
          'op run -- curl -s "https://api.supabase.com/v1/projects/ref/config/auth" -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN"',
        ),
      ),
    ).toBe('block');
  });

  // merge前クロスレビュー（risk-reviewer / behavior-verifier）で発見: curl|wget
  // への invoke 限定は、node fetch / python urllib のような別 HTTP client で
  // 丸ごと迂回できた。この repo は scripts/*.mjs を書くのが日常 idiom で、
  // agent が同型 one-liner を書く動機は自然にある（安全な代替経路自体が
  // Node wrapper のため）。08-11 の denylist keyword 漏れと同じ「点を塞ぐ」
  // 形だった。curl|wget 限定を外し、endpoint 文字列（host + path）の言及
  // だけで無条件 block する設計へ変更した。
  it('curl|wget 以外の HTTP client（node fetch）でも落ちる（invoke 限定を外した修正の回帰防止）', () => {
    expect(
      runGuard(
        bash(
          "node -e \"fetch('https://api.supabase.com/v1/projects/ref/config/auth',{headers:{Authorization:'Bearer '+process.env.SUPABASE_ACCESS_TOKEN}}).then(r=>r.json()).then(console.log)\"",
        ),
      ),
    ).toBe('block');
  });

  it('python3 urllib でも落ちる', () => {
    expect(
      runGuard(
        bash(
          'python3 -c "import urllib.request; urllib.request.urlopen(\'https://api.supabase.com/v1/branches/x\')"',
        ),
      ),
    ).toBe('block');
  });

  it('httpie（http コマンド）でも落ちる', () => {
    expect(runGuard(bash('http GET https://api.supabase.com/v1/projects/ref/config/auth'))).toBe(
      'block',
    );
  });

  // merge前クロスレビューで発見: 絶対パス起動（/usr/bin/curl 等）は invoke 判定の
  // 境界集合に `/` が無く素通りしていた。curl|wget 限定を外した上記修正により、
  // curl 自体はもはや invoke 判定を経由しない（endpoint 文字列だけで block する）
  // ため、この class は自動的に閉じている。回帰防止として残す。
  it('絶対パス起動の curl も落ちる（invoke 限定撤廃により自動的に閉じる）', () => {
    expect(
      runGuard(bash('/usr/bin/curl -s https://api.supabase.com/v1/projects/ref/config/auth')),
    ).toBe('block');
  });
});

describe('pre-tool-guard.mjs: #2293 op read（--reveal 相当の masking を持たず、例外なく block）', () => {
  it('redirect なしの op read は落ちる', () => {
    expect(runGuard(bash('op read "op://human/supabase/SUPABASE_SECRET_KEY"'))).toBe('block');
  });

  it('後続コマンドと ; で連結しても落ちる', () => {
    expect(runGuard(bash('op read "op://human/supabase/SUPABASE_SECRET_KEY" && echo done'))).toBe(
      'block',
    );
  });

  // 当初は `>/dev/null` への破棄 redirect があれば通す設計だったが、push前
  // 反証レビューで2つの穴が見つかった: ① `2>/dev/null`（stderr破棄）が文字列
  // として `>/dev/null` を含むため誤って許可側に倒れ、stdout の実値はそのまま
  // 出力される ② 複数出現する場合、コマンド全体に1回でも `/dev/null` があれば
  // 全体を許可してしまい、redirect の無い方が漏れる。例外を作らず無条件で
  // block する設計へ変更した（接続確認は (a) の既定 masked 出力で代替できる）。
  it('stdout への破棄 redirect（>/dev/null）があっても、例外なく落ちる（設計変更）', () => {
    expect(
      runGuard(bash('op read "op://human/supabase/SUPABASE_SECRET_KEY" >/dev/null && echo OK')),
    ).toBe('block');
  });

  it('stderr のみの破棄（2>/dev/null）は stdout の実値を隠さない（旧設計の穴の回帰防止）', () => {
    expect(runGuard(bash('op read "op://human/supabase/SUPABASE_SECRET_KEY" 2>/dev/null'))).toBe(
      'block',
    );
  });

  it('複数の op read が混在し、片方だけ redirect されていても両方落ちる（旧設計の穴の回帰防止）', () => {
    expect(
      runGuard(
        bash('op read "op://human/supabase/A" && op read "op://human/supabase/B" >/dev/null'),
      ),
    ).toBe('block');
  });

  it('op run -- の後ろに空白1つで置かれた op read も落ちる（anchor 限定の抜け穴修正）', () => {
    expect(runGuard(bash('op run -- op read "op://human/supabase/SUPABASE_SECRET_KEY"'))).toBe(
      'block',
    );
  });

  // merge前クロスレビューで発見: 絶対パス起動（/usr/local/bin/op 等）は直前の
  // 文字が `/` で境界集合 [[:space:];&|] のどれにも一致せず素通りした。
  // 境界集合に `/` を追加して修正した。
  it('絶対パス起動（/usr/local/bin/op read）でも落ちる', () => {
    expect(runGuard(bash('/usr/local/bin/op read "op://human/supabase/SUPABASE_SECRET_KEY"'))).toBe(
      'block',
    );
  });

  it('代替経路（op item get --fields、既定形式）は影響を受けない', () => {
    expect(runGuard(bash('op item get "human/supabase" --fields password'))).toBe('allow');
  });
});

describe('pre-tool-guard.mjs: migrations 配下の既存ファイル編集（#2510、.sql 限定）', () => {
  // migrations 配下ガードは「適用済み migration の書き換え」を防ぐもの。
  // 判定が prefix 一致だけだと、配下のポインタ用 markdown（CLAUDE.md）まで
  // 編集不能＋的外れなエラー案内になるため、対象を .sql に限定した。
  const existingSql = resolve(rootDir, 'supabase/migrations/00000000000000_baseline.sql');
  const pointerMd = resolve(rootDir, 'supabase/migrations/CLAUDE.md');

  it('既存 .sql への Edit は引き続き block する', () => {
    expect(runGuard(edit(existingSql, 'DROP TABLE x;'))).toBe('block');
  });

  it('既存 .sql への Write も引き続き block する', () => {
    expect(runGuard(write(existingSql, 'DROP TABLE x;'))).toBe('block');
  });

  it('配下の非 SQL（CLAUDE.md、既存）への Edit は allow する', () => {
    expect(runGuard(edit(pointerMd, 'ポインタ更新'))).toBe('allow');
  });

  it('新規 .sql の作成（未存在ファイルへの Write）は引き続き allow する', () => {
    expect(
      runGuard(write(resolve(rootDir, 'supabase/migrations/99999999999999_new.sql'), 'SELECT 1;')),
    ).toBe('allow');
  });
});

// migration ガードの「適用済み」判定を、ディスク上の存在から **origin/main の tree に
// 在るか** へ寄せた（#2185）。main へ merge された migration は production へ適用される
// ので改変を止める必要があるが、未 merge の PR ブランチにしか無い migration は
// どの共有環境にも適用されておらず、同じ PR 内で直すのは正当な操作だった。
//
// 敵対的に見た時の懸念は「判定不能を allow へ倒して guard を無力化されること」なので、
// origin/main が無い / git が動かない / path を repo 相対へ直せない、を個別に block 側で
// 固定する。**allow のケースだけでなく、これら fail-closed のケースを必ず対で置く**。
describe('pre-tool-guard.mjs: migration の適用済み判定は origin/main 基準（#2185）', () => {
  let fixtureRoot: string;
  let repoDir: string;
  let appliedSql: string;
  let localOnlySql: string;
  let uncommittedSql: string;

  beforeAll(() => {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'pre-tool-guard-migration-origin-'));
    repoDir = join(fixtureRoot, 'repo');
    mkdirSync(repoDir);
    git(['init', '-q', '.'], repoDir);
    git(
      [
        '-c',
        'user.email=t@example.com',
        '-c',
        'user.name=t',
        'commit',
        '-q',
        '--allow-empty',
        '-m',
        'init',
      ],
      repoDir,
    );
    git(['init', '-q', '--bare', join(fixtureRoot, 'remote.git')], fixtureRoot);
    git(['remote', 'add', 'origin', join(fixtureRoot, 'remote.git')], repoDir);

    mkdirSync(join(repoDir, 'supabase', 'migrations'), { recursive: true });

    // (1) origin/main に載っている = 適用済み
    appliedSql = join(repoDir, 'supabase', 'migrations', '20260101000000_applied.sql');
    writeFileSync(appliedSql, 'select 1;\n');
    commitAndPush(repoDir, 'supabase/migrations/20260101000000_applied.sql');

    // (2) ローカル commit のみ（未 push）
    localOnlySql = join(repoDir, 'supabase', 'migrations', '20260202000000_local.sql');
    writeFileSync(localOnlySql, 'select 2;\n');
    commitOnly(repoDir, 'supabase/migrations/20260202000000_local.sql');

    // (3) 未 commit
    uncommittedSql = join(repoDir, 'supabase', 'migrations', '20260303000000_wip.sql');
    writeFileSync(uncommittedSql, 'select 3;\n');

    // 未 push の migration を指す symlink（正規化後の path で判定していることの確認）
    mkdirSync(join(repoDir, 'tmp'));
    symlinkSync(uncommittedSql, join(repoDir, 'tmp', 'wip-alias'), 'file');
  });

  afterAll(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  it('origin/main に載っている migration の Edit は block する', () => {
    expect(runGuard(edit(appliedSql, 'DROP TABLE x;'), repoDir)).toBe('block');
  });

  it('origin/main に載っている migration の Write も block する', () => {
    expect(runGuard(write(appliedSql, 'DROP TABLE x;'), repoDir)).toBe('block');
  });

  it('ローカル commit のみ（未 push）の migration は allow する', () => {
    expect(runGuard(edit(localOnlySql, 'ALTER TABLE x;'), repoDir)).toBe('allow');
  });

  it('未 commit の migration は allow する', () => {
    expect(runGuard(edit(uncommittedSql, 'ALTER TABLE x;'), repoDir)).toBe('allow');
  });

  it('未 push の migration を指す symlink も allow する（正規化後の path で判定している）', () => {
    expect(runGuard(write(join(repoDir, 'tmp', 'wip-alias'), 'select 9;'), repoDir)).toBe('allow');
  });

  it('origin/main の ref が無い repo では block する（fail-closed）', () => {
    const noOriginRoot = mkdtempSync(join(tmpdir(), 'pre-tool-guard-migration-no-origin-'));
    try {
      git(['init', '-q', '.'], noOriginRoot);
      git(
        [
          '-c',
          'user.email=t@example.com',
          '-c',
          'user.name=t',
          'commit',
          '-q',
          '--allow-empty',
          '-m',
          'init',
        ],
        noOriginRoot,
      );
      mkdirSync(join(noOriginRoot, 'supabase', 'migrations'), { recursive: true });
      const sql = join(noOriginRoot, 'supabase', 'migrations', '20260101000000_x.sql');
      writeFileSync(sql, 'select 1;\n');
      expect(runGuard(edit(sql, 'DROP TABLE x;'), noOriginRoot)).toBe('block');
    } finally {
      rmSync(noOriginRoot, { recursive: true, force: true });
    }
  });

  it('git が使えない（PATH に git が無い）環境では block する（fail-closed）', () => {
    // guard は git を PATH から引く。git が引けない時に allow へ倒れると、
    // PATH を細工するだけで適用済み migration を書き換えられてしまう。
    expect(runGuard(edit(appliedSql, 'DROP TABLE x;'), repoDir, { PATH: '/nonexistent' })).toBe(
      'block',
    );
  });
});

// =====================================================================
// merge の直接実行は block しない（2026-09-13、#2640）
// =====================================================================
// #2596 で入れた `gh pr merge` / `gh api ... PUT .../pulls/<N>/merge` の block は、
// Free plan の private repo で ruleset が使えなかった時代の代替だった。2026-09-07 の
// public 化で main の ruleset（bypass actor 0）が CI red の merge を全経路で拒むため、
// guard 側の block は撤去し、ruleset を唯一の gate にした。この describe は
// 「再導入しない」ことを固定する（block に戻すなら #2640 の決定を先に覆す）。
describe('pre-tool-guard.mjs: merge の直接実行は ruleset に任せる（#2640）', () => {
  const bash = (command: string) => ({ tool_name: 'Bash', tool_input: { command } });

  it('gh pr merge を block しない', () => {
    expect(runGuard(bash('gh pr merge 2640 --merge'))).toBe('allow');
  });

  it('gh api で pulls/<N>/merge へ PUT しても block しない', () => {
    expect(
      runGuard(bash('gh api -X PUT repos/Dayopt/dayopt/pulls/2640/merge -f merge_method=merge')),
    ).toBe('allow');
  });

  it('pnpm branch:finish は引き続き通す（掃除の入口）', () => {
    expect(runGuard(bash('pnpm branch:finish 2640'))).toBe('allow');
  });
});

// PreToolUse hook の launcher（2026-09-05, #2565）。
//
// Claude Code は PreToolUse hook の **exit 2 だけ**を block と解釈し、それ以外の
// 非 0（not found = 127 を含む）は non-blocking error として tool 実行を続行する。
// settings.json に `node scripts/hooks/pre-tool-guard.mjs` と書いていた頃は hook の
// 起動が `node` の PATH 解決に依存し、解決できない実行コンテキストでは全 matcher が
// すべて無言で fail-open していた（実測: 旧 command は node 不在 PATH で exit 127）。
//
// launcher は shell 経由でも argv 直渡しでも動く必要がある（harness の実行
// セマンティクスは repo 側から固定できない）。両方の起動形をここで固定する。
describe('pre-tool-guard.sh: launcher の fail-closed（#2565）', () => {
  const launcherPath = resolve(rootDir, 'scripts/hooks/pre-tool-guard.sh');
  // POSIX 既定に近い、この repo の node（非標準ロケーション）を含まない PATH。
  const PATH_WITHOUT_NODE = '/usr/bin:/bin';

  function runLauncher(
    input: Record<string, unknown>,
    opts: { viaShell: boolean; path?: string },
  ): { status: number | null; stderr: string } {
    const env = { PATH: opts.path ?? (process.env.PATH as string) };
    const result = opts.viaShell
      ? // settings.json の command 文字列が sh -c 経由で実行される場合
        spawnSync('sh', ['-c', 'scripts/hooks/pre-tool-guard.sh'], {
          cwd: rootDir,
          encoding: 'utf8',
          input: JSON.stringify(input),
          env,
        })
      : // argv 直渡しで実行される場合（shebang + 実行ビットで起動する）
        spawnSync(launcherPath, [], {
          cwd: rootDir,
          encoding: 'utf8',
          input: JSON.stringify(input),
          env,
        });
    return { status: result.status, stderr: result.stderr ?? '' };
  }

  it('launcher は実行ビットを持つ（argv 直渡しでも起動できる）', () => {
    // eslint-disable-next-line no-bitwise -- 実行ビットの検査は mode のビット演算でしか書けない
    expect(statSync(launcherPath).mode & 0o111).not.toBe(0);
  });

  it.each([
    ['shell 経由', true],
    ['argv 直渡し', false],
  ])('node が PATH に無い時は block する（exit 2、fail closed）: %s', (_label, viaShell) => {
    const { status, stderr } = runLauncher(write('/home/user/x/notes.md'), {
      viaShell: viaShell as boolean,
      path: PATH_WITHOUT_NODE,
    });

    // 127（not found）だと Claude Code は tool 実行を続行してしまう。2 でなければならない。
    expect(status).toBe(2);
    expect(stderr).toContain('node を解決できないため');
  });

  it.each([
    ['shell 経由', true],
    ['argv 直渡し', false],
  ])('通常の PATH では従来どおり判定を委譲する: %s', (_label, viaShell) => {
    const opts = { viaShell: viaShell as boolean };

    expect(runLauncher(write(join(rootDir, '.env')), opts).status).toBe(2);
    expect(runLauncher(bash('git status'), opts).status).toBe(0);
  });

  it('settings.json の PreToolUse matcher すべてが launcher を指している', () => {
    // node を直接指す形へ戻すと fail-open が復活する。全箇所が launcher であること
    // を固定する（1 箇所だけ戻す差分をレビューで見落とさないため）。matcher は
    // Write / Edit / MultiEdit / NotebookEdit / Bash / Read の 6 本（#3053 で
    // no-op の Agent と撤去した spawn_task を外した）。
    const settings = JSON.parse(readFileSync(resolve(rootDir, '.claude/settings.json'), 'utf8'));
    const commands = settings.hooks.PreToolUse.flatMap((group: { hooks: { command: string }[] }) =>
      group.hooks.map((hook) => hook.command),
    );

    expect(commands).toHaveLength(6);
    expect(new Set(commands)).toEqual(new Set(['scripts/hooks/pre-tool-guard.sh']));
  });
});
