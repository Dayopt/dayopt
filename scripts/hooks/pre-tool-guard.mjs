#!/usr/bin/env node
// PreToolUse hook loader（Node/ESM 移植、bash 版 scripts/hooks/pre-tool-guard.sh の
// 1:1 移植）。実際のガードロジックは pre-tool-guard-rules.mjs に置き、このファイルは
// 薄く保つ。理由: bash 版は「ファイル全体をパースしてから実行する」ため 1 ファイル
// 構成では構文エラーが入った瞬間、ファイル内のどんなコード（自己検査コードを含む）
// も実行されなくなる問題があった（2026-08-12 に実際に発生、#1961）。Node の ESM も
// 同様に、構文エラーを持つモジュールは import 自体が失敗し、その中の一切のコードが
// 動かない。loader/rules の 2 ファイル分離はこの bash 版の教訓をそのまま引き継ぐ。
//
// このファイルは変更頻度を低く保つこと。ロジックの変更は rules 側で行う。
//
// 挙動:
//   - `await import('./pre-tool-guard-rules.mjs')` を試みる
//     - 成功したら `evaluate()` を呼び、その決定を exit code へ写す
//       （decision === 'allow' の時だけ 0、それ以外はすべて 2 — rules が
//       実行時エラーで想定外の例外を投げても fail closed を保つ）
//     - import 自体が失敗（構文エラー等）したら fail closed を既定にしつつ、
//       **rules ファイル自身への Write/Edit だけ**を復旧目的で例外的に通す
//       （exit 0 + 警告）。他のすべての操作（Bash 全般、他ファイルの
//       Write/Edit 等）は引き続きブロックする。例外は rules の
//       literal path 一致のみで、scripts/hooks/** のような広い glob には
//       しない（このガード自身が「許可形は選択肢で列挙する」idiom を使って
//       いるのに合わせる）

import { execFileSync } from 'node:child_process';
import { realpathSync, statSync, writeSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RULES_PATH = join(__dirname, 'pre-tool-guard-rules.mjs');

/**
 * symlink を解決した比較用 path を返す。ESM の `import.meta.url` は realpath を返す
 * （Node の既定。`--preserve-symlinks-main` を付けない限り）ため RULES_PATH は解決済み
 * だが、harness が渡す `file_path` は解決されていない。macOS の `/var` -> `/private/var`
 * のように途中の component が symlink だと両者が食い違い、#1961 の復旧経路（rules 自身
 * への Write/Edit だけ通す）が常に block へ落ちる——rules に構文エラーが入った瞬間、
 * そのセッションからは二度と直せなくなる（#1961 の実障害そのもの）。
 * 未作成の file でも比較できるよう、失敗したら親ディレクトリだけ解決する。
 */
function canonicalPath(target) {
  if (!target) {
    return '';
  }
  try {
    return realpathSync(target);
  } catch {
    try {
      return join(realpathSync(dirname(target)), basename(target));
    } catch {
      return target;
    }
  }
}

/**
 * stderr への同期書き込み。`console.error` は stderr が pipe の時に非同期書き込みへ
 * なりうるため、直後の `process.exit()` が保留中の write を捨てて block 理由や復旧
 * WARNING が欠ける経路がある（bash 版の `echo >&2` は常に同期だった）。
 */
function writeStderr(message) {
  try {
    writeSync(2, `${message}\n`);
  } catch {
    // stderr が閉じている等。書けなくても exit code の側で fail closed は保たれる。
  }
}

function readStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    process.stdin.on('data', (chunk) => chunks.push(chunk));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', () => resolve(''));
  });
}

/**
 * import 失敗時の復旧経路判定にだけ使う、最小限の JSON 読み取り。rules
 * モジュールが使えない前提のため、ここでは rules の `evaluate()` を経由せず
 * 自前で tool_name / file_path を取り出す（bash 版の loader が jq を直接
 * 呼んでいたのと同じ位置付け）。
 */
function extractToolNameAndFilePath(rawInput) {
  try {
    const parsed = JSON.parse(rawInput);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { toolName: '', filePath: '' };
    }
    const toolName = typeof parsed.tool_name === 'string' ? parsed.tool_name : '';
    const toolInput = parsed.tool_input;
    let filePath = '';
    if (toolInput && typeof toolInput === 'object' && !Array.isArray(toolInput)) {
      if (typeof toolInput.file_path === 'string') {
        filePath = toolInput.file_path;
      } else if (typeof toolInput.notebook_path === 'string') {
        filePath = toolInput.notebook_path;
      }
    }
    return { toolName, filePath };
  } catch {
    return { toolName: '', filePath: '' };
  }
}

