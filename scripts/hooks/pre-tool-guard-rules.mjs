// PreToolUse hook の実ロジック（Node/ESM 移植、bash 版 scripts/hooks/pre-tool-guard-impl.sh
// の 1:1 移植）。判定結果は `evaluate()` が `{ decision: 'allow' | 'block', message? }`
// で返す純粋関数として実装する（decision === 'allow' 以外はすべて block 扱い）。
//
// このファイルは loader（scripts/hooks/pre-tool-guard.mjs）から
// `await import('./pre-tool-guard-rules.mjs')` で読み込まれる。import 自体が
// 構文エラー等で失敗した場合の fail-closed / 復旧経路は loader 側の責務。
// このファイルの `evaluate()` が例外を投げた場合も loader 側で fail-closed
// （exit 2）へ写す。
//
// 各セクションの見出しは bash 版のコメント・行範囲に対応させてある
// （移植時の対応表は PR 説明を参照）。ロジックを変更したら bash 版との対応が
// 崩れていないか確認すること。
//
// jq の `EXPR // empty` は EXPR が `null` / `false` を生成した時だけ右辺へ
// フォールバックし、EXPR 自体のエラー（例: 文字列を `.foo` で index する）は
// 捕捉せず伝播する（jq のよく知られる仕様）。bash 版はこの伝播を使って
// 「jq が failure したか」を `$?` で判定している（R1 の fail-open 判定）。
// 以下の `jqIndexPath` / `jqFirstOrEmpty` はこの挙動を模す。
//
// 残す規則は 5 つ（#3050 の目標設計、#3053 で縮小）。境界は token の到達範囲で作り、
// hook は事故を減らす speed bump に限る:
//   1. `.env` 系の読み書き禁止                   — checkWriteGuards / evaluateInner の Read
//   2. force push / reset --hard / no-verify 禁止 — checkBashCommand の先頭 4 判定
//   3. worktree 外の破壊禁止（再帰削除・他 worktree への編集）
//                                                — checkRmRecursive / checkWorktreeBoundary
//   4. secret 値の transcript 表示禁止（op の値表示、Supabase の secret 同梱 endpoint）
//                                                — checkOpItemGetReveal / checkOpRead /
//                                                  checkSupabaseMgmtDangerEndpoint
//   5. DB 保護（適用済み migration の編集、supabase db reset の直接呼び出し）
//                                                — checkWriteGuards / checkSupabaseDbResetRaw

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// --- block 判定を例外で持ち上げるための内部signal（bash の exit 2 相当）---
class GuardBlock extends Error {
  constructor(message) {
    super(message);
    this.name = 'GuardBlock';
  }
}

function block(message) {
  throw new GuardBlock(message);
}

// =====================================================================
// jq 互換ヘルパー（bash: `jq -r '.a.b // empty'` 系の抽出を模す）
// =====================================================================

/**
 * jq の `.a.b` indexing を模す。null を index すると null（エラーにならない）。
 * オブジェクト以外（配列・文字列・数値・真偽値）を key で index するとエラー
 * （jq: "Cannot index string with \"foo\""）。
 * @returns {{ ok: boolean, value?: unknown }}
 */
function jqIndexPath(root, keys) {
  let cur = root;
  for (const key of keys) {
    if (cur === null || cur === undefined) {
      cur = null;
      continue;
    }
    if (typeof cur !== 'object' || Array.isArray(cur)) {
      return { ok: false };
    }
    cur = Object.prototype.hasOwnProperty.call(cur, key) ? cur[key] : null;
  }
  return { ok: true, value: cur === undefined ? null : cur };
}

/** jq -r の raw 出力への変換（文字列はそのまま、それ以外は文字列化）。 */
function jqRaw(value) {
  if (typeof value === 'string') return value;
  return String(value);
}

/**
 * `.a // .b // empty` 相当。候補を順に評価し、`null`/`false` 以外の最初の値を
 * 採用する。途中で indexing エラーが起きたら（jq は `//` でエラーを捕まえない
 * ため）即座に ok:false を返す。
 * @returns {{ ok: boolean, text: string }}
 */
