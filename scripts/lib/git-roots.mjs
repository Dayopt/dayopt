// git worktree 家系の解決（#2674）。
//
// worktree から実行しても「家系の main checkout はどこか」を返すのが役目。
// `pnpm ai:usage` は集計対象セッションを cwd の prefix 一致で選ぶため、
// `git rev-parse --show-toplevel` を使うと worktree からの実行で main checkout の
// セッションを丸ごと取りこぼす（#2674 の実測: 8 月分が全項目「未取得」）。
//
// **scripts/hooks/pre-tool-guard-rules.mjs とは意図的に共有しない。**
// #2674 手順 2 は「hooks 側もこの lib を import して二重実装を作らない」と書いて
// いたが、guard 側には先に置かれた不変条件がある: rules が import してよいのは
// node 標準ライブラリだけ。loader（pre-tool-guard.mjs）が持つ復旧経路は
// 「rules ファイル自身への Write/Edit だけを通す」なので、rules が repo 内 helper を
// import すると、その helper が壊れた時に guard が fail closed のまま直せなくなる。
// この不変条件は scripts/__tests__/pre-tool-guard.test.ts の fixture 構成
// （loader + rules の 2 ファイルだけで組む）が根拠で、実際に import を足すと
// 同 test が落ちる。判断は PR で報告する。
//
// そのため guard 側は自前の実装を持ち続け、drift は
// scripts/lib/git-roots.test.ts の「guard 側と同じ入力で同じ結果になる」contract
// test で検出する。repo の既定の解き方（ai-usage.mjs のヘッダ、
// scripts/hooks/session-token-usage.py との関係）と同じく、hooks が絡む時は
// 共有ではなく複製 + 契約 test を選ぶ。

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** git を捕捉付きで実行する。失敗（非 git ディレクトリ等）は空文字へ畳む。 */
export function runGitCapture(args, cwd, execFileImpl = execFileSync) {
  try {
    return execFileImpl('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

/** `cd DIR && pwd -P` 相当（symlink まで解決した絶対パス）。失敗時は空文字。 */
export function resolvePhysicalPath(p, cwd, realpathImpl = fs.realpathSync) {
  if (!p) return '';
  const abs = path.isAbsolute(p) ? p : path.join(cwd, p);
  try {
    return realpathImpl(abs);
  } catch {
    return '';
  }
}

/**
 * このセッションが今立っている working tree の root（currentRoot）、自分が
 * main checkout かどうか（isMainCheckout）、家系の main checkout の root
 * （mainRoot）、家系の**他の** worktree の root 一覧（otherRoots）を返す。
 * 解決できなければ null。
 *
 * `git worktree list --porcelain` は main worktree を必ず先頭に出す（git の仕様）。
 * mainRoot はその先頭行から取る。worktree list 自体が取れない場合は、自分が
 * main checkout ならば currentRoot、そうでなければ空文字にする（呼び出し側が
 * 「解決できなかった」と扱えるように、誤った worktree path を返さない）。
 *
 * @param {string} cwd
 * @param {typeof execFileSync} [execFileImpl]
 * @param {{ realpathImpl?: typeof fs.realpathSync }} [options] test 用の注入点
 */
export function resolveRoots(cwd, execFileImpl = execFileSync, { realpathImpl } = {}) {
  const resolve = (p) => resolvePhysicalPath(p, cwd, realpathImpl ?? fs.realpathSync);

  const toplevel = runGitCapture(['rev-parse', '--show-toplevel'], cwd, execFileImpl);
  const gitDirRaw = runGitCapture(['rev-parse', '--absolute-git-dir'], cwd, execFileImpl);
  const commonDirRaw = runGitCapture(['rev-parse', '--git-common-dir'], cwd, execFileImpl);
  if (!toplevel || !gitDirRaw || !commonDirRaw) return null;

  const toplevelResolved = resolve(toplevel);
  const gitDirResolved = resolve(gitDirRaw);
  const commonDirAbs = commonDirRaw.startsWith('/') ? commonDirRaw : path.join(cwd, commonDirRaw);
  const commonDirResolved = resolve(commonDirAbs);
  if (!toplevelResolved || !gitDirResolved || !commonDirResolved) return null;

  const isMainCheckout = gitDirResolved === commonDirResolved;

  const otherRoots = [];
  let mainRoot = '';
  let sawMainCandidate = false;
  const worktreeListRaw = runGitCapture(['worktree', 'list', '--porcelain'], cwd, execFileImpl);
  // porcelain は 1 worktree = 1 stanza（空行区切り）。行単位で `worktree ` だけを
  // 拾うと、bare repo の entry（`worktree <path>` の次行が `bare`）を working tree と
  // 誤認する。bare 家系では先頭 stanza が bare な `.git` ディレクトリになり、
  // それを mainRoot にすると誰の cwd とも一致しない prefix が出来て、ai:usage が
  // 黙って 0 件になる（fallback も効かない。修正前より悪い）。stanza 単位で読む。
  for (const stanza of worktreeListRaw.split('\n\n')) {
    const stanzaLines = stanza.split('\n');
    const head = stanzaLines.find((line) => line.startsWith('worktree '));
    if (!head) continue;
    const isBare = stanzaLines.some((line) => line.trim() === 'bare');
    const wtResolved = resolve(head.slice('worktree '.length));

    if (!isBare && !sawMainCandidate) {
      // 最初の非 bare stanza が main checkout（git の出力順の仕様）。
      // 解決できなければ mainRoot は空のままにする ── 「次に解決できた worktree」を
      // main へ昇格させると、誤った root を自信を持って返すことになる。
      sawMainCandidate = true;
      mainRoot = wtResolved;
    }

    if (!wtResolved) continue;
    if (wtResolved === toplevelResolved) continue;
    otherRoots.push(wtResolved);
  }
  if (!mainRoot && isMainCheckout) mainRoot = toplevelResolved;

  return { currentRoot: toplevelResolved, isMainCheckout, mainRoot, otherRoots };
}

/**
 * 家系の main checkout の root を返す。解決できなければ null。
 *
 * main checkout 配下には worktree 置き場（`.claude/worktrees/*`）も含まれるため、
 * 「main root の prefix 一致」で家系全体を 1 つの repo として扱える。
 */
export function resolveMainCheckoutRoot(cwd, execFileImpl = execFileSync, options = {}) {
  const roots = resolveRoots(cwd, execFileImpl, options);
  return roots?.mainRoot ? roots.mainRoot : null;
}