/**
 * rules に渡す cwd を決める。hook 入力の `cwd`（harness が渡す session の作業ディレクトリ）が
 * 絶対パスの実在ディレクトリならそれを使い、無ければ `process.cwd()` に戻す。
 *
 * desktop app の worktree session では、hook の process は main checkout を cwd にして
 * 起動する（settings.json の相対 command が main checkout 側で解決されるため）。
 * `process.cwd()` で「自分の worktree」を決めると、自分の worktree への Write / Edit と
 * `rm -r` を「他の worktree」と誤判定して止める（2026-10-09 に 3 回発生、#3053）。
 * 入力の `cwd` は session の作業ディレクトリを指すので、こちらを優先する。
 *
 * 保証境界: session が `cd` で別の worktree へ移ると、その worktree が「自分」になる。
 * 意図して移動した後の編集までは止めない（speed bump であって境界ではない）。
 */
function resolveHookCwd(rawInput) {
  try {
    const parsed = JSON.parse(rawInput);
    const cwd = parsed && typeof parsed === 'object' ? parsed.cwd : undefined;
    if (typeof cwd === 'string' && cwd.startsWith('/') && statSync(cwd).isDirectory()) {
      return cwd;
    }
  } catch {
    // JSON でない / 実在しない場合は process.cwd() に戻す
  }
  return process.cwd();
}

async function main() {
  const rawInput = await readStdin();

  /**
   * rules が使えない（import 失敗 / `evaluate` が export されていない / evaluate が
   * 例外を投げた）時の共通経路。fail closed を既定にしつつ、rules ファイル自身への
   * Write / Edit だけを復旧目的で通す。「import は成功するが `export` を落とした・
   * 関数名を変えた」ケースを import 失敗と同じ扱いにしないと、別セッション無しでは
   * 復旧できない状態になる（Codex review P2、PR #2563）。
   */
  function recoverOrBlock(reason, error) {
    const detail = error?.message ?? error;
    const { toolName, filePath } = extractToolNameAndFilePath(rawInput);
    const isWriteOrEdit = toolName === 'Write' || toolName === 'Edit';
    if (isWriteOrEdit && canonicalPath(filePath) === canonicalPath(RULES_PATH)) {
      writeStderr(
        `WARNING: pre-tool-guard-rules.mjs が壊れています（${reason}）。復旧のため、この修復編集だけは通します。他の全操作は fail closed でブロックされます。エラー: ${detail}`,
      );
      process.exit(0);
    }
    writeStderr(
      `BLOCKED: pre-tool-guard-rules.mjs が壊れています（${reason}、fail closed）。復旧するには pre-tool-guard-rules.mjs を修正してください（この Write/Edit だけは通ります）。エラー: ${detail}`,
    );
    process.exit(2);
  }

  let rulesModule;
  try {
    rulesModule = await import(pathToFileURL(RULES_PATH).href);
  } catch (importError) {
    recoverOrBlock('import 失敗', importError);
  }
  if (typeof rulesModule?.evaluate !== 'function') {
    recoverOrBlock(
      'evaluate が export されていない',
      new Error('export function evaluate が見つかりません'),
    );
  }

  let result;
  try {
    result = rulesModule.evaluate(rawInput, {
      cwd: resolveHookCwd(rawInput),
      execFileImpl: execFileSync,
    });
  } catch (evalError) {
    recoverOrBlock('評価が例外を投げた', evalError);
  }

  if (result && result.decision === 'allow') {
    process.exit(0);
  }
  if (result && result.message) {
    writeStderr(result.message);
  }
  process.exit(2);
}

// loader は「decision が allow の時だけ 0、それ以外はすべて 2」を返す。async 関数の
// 未捕捉 rejection は Node の既定で exit 1 になり、exit 1 は harness では block では
// なく non-blocking error（= tool は実行される）として扱われるため、fail closed が
// 崩れる。try/catch で覆えていない箇所（例: `result.decision` の参照）が将来増えても
// この不変条件が構造で残るように、最後に .catch を置く（#2563 内製クロスレビュー P2）。
main().catch((error) => {
  writeStderr(
    `BLOCKED: pre-tool-guard の loader が異常終了しました（fail closed）。エラー: ${error?.message ?? error}`,
  );
  process.exit(2);
});