function jqFirstOrEmpty(root, keyPaths) {
  for (const keys of keyPaths) {
    const res = jqIndexPath(root, keys);
    if (!res.ok) return { ok: false, text: '' };
    if (res.value !== null && res.value !== false) {
      return { ok: true, text: jqRaw(res.value) };
    }
  }
  return { ok: true, text: '' };
}

/**
 * INPUT 全体を JSON.parse する。パース自体が失敗した場合は「どの `.foo` index も
 * エラーになる」状態として扱う（jq がパースエラーで全 filter を失敗させるのと
 * 同じ結果になるよう、非オブジェクト値の sentinel を返す）。
 */
function parseInputJson(rawInput) {
  try {
    return JSON.parse(rawInput);
  } catch {
    // jqIndexPath は object 以外（この undefined 含む）を index しようとすると
    // ok:false を返すので、JSON parse 失敗は「最初の .foo から失敗する」と
    // 同じ結果になる。
    return undefined;
  }
}

// =====================================================================
// worktree 家系解決（bash: guard_resolve_roots / guard_path_belongs_to_current_root）
// =====================================================================

function runGitCapture(args, cwd, execFileImpl) {
  return runGitResult(args, cwd, execFileImpl).out;
}

/**
 * `runGitCapture` と同じ実行だが、**「空を返した」と「失敗した」を区別する**。
 *
 * `git ls-tree` は「その path が tree に無い」を exit 0 + 空出力で返すため、
 * 空文字だけでは「無い（= allow してよい）」と「git が動かなかった（= 判定
 * 不能なので block）」が見分けられない。fail-closed を保つ判定はこちらを使う。
 */
