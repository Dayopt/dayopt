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

/** `.a?` 相当（indexing エラーを飲み込み、値を生成しない）。文字列以外は捨てる
 * （呼び出し側で `map(select(type == "string"))` 相当を併せて行うため）。 */
function jqOptionalStringOrUndefined(root, keys) {
  const res = jqIndexPath(root, keys);
  if (!res.ok) return undefined;
  return typeof res.value === 'string' ? res.value : undefined;
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
// op:// vault allowlist（bash: ALLOWED_VAULT_PATTERN / disallowed_vault_refs）
// =====================================================================

// op run が解決してよい 1Password vault。禁止側を数え上げるのではなく許可側を
// 固定する（vault が増えた時に穴が開かないように、#2086 の 3 vault 再編で
// allowlist は agent 1 つに縮んだ）。
const ALLOWED_VAULT_RE = /^op:\/\/(agent)$/;

/** 渡されたテキストに含まれる op:// 参照のうち、allowlist 外の vault を返す。 */
function disallowedVaultRefs(text) {
  const matches = text.match(/op:\/\/[A-Za-z0-9_.-]+/g) ?? [];
  const uniq = [...new Set(matches)];
  return uniq.filter((ref) => !ALLOWED_VAULT_RE.test(ref));
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

/** local dev 用の env-file（現行名・旧名）。 */
function isLocalDevEnvFilePath(filePath) {
  if (!filePath) return false;
  return (
    filePath.endsWith('.op-env.agent') ||
    filePath.endsWith('.op-env.agent.example') ||
    filePath.endsWith('.op-env.local') ||
    filePath.endsWith('.op-env.local.example')
  );
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
 * Write は content、Edit は new_string、MultiEdit は edits[].new_string、
 * NotebookEdit は new_source に書き込み内容が入る。jq:
 *   [.tool_input.content?, .tool_input.new_string?, .tool_input.new_source?,
 *    (.tool_input.edits[]?.new_string?)] | map(select(type=="string")) | join("\n")
 */
function extractWrittenText(root) {
  const parts = [];
  const pushIfString = (keys) => {
    const v = jqOptionalStringOrUndefined(root, keys);
    if (v !== undefined) parts.push(v);
  };
  pushIfString(['tool_input', 'content']);
  pushIfString(['tool_input', 'new_string']);
  pushIfString(['tool_input', 'new_source']);

  const editsRes = jqIndexPath(root, ['tool_input', 'edits']);
  if (editsRes.ok && Array.isArray(editsRes.value)) {
    for (const edit of editsRes.value) {
      const v = jqOptionalStringOrUndefined(edit, ['new_string']);
      if (v !== undefined) parts.push(v);
    }
  }
  return parts.join('\n');
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
 *
 * `checkBashGuards` 側の op run 引数判定（`checkEnvFileContents`）は
 * `ALLOWED_ENV_FILE_ALTERNATION` の allowlist 方式で、許可された名前でなければ
 * そもそも op run に渡せない。任意名の symlink では通らないため、こちらは
 * 正規化を足していない（#2566 の「同じ非対称が他に無いか」への回答）。
 */
function checkWriteGuards(filePath, root, cwd, execFileImpl) {
  const targetPath = checkWorktreeBoundary(filePath, cwd, execFileImpl) || filePath;
  // 重複を除いた判定対象（symlink でなければ 1 件）。
  const candidates = targetPath === filePath ? [filePath] : [filePath, targetPath];
  const via = targetPath === filePath ? '' : `（${filePath} は ${targetPath} を指しています）`;

  if (candidates.some(isProtectedEnvFilePath)) {
    block(`BLOCKED: .env系ファイルへの書き込みは禁止です${via}`);
  }

  if (candidates.some(isLocalDevEnvFilePath)) {
    const written = extractWrittenText(root);
    const badVaults = disallowedVaultRefs(written);
    if (badVaults.length > 0) {
      block(
        `BLOCKED: local dev 用の env-file に許可外 vault の op:// 参照は書けません（検出: ${badVaults.join(' ')}）。このファイルは op run に渡せるので、production を参照する行を足すと production credential が解決されます。管理者運用の参照は .op-env.human.example 側に置いてください`,
      );
    }
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
// 「1 つのことしかしないコマンド」判定（bash: is_single_simple_command）
// =====================================================================

function isSingleSimpleCommand(s) {
  if (
    s.includes(';') ||
    s.includes('&') ||
    s.includes('|') ||
    s.includes('$(') ||
    s.includes('`') ||
    s.includes('<(') ||
    s.includes('>(') ||
    s.includes('eval')
  ) {
    return false;
  }
  if (s.includes('\n')) return false;
  return true;
}

// =====================================================================
// MCP: レーンからのチップ起票ブロック（bash: spawn_task section）
// =====================================================================

function checkSpawnTaskMainOnly(cwd, execFileImpl) {
  const roots = resolveRoots(cwd, execFileImpl);
  const isMainCheckout = roots ? roots.isMainCheckout : false;
  if (!isMainCheckout) {
    block(
      'BLOCKED: チップ起票（spawn_task）は Main（main checkout の session）の専権です。レーンで別件を見つけたら、(1) dispatch skill の規約に沿って issue を起票し、(2) Main へ send_message で連絡してください。User へ直接チップを出すと triage の判断が User に飛びます（dispatch skill（旧 orchestration.md、#2479 で再編） §レーンの連絡規律）',
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
        'BLOCKED: supabase db reset の直接呼び出しは禁止です。ローカル Supabase は複数レーンが共有する単一インスタンスで、reset は他レーンの進行中データも巻き戻します。既定コマンド pnpm db:reset / pnpm db:fresh を使うか、他レーンへの影響が無いことを確認してから Main へ相談してください（この文字列に言及しただけでも落ちます）',
      );
    }
  }
}

const ADMIN_ENV_FILE_DIRECT_RE = /--env-file[= \t\n\v\f\r]+[^ \t\n\v\f\r;&|]*\.op-env\.human/;

// 許可する env-file の path。選択肢で列挙する（optional group で組み立てると
// 区切りの / が任意になり、`..op-env.agent` のような別名まで通ってしまう）。
const ALLOWED_ENV_FILE_ALTERNATION =
  '(\\.op-env\\.agent|\\./\\.op-env\\.agent|\\.\\./\\.\\./\\.op-env\\.agent)';
// bash の [[:space:]]（POSIX space class: SP / TAB / LF / VT / FF / CR）と同じ集合。JS の \s は
// U+00A0（NBSP）等の Unicode 空白も含むため、許可名の直後に NBSP を置いた別ファイル名を
// 「許可名 + 区切り」と誤認し、shell では 1 語のまま別ファイルが消費される（Codex review
// P2、PR #2563）。regex literal 側も同じ集合を書き下す（\s / \S は使わない）。
const WS_CHARS_SRC = ' \t\n\v\f\r';
const CONFORMING_MENTION_SOURCE = `-env-file[=${WS_CHARS_SRC}]+${ALLOWED_ENV_FILE_ALTERNATION}[${WS_CHARS_SRC};&|]`;

/** --env-file の言及がすべて許可形かを判定する（出現数と適合数の一致で判定）。 */
function envFileMentionsConform(text) {
  const s = `${text} `;
  const total = (s.match(/-env-file/g) ?? []).length;
  if (total === 0) return true;
  const conforming = (s.match(new RegExp(CONFORMING_MENTION_SOURCE, 'g')) ?? []).length;
  return total === conforming;
}

/** 許可形を通った env-file の path を取り出す（中身検査に使う）。 */
function conformingEnvFilePaths(text) {
  const s = `${text} `;
  const matches = s.match(new RegExp(CONFORMING_MENTION_SOURCE, 'g')) ?? [];
  const cleaned = matches.map((m) =>
    m.replace(/^-env-file[= \t\n\v\f\r]+/, '').replace(/[ \t\n\v\f\r;&|]$/, ''),
  );
  return [...new Set(cleaned)];
}

function checkAdminEnvFileAndConformance(commandJoined, commandUnquoted) {
  for (const scanned of [commandJoined, commandUnquoted]) {
    if (ADMIN_ENV_FILE_DIRECT_RE.test(scanned)) {
      block(
        'BLOCKED: .op-env.human / .op-env.human.example を op run に渡すのは User の明示操作に限ります（production の service role key が解決され、admin script が本番へ書き込めるため。読み書きは #1993 で解禁済みだが消費は引き続き禁止）',
      );
    }
    if (!envFileMentionsConform(scanned)) {
      block(
        'BLOCKED: op run --env-file に渡してよいのは通常の local dev の env-file だけです（許可形以外の言及を検出）。別名や別ディレクトリへ複製した env-file 経由で production credential を解決する迂回を塞ぐためで、必要なら User に実行を依頼してください。名前を検索したいだけなら leading dash を外してください（例: rg env-file scripts/hooks/）',
      );
    }
  }
}

function checkEnvFileConsumptionIsSingleCommand(rawCommand, commandJoined, commandUnquoted) {
  const mentioned = commandJoined.includes('-env-file') || commandUnquoted.includes('-env-file');
  if (!mentioned) return;
  if (!isSingleSimpleCommand(rawCommand) || !isSingleSimpleCommand(commandUnquoted)) {
    block(
      'BLOCKED: env-file を op run へ渡すコマンドは、単一の単純コマンドにしてください（区切り ; & | 改行、コマンド置換 $( )、プロセス置換 <( )、eval は不可）。同じコマンドの中で env-file を書き換えられると、guard が検査した中身と実際に解決される中身が別物になるためです。書き込みや cd は別のコマンドに分けてください',
    );
  }
}

function checkEnvFileContents(commandJoined, commandUnquoted, cwd) {
  const paths = [
    ...conformingEnvFilePaths(commandJoined),
    ...conformingEnvFilePaths(commandUnquoted),
  ];
  const uniquePaths = [...new Set(paths)];
  for (const envFilePath of uniquePaths) {
    if (!envFilePath) continue;
    const resolved = path.isAbsolute(envFilePath) ? envFilePath : path.join(cwd, envFilePath);
    let content;
    try {
      if (!fs.statSync(resolved).isFile()) continue;
      content = fs.readFileSync(resolved, 'utf8');
    } catch {
      continue;
    }
    const badVaults = disallowedVaultRefs(content);
    if (badVaults.length > 0) {
      block(
        `BLOCKED: ${envFilePath} が許可外 vault の op:// 参照を持っています（検出: ${badVaults.join(' ')}）。op run に渡すと production credential が解決されます。管理者運用は .op-env.human 側の経路と User の明示操作で行ってください`,
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

const BRANCHES_GET_RE = /branches[ \t\n\v\f\r]+get([ \t\n\v\f\r]|$)/;

function checkSupabaseBranchesGet(commandJoined, commandUnquoted) {
  for (const scanned of [commandJoined, commandUnquoted]) {
    if (BRANCHES_GET_RE.test(scanned)) {
      block(
        'BLOCKED: supabase branches get は credential（SERVICE_ROLE_KEY 等）を含む JSON を返す仕様です（2026-08-11 incident）。状態確認には metadata のみを返す branches list を使ってください（この文字列に言及しただけでも落ちます。docs や commit message に書く時は文面を変えるか、Write / Edit で file に書いてから渡してください）',
      );
    }
  }
}

const VERCEL_INVOKE_RE = /(^|[ \t\n\v\f\r;&|/])vercel([ \t\n\v\f\r]|$)/;
const VERCEL_AUTH_FLAG_RE = /(^|[ \t\n\v\f\r;&|])(--token|-t)([ \t\n\v\f\r=]|$)/;

function checkVercelToken(commandJoined, commandUnquoted) {
  for (const scanned of [commandJoined, commandUnquoted]) {
    if (VERCEL_INVOKE_RE.test(scanned) && VERCEL_AUTH_FLAG_RE.test(scanned)) {
      block(
        'BLOCKED: vercel CLI に --token / -t を渡すのは禁止です（CLI が再実行・pagination 案内へ値を echo する場合があり、2026-07-22 に実際に露出しました）。VERCEL_TOKEN は環境変数として渡してください（docs/operations/secrets.md 既述。この文字列に言及しただけでも落ちます。docs や commit message に書く時は文面を変えるか、Write / Edit で file に書いてから渡してください）',
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
// gh pr merge / gh api ...pulls/.../merge の直接実行（cost guard、#2596）
// ---------------------------------------------------------------------
// merge 経路を `pnpm branch:finish <N>` 1 本に機械的に絞る（#2596）。free plan の
// private repo では branch protection / ruleset が使えず、CI red の遮断は
// finish-branch.sh の statusCheckRollup 判定だけが担っている。Bash tool からの
// `gh pr merge` / `gh api ... -X PUT .../pulls/<N>/merge` 直接実行を許すと、この
// 唯一の遮断を素通りできてしまう。
//
// finish-branch.sh 自身が内部で `gh api -X PUT .../pulls/$PR_NUMBER/merge` を実行
// するが、それは spawn されたシェルの中の呼び出しであり、Bash tool には
// `pnpm branch:finish <N>` という外側の1行しか見えないため、この rule では
// 素通りする（#2596 実装 plan で確認済み）。
//
// **security guard ではなく cost guard**。迂回されても漏洩は起きない（CI red の
// merge を試みるだけ）ので、判定は単純な正規表現に留める。
const GH_PR_MERGE_RE =
  /(^|[ \t\n\v\f\r;&|/])gh[ \t\n\v\f\r]+pr[ \t\n\v\f\r]+merge([ \t\n\v\f\r]|$)/;
const GH_API_PULLS_MERGE_RE =
  /(^|[ \t\n\v\f\r;&|/])gh[ \t\n\v\f\r]+api[ \t\n\v\f\r][^\n]*pulls\/[^ \t\n\v\f\r"']*\/merge/;
const PUT_METHOD_FLAG_RE =
  /(^|[ \t\n\v\f\r;&|])(-X|--method)[ \t\n\v\f\r=]*put([ \t\n\v\f\r;&|]|$)/i;

function checkGhMergeDirectExecution(commandJoined, commandUnquoted) {
  for (const scanned of [commandJoined, commandUnquoted]) {
    if (GH_PR_MERGE_RE.test(scanned)) {
      block(
        'BLOCKED: gh pr merge を直接実行しないでください（#2596）。pnpm branch:finish <PR番号> を使ってください（CI red での merge を機械的に遮断します。この文字列に言及しただけでも落ちます。docs や commit message に書く時は文面を変えるか、Write / Edit で file に書いてから渡してください）',
      );
    }
    if (GH_API_PULLS_MERGE_RE.test(scanned) && PUT_METHOD_FLAG_RE.test(scanned)) {
      block(
        'BLOCKED: gh api で pulls/<N>/merge へ PUT する直接実行は禁止です（#2596）。pnpm branch:finish <PR番号> を使ってください（CI red での merge を機械的に遮断します。この文字列に言及しただけでも落ちます。docs や commit message に書く時は文面を変えるか、Write / Edit で file に書いてから渡してください）',
      );
    }
  }
}

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
  checkAdminEnvFileAndConformance(commandJoined, commandUnquoted);
  checkEnvFileConsumptionIsSingleCommand(rawCommand, commandJoined, commandUnquoted);
  checkEnvFileContents(commandJoined, commandUnquoted, cwd);
  checkOpItemGetReveal(commandJoined, commandUnquoted);
  checkSupabaseBranchesGet(commandJoined, commandUnquoted);
  checkVercelToken(commandJoined, commandUnquoted);
  checkSupabaseMgmtDangerEndpoint(commandJoined, commandUnquoted);
  checkOpRead(commandJoined, commandUnquoted);
  checkGhMergeDirectExecution(commandJoined, commandUnquoted);
}

// =====================================================================
// Read: 大規模ファイルの範囲指定なし全文読み込みガード（cost guard、R3）
// =====================================================================

const READ_LARGE_FILE_EXTS = [
  '.ts',
  '.tsx',
  '.js',
  '.mjs',
  '.cjs',
  '.md',
  '.mdx',
  '.json',
  '.sql',
  '.yml',
  '.yaml',
  '.sh',
  '.py',
  '.css',
  '.txt',
];

function hasWatchedReadExtension(p) {
  return READ_LARGE_FILE_EXTS.some((ext) => p.endsWith(ext));
}

/** `wc -l` 相当（改行文字の出現数。末尾に改行が無い最終行はカウントしない）。 */
function countNewlines(content) {
  const m = content.match(/\n/g);
  return m ? m.length : 0;
}

function checkReadLargeFile(root) {
  const filePathRes = jqFirstOrEmpty(root, [['tool_input', 'file_path']]);
  const offsetRes = jqFirstOrEmpty(root, [['tool_input', 'offset']]);
  const limitRes = jqFirstOrEmpty(root, [['tool_input', 'limit']]);

  const readFilePath = filePathRes.text;
  const readOffset = offsetRes.text;
  const readLimit = limitRes.text;

  if (!readFilePath || readOffset !== '' || readLimit !== '') return;
  if (!hasWatchedReadExtension(readFilePath)) return;
  if (!isRegularFile(readFilePath)) return;

  let lineCount = 0;
  try {
    lineCount = countNewlines(fs.readFileSync(readFilePath, 'utf8'));
  } catch {
    return;
  }
  if (lineCount > 600) {
    block(
      `BLOCKED: ${lineCount} 行のファイルを範囲指定なしで Read しようとしています。offset / limit を付けるか、\`rg -n\` / \`sed -n\` で必要な範囲だけ読んでください（tool_result の Read が 2026-08 の context の 50% を占めた実測。routing skill §L0）`,
    );
  }
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
    checkWriteGuards(filePath, root, cwd, execFileImpl);
  }

  if (toolName === 'mcp__ccd_session__spawn_task') {
    checkSpawnTaskMainOnly(cwd, execFileImpl);
  }

  if (toolName === 'Bash') {
    checkBashCommand(command, cwd, execFileImpl);
  }

  if (toolName === 'Read') {
    if ([filePath, canonicalFilePath(filePath, cwd)].some(isProtectedEnvFilePath)) {
      block('BLOCKED: .env系ファイルの読み込みは禁止です');
    }
    checkReadLargeFile(root);
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