function runGitResult(args, cwd, execFileImpl) {
  try {
    const out = execFileImpl('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return { ok: true, out: typeof out === 'string' ? out.trim() : '' };
  } catch {
    return { ok: false, out: '' };
  }
}

/** `cd DIR && pwd -P` 相当（symlink まで解決した絶対パス）。失敗時は空文字。 */
function resolvePhysicalPath(p, cwd) {
  if (!p) return '';
  const abs = path.isAbsolute(p) ? p : path.join(cwd, p);
  try {
    return fs.realpathSync(abs);
  } catch {
    return '';
  }
}

/**
 * このセッションが今立っている working tree の root（currentRoot）、自分が
 * main checkout かどうか（isMainCheckout）、家系の**他の** worktree の root
 * 一覧（otherRoots）を返す。解決できなければ null（bash の return 1 相当）。
 */
function resolveRoots(cwd, execFileImpl = execFileSync) {
  const toplevel = runGitCapture(['rev-parse', '--show-toplevel'], cwd, execFileImpl);
  const gitDirRaw = runGitCapture(['rev-parse', '--absolute-git-dir'], cwd, execFileImpl);
  const commonDirRaw = runGitCapture(['rev-parse', '--git-common-dir'], cwd, execFileImpl);
  if (!toplevel || !gitDirRaw || !commonDirRaw) return null;

  const toplevelResolved = resolvePhysicalPath(toplevel, cwd);
  const gitDirResolved = resolvePhysicalPath(gitDirRaw, cwd);
  const commonDirAbs = commonDirRaw.startsWith('/') ? commonDirRaw : path.join(cwd, commonDirRaw);
  const commonDirResolved = resolvePhysicalPath(commonDirAbs, cwd);
  if (!toplevelResolved || !gitDirResolved || !commonDirResolved) return null;

  const isMainCheckout = gitDirResolved === commonDirResolved;

  const otherRoots = [];
  const worktreeListRaw = runGitCapture(['worktree', 'list', '--porcelain'], cwd, execFileImpl);
  for (const line of worktreeListRaw.split('\n')) {
    if (!line.startsWith('worktree ')) continue;
    const wtPathRaw = line.slice('worktree '.length);
    const wtResolved = resolvePhysicalPath(wtPathRaw, cwd);
    if (!wtResolved) continue;
    if (wtResolved === toplevelResolved) continue;
    otherRoots.push(wtResolved);
  }

  return { currentRoot: toplevelResolved, isMainCheckout, otherRoots };
}

/**
 * 引数の絶対パスが「どの worktree root に属するか」を longest-prefix-match で
 * 判定する。true = 自分の currentRoot に属する（またはどの worktree root にも
 * 属さない = family 外）。false = 自分以外の worktree root に属する。
 */
function pathBelongsToCurrentRoot(target, roots) {
  let bestLen = -1;
  let bestIsCurrent = true;

  if (target === roots.currentRoot || target.startsWith(`${roots.currentRoot}/`)) {
    bestLen = roots.currentRoot.length;
    bestIsCurrent = true;
  }
  for (const other of roots.otherRoots) {
    if (!other) continue;
    if (target === other || target.startsWith(`${other}/`)) {
      if (other.length > bestLen) {
        bestLen = other.length;
        bestIsCurrent = false;
      }
    }
  }
  if (bestLen < 0) return true; // どの worktree root にも属さない
  return bestIsCurrent;
}

// =====================================================================
// Write/Edit/MultiEdit/NotebookEdit 系の判定
// =====================================================================

function isAbsoluteFilePath(p) {
  return p.startsWith('/');
}

function containsTraversal(p) {
  return p.includes('/../') || p.endsWith('/..');
}

/**
 * symlink を解決した「実体の path」を返す（loader の `canonicalPath()` と同じ形）。
 *
 * 保護判定を **生の file_path の文字列一致**で行うと、`/repo/tmp/foo` が `/repo/.env`
 * を指す symlink の場合に basename が `.env` で終わらないので素通りし、実体として
 * `.env` が上書きされる（#2566）。書き込みが着地するのは実体側なので、判定も実体で行う。
 *
 * 未作成の file でも比較できるよう、target 自身の realpath に失敗したら親ディレクトリ
 * だけ解決して basename を繋ぐ（新規作成の Write を巻き込まないため）。
 *
 * **dangling symlink（実体がまだ存在しない link）も辿る**: `realpathSync` は途中で
 * ENOENT になると何も返さないため、`.env` が未作成の checkout で `ln -s ../.env tmp/x`
 * を置くと link 先が見えず素通りする。`lstat` + `readlink` で 1 本ずつ手で解く
 * （深さ上限で循環 symlink を切る）。
 *
 * **この関数だけでは保護判定は完結しない。** 呼び出し元は raw path と canonical path の
 * **両方**で判定する（下の `checkWriteGuards` を参照）。canonical だけで見ると、逆に
 * `.env` 自身が非保護名のファイルを指す symlink の checkout（env を 1 箇所へ集約する
 * 構成）で `.env` への Write が素通りする。
 */
function canonicalFilePath(filePath, cwd) {
  if (!filePath) return '';
  let abs = path.isAbsolute(filePath) ? filePath : path.join(cwd, filePath);

  for (let depth = 0; depth < 16; depth += 1) {
    try {
      return fs.realpathSync(abs);
    } catch {
      let link = null;
      try {
        if (fs.lstatSync(abs).isSymbolicLink()) link = fs.readlinkSync(abs);
      } catch {
        link = null;
      }
      if (link === null) break;
      abs = path.resolve(path.dirname(abs), link);
    }
  }

  const resolvedDir = resolvePhysicalPath(path.dirname(abs), cwd);
  return resolvedDir ? path.join(resolvedDir, path.basename(abs)) : abs;
}

/**
 * worktree 外ファイル編集ガード（#2359）。
 *
 * 正規化後の path を返す。呼び出し元（`checkWriteGuards`）はこれを保護判定へ渡す
 * （#2566。以前は normalized を捨てて生の filePath を渡していたため、worktree 境界だけ
 * symlink を解決し、`.env` / migration の判定は解決しないという非対称があった）。
 */
function checkWorktreeBoundary(filePath, cwd, execFileImpl) {
  if (!filePath) return '';
  if (!isAbsoluteFilePath(filePath)) {
    block(`BLOCKED: file_path が絶対パスではありません: ${filePath}`);
  }
  if (containsTraversal(filePath)) {
    block(`BLOCKED: file_path に .. が含まれています（traversal は許可しません）: ${filePath}`);
  }

  const normalized = canonicalFilePath(filePath, cwd);

  const roots = resolveRoots(cwd, execFileImpl);
  if (roots && !pathBelongsToCurrentRoot(normalized, roots)) {
    block(
      `BLOCKED: 自分の worktree（${roots.currentRoot}）の外を編集しようとしています: ${normalized}（AGENTS.md §委任・報告の作法 の writer 4 条件、AGENTS.md §PR / git 運用）`,
    );
  }
  // roots が解決できない場合は fail-open（Write/Edit は高頻度操作のため）。

  return normalized;
}

/** .env / .env.* / .envrc への書き込み全面禁止。 */
function isProtectedEnvFilePath(filePath) {
  if (!filePath) return false;
  return filePath.endsWith('.env') || filePath.includes('.env.') || filePath.endsWith('.envrc');
}

/** 既存 migration ファイル（.sql 限定）かどうか。 */
function isExistingMigrationSqlPath(filePath) {
  return /supabase\/migrations\/.*\.sql$/.test(filePath ?? '');
}

function isRegularFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * 既存 migration が **`origin/main` に載っているか**（= 適用済みとみなすか）。
 *
 * migration は main へ merge された時点で production へ適用されるため、
 * 「origin/main の tree に在る」を適用済みの判定に使う（#2185）。逆に、未 merge の
 * PR ブランチにしか無い migration は production はもちろんどの共有環境にも
 * 適用されていないので、同じ PR 内で書き直してよい（レビュー指摘の反映や設計の
 * 訂正で普通に起きる。以前はここが一律 block で、そのつど User の例外裁可が要った）。
 *
 * **判定不能はすべて block**（fail-closed）: origin/main の ref が無い、git が
 * 動かない、path を repo root からの相対へ直せない、のいずれも「適用済みでない」
 * 証明にはならない。ref が古いだけの時は `git fetch origin main` で判定し直せる。
 *
 * 注意: push 済み・未 merge の migration を書き換えると、Supabase preview branch は
 * 同じ version を再適用しないため preview 側だけ古い定義が残る（`supabase` skill）。
 */
function isMigrationOnOriginMain(filePath, cwd, execFileImpl) {
  const ref = 'refs/remotes/origin/main';
  if (!runGitCapture(['rev-parse', '--verify', '--quiet', ref], cwd, execFileImpl)) return true;

  const roots = resolveRoots(cwd, execFileImpl);
  if (!roots) return true;

  const relative = repoRelativePath(filePath, roots.currentRoot, cwd);
  if (!relative) return true;

  const result = runGitResult(['ls-tree', '--name-only', ref, '--', relative], cwd, execFileImpl);
  if (!result.ok) return true;
  return result.out !== '';
}

/**
 * 絶対 path を repo root からの相対 path へ直す。root 配下でなければ symlink を
 * 解決してもう一度試し（repo root 自体が symlink 越しの checkout でも効くように）、
 * それでも配下でなければ空文字（呼び出し元は判定不能として扱う）。
 */
function repoRelativePath(filePath, currentRoot, cwd) {
  for (const candidate of [filePath, resolvePhysicalPath(filePath, cwd)]) {
    if (!candidate) continue;
    if (candidate.startsWith(`${currentRoot}/`)) return candidate.slice(currentRoot.length + 1);
  }
  return '';
}

/**
 * Write/Edit/MultiEdit/NotebookEdit の保護ファイル判定一式。
 *
 * **判定は raw path と正規化後の path の両方で行う（どちらかが当たれば block）**（#2566）。
 * 片方だけでは、それぞれ逆向きの穴が開く:
 *
 * - raw だけ: `ln -s .env tmp/foo` のような別名 1 本で、保護対象を指す symlink が
 *   basename 一致から外れて素通りする（書き込みは実体の `.env` へ着地する）
 * - canonical だけ: `.env` / `.env.local` 自身が非保護名のファイルを指す symlink である
 *   checkout（env を 1 箇所へ集約する構成）で、`.env` への Write が素通りする
 *
 * `.env` / `.env.*` / `.envrc` は AGENTS.md §Non-Negotiables で「読みも書きもしない」と
 * 定めた境界で、`.claude/settings.json` の `permissions.deny` は Read しか塞いでいない
 * （Write の機械強制はこの guard が唯一）。判定を緩める方向の変更は入れない。
 */
function checkWriteGuards(filePath, cwd, execFileImpl) {
  const targetPath = checkWorktreeBoundary(filePath, cwd, execFileImpl) || filePath;
  // 重複を除いた判定対象（symlink でなければ 1 件）。
  const candidates = targetPath === filePath ? [filePath] : [filePath, targetPath];
  const via = targetPath === filePath ? '' : `（${filePath} は ${targetPath} を指しています）`;

  if (candidates.some(isProtectedEnvFilePath)) {
    block(`BLOCKED: .env系ファイルへの書き込みは禁止です${via}`);
  }

  const appliedMigration = candidates.some(
    (p) =>
      isExistingMigrationSqlPath(p) &&
      isRegularFile(p) &&
      isMigrationOnOriginMain(p, cwd, execFileImpl),
  );
  if (appliedMigration) {
    block(
      `BLOCKED: origin/main に載っている（適用済みの）マイグレーションファイルの変更は禁止です。新しいマイグレーションを作成してください${via}。未 merge のマイグレーションがこう判定される場合は origin/main の取得が古いので、git fetch origin main のうえで再実行してください`,
    );
  }
}

// =====================================================================
// Bash: 危険コマンドのブロック
// =====================================================================

// grep -qE 'pattern' を「行ごとに」評価する bash の挙動を模す（`\s` は改行に
// またがらない）。COMMAND_JOINED / COMMAND_UNQUOTED は改行を除去済みなので
// 1 行になるが、生の $COMMAND は複数行のことがある。
function reMatchesAnyLine(text, re) {
  return text.split('\n').some((line) => re.test(line));
}

const FORCE_PUSH_RE =
  /git[ \t\n\v\f\r]+push[ \t\n\v\f\r]+.*--force[^-]|git[ \t\n\v\f\r]+push[ \t\n\v\f\r]+.*--force$/;
const RESET_HARD_RE = /git[ \t\n\v\f\r]+reset[ \t\n\v\f\r]+--hard/;
const PUSH_NO_VERIFY_RE = /(^|[;&|]|&&|\|\|)[ \t\n\v\f\r]*git[ \t\n\v\f\r]+push[^;&|]*--no-verify/;
const COMMIT_NO_VERIFY_RE =
  /(^|[;&|]|&&|\|\|)[ \t\n\v\f\r]*git[ \t\n\v\f\r]+commit[^;&|]*--no-verify/;

/** bash: `\` + 改行の line-continuation を畳み、残る改行を空白に寄せる。 */
function joinCommand(command) {
  return command.replace(/\\\n/g, '').replace(/\n/g, ' ');
}

/** bash: quote / backslash / ANSI-C・locale quote の $ 導入を除いた写し。 */
function unquoteCommand(joined) {
  return joined
    .replace(/\$'/g, "'")
    .replace(/\$"/g, '"')
    .replace(/"/g, '')
    .replace(/'/g, '')
    .replace(/\\/g, '');
}

const RM_RECURSIVE_RE =
  /(^|[ \t\n\v\f\r])(\/[^ \t\n\v\f\r]*\/)?rm[ \t\n\v\f\r].*(-[a-zA-Z]*[rR][a-zA-Z]*([ \t\n\v\f\r]|$)|--recursive([ \t\n\v\f\r=]|$))/;
const RM_ESCAPE_TARGET_RE = /(^|[ \t\n\v\f\r/])(~|\$)|(^|[ \t\n\v\f\r/])\.\.([ \t\n\v\f\r/]|$)/;
const RM_ABSOLUTE_HINT_RE = /(^|[ \t\n\v\f\r])\//;

/** bash: `tr ';&|' '\n'` + 空行スキップに相当するセグメント分割。 */
function splitOnSeparators(text) {
  return text.split(/[;&|]/).filter((s) => s.length > 0);
}

/** bash: `grep -oE '(^|[[:space:]])/[^[:space:]]*' | sed -E 's/^[[:space:]]+//'` */
function extractAbsoluteTokens(segment) {
  const re = /(^|[ \t\n\v\f\r])\/[^ \t\n\v\f\r]*/g;
  const out = [];
  let m;
  while ((m = re.exec(segment)) !== null) {
    out.push(m[0].replace(/^[ \t\n\v\f\r]+/, ''));
  }
  return out;
}

/** rm -r 系: worktree 外を指しうる対象を伴う呼び出しを block（#2359）。 */
function checkRmRecursive(commandJoined, commandUnquoted, cwd, execFileImpl) {
  for (const scanned of [commandJoined, commandUnquoted]) {
    for (const rmSegment of splitOnSeparators(scanned)) {
      if (!RM_RECURSIVE_RE.test(rmSegment)) continue;
      if (RM_ESCAPE_TARGET_RE.test(rmSegment)) {
        block(
          `BLOCKED: rm -r 系が worktree 外を指しうる対象（\`~\`・変数展開・\`..\` traversal）を伴っています。worktree 内の相対パス（node_modules・.next 等のキャッシュ削除）のみ許可します: ${scanned}`,
        );
      }
      const roots = resolveRoots(cwd, execFileImpl);
      if (roots) {
        for (const absToken of extractAbsoluteTokens(rmSegment)) {
          const resolved = resolvePhysicalPath(absToken, cwd) || absToken;
          if (!pathBelongsToCurrentRoot(resolved, roots)) {
            block(
              `BLOCKED: rm -r 系が自分の worktree（${roots.currentRoot}）以外の worktree（${resolved}）を指しています。worktree 内の相対パスまたは family 外（scratchpad 等）の絶対パスのみ許可します: ${scanned}`,
            );
          }
        }
      } else if (RM_ABSOLUTE_HINT_RE.test(rmSegment)) {
        block(
          `BLOCKED: rm -r 系が絶対パス対象を伴っていますが、家系 root を解決できませんでした（fail closed）: ${scanned}`,
        );
      }
    }
  }
}

const SUPABASE_DB_RESET_RE =
  /(^|[;&|]|&&|\|\|)[ \t\n\v\f\r]*(npx[ \t\n\v\f\r]+|pnpm[ \t\n\v\f\r]+(exec|dlx)[ \t\n\v\f\r]+)?supabase[ \t\n\v\f\r]+db[ \t\n\v\f\r]+reset/;

function checkSupabaseDbResetRaw(commandJoined, commandUnquoted) {
  for (const scanned of [commandJoined, commandUnquoted]) {
    if (SUPABASE_DB_RESET_RE.test(scanned)) {
      block(
        'BLOCKED: supabase db reset の直接呼び出しは禁止です。ローカル Supabase は複数の session が共有する単一 instance で、reset は他の作業のデータも巻き戻します。--linked 付きは link 先のリモート DB を reset します。ローカルは既定コマンド pnpm db:reset / pnpm db:fresh を使ってください（この文字列に言及しただけでも落ちます）',
      );
    }
  }
}

// --- #2293: agent-ops secret 露出の出力段 redaction ---

const ITEM_GET_RE = /item[ \t\n\v\f\r]+get([ \t\n\v\f\r]|$)/;
const REVEAL_FLAG_RE = /(^|[ \t\n\v\f\r;&|])--reveal([ \t\n\v\f\r;&|]|$)/;
const JSON_FORMAT_RE = /(--format[= \t\n\v\f\r]+json|OP_FORMAT=json)/;

function checkOpItemGetReveal(commandJoined, commandUnquoted) {
  for (const scanned of [commandJoined, commandUnquoted]) {
    if (
      ITEM_GET_RE.test(scanned) &&
      (REVEAL_FLAG_RE.test(scanned) || JSON_FORMAT_RE.test(scanned))
    ) {
      block(
        'BLOCKED: op item get で --reveal / --format=json（または OP_FORMAT=json）を使うと concealed field の実値が出力されます（--format=json は --reveal の有無に関わらず値を含む仕様です）。既定の human-readable 形式・--reveal なしで存在確認してください。値そのものが必要な操作は既存の scripts/admin-*.sh 経由で行ってください（agent が直接値を reveal する経路には使えません。この文字列に言及しただけでも落ちます。docs や commit message に書く時は文面を変えるか、Write / Edit で file に書いてから渡してください）',
      );
    }
  }
}

const SUPABASE_MGMT_DANGER_ENDPOINT_RE =
  /api\.supabase\.com\/v1\/(projects\/[^ \t\n\v\f\r"']*\/(config|branches)|branches)/;

function checkSupabaseMgmtDangerEndpoint(commandJoined, commandUnquoted) {
  for (const scanned of [commandJoined, commandUnquoted]) {
    if (SUPABASE_MGMT_DANGER_ENDPOINT_RE.test(scanned)) {
      block(
        'BLOCKED: Supabase Management API の config / branches endpoint への言及は禁止です（secret 系フィールドが同梱される仕様で、jq 射影を挟んでも 2026-08-11 に 2 回漏れました。curl 限定だと別 HTTP client で迂回できるため、実行手段を問わず endpoint への言及自体を block します）。node scripts/agent/supabase-mgmt-safe-get.mjs auth-config <field...> を使ってください（この文字列に言及しただけでも落ちます。docs や commit message に書く時は文面を変えるか、Write / Edit で file に書いてから渡してください）',
      );
    }
  }
}

// ---------------------------------------------------------------------
// merge の直接実行は block しない（2026-09-13、#2640）
// ---------------------------------------------------------------------
// 2026-09-04（#2596）から 2026-09-13 までは `gh pr merge` / `gh api ... PUT
// .../pulls/<N>/merge` を block し、merge 経路を `pnpm branch:finish <N>` 1 本に
// 絞っていた。Free plan の private repo では ruleset が使えず、CI red の遮断を
// finish-branch.sh の rollup 判定だけが担っていたため。
//
// 2026-09-07 の repo public 化で main の ruleset（required status checks / strict
// up-to-date / thread resolution、bypass actor 0）が有効になり、CI red の merge は
// GitHub 自身がどの経路（local / cloud / UI / API / MCP）でも拒む。この guard は
// Bash の `gh` 文字列しか見えず、MCP の merge tool は素通りしていたので、経路ごとに
// 条件が違う非対称だけが残っていた。ruleset を唯一の gate にし、この rule は撤去した。
// `pnpm branch:finish` は worktree / branch 掃除の入口として残る（gate ではない）。

const OP_READ_RE = /(^|[ \t\n\v\f\r;&|/])op[ \t\n\v\f\r]+read([ \t\n\v\f\r]|$)/;

function checkOpRead(commandJoined, commandUnquoted) {
  for (const scanned of [commandJoined, commandUnquoted]) {
    if (OP_READ_RE.test(scanned)) {
      block(
        'BLOCKED: op read op://... は --reveal 相当の masking を持たず、常に実値を stdout へ出します（例外なく block）。接続確認は op item get <itemName> --vault <vault> --fields <field> （既定の human-readable 形式・--reveal なしなら masked 出力）で代替してください。値そのものが必要な操作は op run 経由で行ってください（stdout へ出さずに process へ渡せます。この文字列に言及しただけでも落ちます。docs や commit message に書く時は文面を変えるか、Write / Edit で file に書いてから渡してください）',
      );
    }
  }
}

function checkBashCommand(rawCommand, cwd, execFileImpl) {
  if (reMatchesAnyLine(rawCommand, FORCE_PUSH_RE)) {
    block(
      'BLOCKED: git push --force は禁止です。--force-with-lease を使ってください（この文字列に言及しただけでも落ちます。commit message や PR 本文に書く時は文面を変えるか、Write / Edit で file に書いてから -F / --body-file で渡してください）',
    );
  }
  if (reMatchesAnyLine(rawCommand, RESET_HARD_RE)) {
    block(
      'BLOCKED: git reset --hard は危険です。確認してください（この文字列に言及しただけでも落ちます。文面を変えるか、Write / Edit で file に書いてから渡してください）',
    );
  }
  if (reMatchesAnyLine(rawCommand, PUSH_NO_VERIFY_RE)) {
    block(
      'BLOCKED: git push --no-verify は禁止です。pre-push の pause point に答えてから push してください（heredoc の本文など、この文字列に言及しただけでも落ちます。文面を変えるか、Write / Edit で file に書いてから -F / --body-file で渡してください）',
    );
  }
  if (reMatchesAnyLine(rawCommand, COMMIT_NO_VERIFY_RE)) {
    block(
      'BLOCKED: git commit --no-verify は禁止です。pre-commit の gitleaks スキャンを迂回するため（heredoc の本文など、この文字列に言及しただけでも落ちます。文面を変えるか、Write / Edit で file に書いてから -F / --body-file で渡してください）',
    );
  }

  const commandJoined = joinCommand(rawCommand);
  const commandUnquoted = unquoteCommand(commandJoined);

  checkRmRecursive(commandJoined, commandUnquoted, cwd, execFileImpl);
  checkSupabaseDbResetRaw(commandJoined, commandUnquoted);
  checkOpItemGetReveal(commandJoined, commandUnquoted);
  checkSupabaseMgmtDangerEndpoint(commandJoined, commandUnquoted);
  checkOpRead(commandJoined, commandUnquoted);
}

// =====================================================================
// エントリポイント
// =====================================================================

const WRITE_LIKE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

function evaluateInner(rawInput, cwd, execFileImpl) {
  const root = parseInputJson(rawInput);

  const toolName = jqFirstOrEmpty(root, [['tool_name']]).text;
  // NotebookEdit は file_path ではなく notebook_path を使う。
  const filePath = jqFirstOrEmpty(root, [
    ['tool_input', 'file_path'],
    ['tool_input', 'notebook_path'],
  ]).text;
  const command = jqFirstOrEmpty(root, [['tool_input', 'command']]).text;

  if (WRITE_LIKE_TOOLS.has(toolName)) {
    checkWriteGuards(filePath, cwd, execFileImpl);
  }

  if (toolName === 'Bash') {
    checkBashCommand(command, cwd, execFileImpl);
  }

  if (toolName === 'Read') {
    if ([filePath, canonicalFilePath(filePath, cwd)].some(isProtectedEnvFilePath)) {
      block('BLOCKED: .env系ファイルの読み込みは禁止です');
    }
  }
}

/**
 * PreToolUse hook の判定本体。純粋関数（プロセスを終了させない）。
 * @param {string} rawInput hook に渡された stdin の生 JSON テキスト
 * @param {{ cwd?: string, execFileImpl?: typeof execFileSync }} [options]
 * @returns {{ decision: 'allow' | 'block', message?: string }}
 */
export function evaluate(rawInput, options = {}) {
  const { cwd = process.cwd(), execFileImpl = execFileSync } = options;
  try {
    evaluateInner(rawInput, cwd, execFileImpl);
    return { decision: 'allow' };
  } catch (err) {
    if (err instanceof GuardBlock) {
      return { decision: 'block', message: err.message };
    }
    throw err;
  }
}

// CLI 入口は持たない（loader `pre-tool-guard.mjs` が唯一の入口）。このファイルは
// node 標準ライブラリ以外を import しない — repo 内の helper へ依存すると、その
// helper が壊れた時にも loader の import が失敗し、復旧経路（rules 自身への
// Write / Edit だけを通す）では直せない状態になる（Codex review P2、PR #2563）。
