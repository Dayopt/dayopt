#!/usr/bin/env node

/**
 * Destructive migration 検知 — PR に追加された `supabase/migrations/**` の新規ファイルを
 * 走査し、DROP TABLE / DROP COLUMN / TRUNCATE / 列の型変更（narrowing かどうかは
 * 機械では判定しないため、ALTER COLUMN ... TYPE を検知したら人間の確認対象として扱う）/
 * UPDATE backfill（#2433。migration 自身が実行する既存行の書き換え）を検出する。
 *
 * scope（#2272）: 検知の機械化だけを行う。検知結果を理由に merge を機械的にブロックする
 * gate 化・EXPLICIT AUTHORITY の執行そのものは #2175 の scope。このスクリプトはラベル付与
 * と PR コメントで人間の目に留める（fail open — job 自体は失敗させない）。
 *
 * 対象は「新規追加された」migration ファイルのみ（`status === 'added'`）。既存 migration
 * の unrelated な diff（コメント修正など）でノイズを出さないため。migration は原則
 * append-only なので、追加ファイルの検知で実務上十分カバーできる。
 *
 * 使い方（入力は NDJSON — 1 行 1 JSON object。`gh api --paginate ... --jq '.[] | {filename,status} | tojson'`
 * の出力形式と一致させ、複数ページに分かれても安全にパースできるようにしている）:
 *   printf '%s\n' '{"filename":"supabase/migrations/x.sql","status":"added"}' \
 *     | node scripts/ci/check-destructive-migration.mjs --stdin
 *   ... --github-output を付けると GITHUB_OUTPUT 向けの `key=value` 行を出す
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const MIGRATIONS_PREFIX = 'supabase/migrations/';

/**
 * 走査対象は migrations 配下の .sql のみ。配下のポインタ用 markdown
 * （CLAUDE.md 等）は適用される SQL ではないため対象外にする（#2510）。
 * @param {string} path
 */
function isMigrationSqlPath(path) {
  return path.startsWith(MIGRATIONS_PREFIX) && path.endsWith('.sql');
}

/**
 * 検出パターン。`kind` はラベル・コメント文面で使う識別子。
 * SQL コメント行（`--`）を先に除去してから判定する（コメント中の DROP 言及で
 * 誤検知しないため）。
 */
// risk-reviewer 指摘（#2271/#2272 push前反証レビュー）: DELETE FROM / DROP POLICY /
// REVOKE / RENAME は DROP TABLE 等と同等かそれ以上に不可逆・認可漏れに直結するため追加した。
// rls-snapshot:check は DROP POLICY / REVOKE を「snapshot 未更新なら検出する」が、
// snapshot を同一 PR で再生成されると素通りするため、ここでも独立に検知する。
const PATTERNS = [
  { kind: 'DROP_TABLE', re: /\bDROP\s+TABLE\b/i, label: 'DROP TABLE' },
  { kind: 'DROP_COLUMN', re: /\bDROP\s+COLUMN\b/i, label: 'DROP COLUMN' },
  { kind: 'DELETE_FROM', re: /\bDELETE\s+FROM\b/i, label: 'DELETE FROM（データ削除）' },
  { kind: 'TRUNCATE', re: /\bTRUNCATE\b/i, label: 'TRUNCATE' },
  { kind: 'DROP_POLICY', re: /\bDROP\s+POLICY\b/i, label: 'DROP POLICY（RLS 境界の削除）' },
  { kind: 'REVOKE', re: /\bREVOKE\b/i, label: 'REVOKE（権限の剥奪、意図した縮小か要確認）' },
  {
    kind: 'RENAME',
    re: /\bRENAME\s+(COLUMN|TO)\b/i,
    label: 'RENAME（クライアント契約の破壊的変更）',
  },
  { kind: 'DROP_FUNCTION', re: /\bDROP\s+FUNCTION\b/i, label: 'DROP FUNCTION' },
  { kind: 'DROP_TRIGGER', re: /\bDROP\s+TRIGGER\b/i, label: 'DROP TRIGGER' },
  { kind: 'DROP_CONSTRAINT', re: /\bDROP\s+CONSTRAINT\b/i, label: 'DROP CONSTRAINT' },
  {
    kind: 'ALTER_COLUMN_TYPE',
    re: /\bALTER\s+COLUMN\s+\S+\s+(?:SET\s+DATA\s+)?TYPE\b/i,
    label: '列の型変更（narrowing かどうかは目視確認が必要）',
  },
  // #2433（台帳 第2段）: UPDATE backfill を検知対象へ追加する。第8段（色再割当て等）が
  // 持ち込む「既存行の書き換え」は DROP と同じく forward-only で、code revert では戻らない
  // （backup restore しかない）。それが検知されないまま通る状態を、来る前に塞ぐ。
  //
  // `topLevelOnly` — この repo の migration は大半が SECURITY DEFINER 関数の定義を含む
  // （public に definer 関数が 126 個ある実測）。関数本体の UPDATE は RPC のロジックであって
  // backfill ではないため、素朴に照合すると事実上すべての migration に発火し、checker が
  // 「常に警告が出るから読まない」状態＝ノイズになる。関数・プロシージャの本体だけを
  // 除外したテキストに対して照合する（`DO $$ ... $$` の匿名ブロックは migration 自身が
  // 実行するので**除外しない**。ここを外すと `DO $$ BEGIN UPDATE ... END $$;` という
  // backfill の書き方が丸ごと素通りする）。判定は「DO ブロックか否か」を文の先頭で見る
  // （`CREATE FUNCTION` の含有で見るとコメント内の同語で騙される。risk-reviewer 指摘）。
  //
  // `SET` を必須にすることで `ON UPDATE CASCADE` / `FOR UPDATE` / `BEFORE UPDATE ON` /
  // `CREATE POLICY ... FOR UPDATE` / `GRANT UPDATE ON` / `has_table_privilege(..,'UPDATE')`
  // がすべて外れる。省略可能な別名（`UPDATE t AS x SET` / `UPDATE t x SET`）と
  // `UPDATE ONLY t SET` は拾う。
  // 同じ「既存行の書き換え」を別構文で書いたもの。第8段の色再割当ては upsert 形で
  // 書かれうるため、UPDATE だけ塞いでも素通りする（push 前反証の risk-reviewer 指摘）。
  {
    kind: 'UPSERT_BACKFILL',
    re: /\bON\s+CONFLICT\b[\s\S]{0,200}?\bDO\s+UPDATE\s+SET\b/i,
    label: 'upsert backfill（ON CONFLICT DO UPDATE SET。既存行を書き換える）',
    topLevelOnly: true,
  },
  {
    kind: 'MERGE_BACKFILL',
    re: /\bMERGE\s+INTO\b[\s\S]{0,400}?\bWHEN\s+MATCHED\b[\s\S]{0,80}?\bTHEN\s+(?:UPDATE\s+SET|DELETE)\b/i,
    label: 'MERGE backfill（WHEN MATCHED THEN UPDATE / DELETE。既存行を書き換える）',
    topLevelOnly: true,
  },
  {
    kind: 'UPDATE_BACKFILL',
    re: /\bUPDATE\s+(?:ONLY\s+)?[\w".]+(?:\s+(?:AS\s+)?(?!SET\b)[\w"]+)?\s+SET\b/i,
    label: 'UPDATE backfill（既存行の書き換え。forward-only、code revert では戻らない）',
    topLevelOnly: true,
  },
];

function stripSqlLineComments(sql) {
  return sql
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n');
}

/**
 * `topLevelOnly` パターン用のテキストを 1 パスで作る。
 *
 * 「migration 自身がその場で実行する SQL」だけを残し、それ以外（コメント・文字列リテラル・
 * 関数本体）を空白へ潰す。**文字数と改行位置を 1:1 で保つ**ので、呼び出し側の
 * offset -> line 逆引きは元テキストと共有できる。
 *
 * 層を重ねた正規表現ではなく単一の走査にしてある。前の実装はブロックコメント除去と
 * dollar-quote 判定を別パスでやっており、**dollar-quote の中にある `/*` を本物のコメント
 * 開始として扱ってしまう**穴があった（閉じ `*` + `/` が無ければファイル末尾まで潰れ、後続の
 * backfill が丸ごと消える）。状態を 1 つ持って左から舐めれば、その取り違えは構造的に起きない。
 *
 * 残すもの / 潰すもの:
 * - `-- 行コメント` … 潰す
 * - `/* ブロックコメント *' + '/` … 潰す。**閉じていなければ潰さない**（壊れた SQL で
 *   検知を失うより、余計に拾って人間に見せる方が安全側）
 * - `'文字列リテラル'` … 潰す（リテラル中の "UPDATE ... SET" で誤検知しないため）
 * - `$$ ... $$` … **匿名 `DO` ブロックだけ残す**。DO は migration がその場で実行する文なので
 *   中の UPDATE は本物の backfill。関数・プロシージャ本体は RPC のロジックなので潰す
 *
 * @param {string} sql 生の migration テキスト
 * @returns {string} 同じ長さ・同じ改行位置のテキスト
 */
function maskForTopLevelScan(sql) {
  const out = sql.split('');
  const blank = (from, to) => {
    for (let i = from; i < to && i < out.length; i += 1) {
      if (out[i] !== '\n') out[i] = ' ';
    }
  };

  let i = 0;
  // 直近の `;` の位置。dollar-quote が匿名 DO ブロックかを「文の先頭」で判定するのに使う。
  let stmtStart = 0;

  while (i < sql.length) {
    const two = sql.slice(i, i + 2);

    if (two === '--') {
      const nl = sql.indexOf('\n', i);
      const stop = nl === -1 ? sql.length : nl;
      blank(i, stop);
      i = stop;
      continue;
    }

    if (two === '/' + '*') {
      const close = sql.indexOf('*' + '/', i + 2);
      if (close === -1) {
        // 閉じないブロックコメント。潰すとファイル末尾までの検知を失うので、
        // コメントとして扱わずそのまま進む（安全側 = 検知を残す）。
        i += 2;
        continue;
      }
      blank(i, close + 2);
      i = close + 2;
      continue;
    }

    if (sql[i] === "'") {
      // 単一引用符の文字列。'' はエスケープされた引用符。
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") {
            j += 2;
            continue;
          }
          break;
        }
        j += 1;
      }
      const stop = Math.min(j + 1, sql.length);
      blank(i + 1, stop - 1);
      i = stop;
      continue;
    }

    const dollar = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
    if (dollar) {
      const tag = dollar[0];
      const bodyStart = i + tag.length;
      const close = sql.indexOf(tag, bodyStart);
      if (close === -1) {
        i += tag.length;
        continue;
      }
      // 文の**先頭**が DO なら匿名ブロック。含有ではなく先頭で見るので、直前のコメントや
      // 別の文に同じ語があっても騙されない。
      //
      // 判定は **`out`（ここまでマスク済みのテキスト）** に対して行う。生の `sql` を見ると、
      // 直前のブロックコメントが未除去のまま先頭一致に割り込み、`/* ... */\nDO $$` を
      // 「DO で始まっていない」と誤判定する（実測で再現）。`out` なら comment は既に
      // 空白へ潰れているので、先頭アンカーが期待どおり効く。
      const isAnonymousBlock = /^\s*DO\b/i.test(out.slice(stmtStart, i).join(''));
      if (!isAnonymousBlock) blank(bodyStart, close);
      i = close + tag.length;
      continue;
    }

    if (sql[i] === ';') stmtStart = i + 1;
    i += 1;
  }

  return out.join('');
}

/**
 * @param {string} sql migration ファイルの内容
 * @returns {{ kind: string, label: string, line: number, snippet: string }[]}
 */
export function detectDestructivePatterns(sql) {
  const cleaned = stripSqlLineComments(sql);
  // `topLevelOnly` パターン専用のテキスト。ブロックコメントと、匿名 DO ブロック以外の
  // dollar-quoted 本体を空白へ潰す（長さ・改行位置は `cleaned` と 1:1 のまま）ので、
  // 行分割・offset -> line 逆引きは両者で共有できる。
  const topLevelCleaned = maskForTopLevelScan(sql);
  const lines = cleaned.split('\n');
  const topLevelLines = topLevelCleaned.split('\n');
  const findings = [];
  const seen = new Set();

  const record = (kind, label, line, snippet) => {
    const key = `${kind}:${line}`;
    if (seen.has(key)) return; // 同一行内マッチと後段の全文パスの重複を防ぐ
    seen.add(key);
    findings.push({ kind, label, line, snippet: snippet.trim().slice(0, 200) });
  };

  lines.forEach((line, index) => {
    for (const { kind, re, label, topLevelOnly } of PATTERNS) {
      // 判定は scope に応じたテキストで行い、**表示する snippet は常に元の行**にする
      // （潰した空白を人間へ見せても意味が無い。マッチした時点でその範囲は非潰しなので、
      // 元の行を出しても取り違えは起きない）。
      const subject = topLevelOnly ? topLevelLines[index] : line;
      if (re.test(subject)) {
        record(kind, label, index + 1, line);
      }
    }
  });

  // risk-reviewer 指摘: 整形された SQL は `ALTER TABLE x\n  ALTER COLUMN y\n  TYPE z;` の
  // ように句が複数行へ折り返されることがあり、行単位の検査だけでは false negative になる。
  // 各行の連結オフセットを記録した上で空白正規化した全文にも一度マッチさせ、マッチ開始位置を
  // 含む行へ逆引きする（近似ではなく厳密な offset -> line マッピング）。
  // **2 つのテキストで offset を共有しない。** `stripSqlLineComments` は `--` 以降を
  // 削除して行を**短くする**ため、`cleaned` と `maskForTopLevelScan(sql)`（生の長さを
  // 保つ）では同じ行でも長さが違う。offset 表を共有すると topLevel 側のマッチ位置が
  // ずれ、ファイルの行数を超える行番号を報告する（実測で確認）。行**数**は一致するので、
  // 行単位の突き合わせだけは index で共有できる。
  const buildFlattened = (sourceLines) => {
    const offsets = [];
    let text = '';
    sourceLines.forEach((line, index) => {
      offsets.push({ offset: text.length, line: index + 1 });
      text += `${line} `;
    });
    return { text, offsets };
  };
  const lineForOffsetIn = (offsets, offset) => {
    let result = 1;
    for (const entry of offsets) {
      if (entry.offset > offset) break;
      result = entry.line;
    }
    return result;
  };

  const flat = buildFlattened(lines);
  const flatTopLevel = buildFlattened(topLevelLines);

  for (const { kind, re, label, topLevelOnly } of PATTERNS) {
    const { text, offsets } = topLevelOnly ? flatTopLevel : flat;
    const globalRe = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
    let match = globalRe.exec(text);
    while (match !== null) {
      record(kind, label, lineForOffsetIn(offsets, match.index), match[0]);
      match = globalRe.exec(text);
    }
  }

  return findings.sort((a, b) => a.line - b.line);
}

/**
 * @param {{ path: string, status: string, content: string }[]} files
 * @returns {{ path: string, findings: ReturnType<typeof detectDestructivePatterns> }[]}
 */
export function checkFiles(files) {
  const results = [];
  for (const file of files) {
    if (file.status !== 'added') continue;
    if (!isMigrationSqlPath(file.path)) continue;
    const findings = detectDestructivePatterns(file.content);
    if (findings.length > 0) {
      results.push({ path: file.path, findings });
    }
  }
  return results;
}

export function formatSummary(results) {
  if (results.length === 0) {
    return '## Migration safety\n\n✅ 破壊的変更を検知しませんでした（新規追加 migration なし、または該当パターンなし）。\n';
  }
  const lines = [
    '## Migration safety',
    '',
    '⚠️ 新規追加された migration に破壊的変更の可能性があるパターンを検知しました。',
    '',
  ];
  for (const { path, findings } of results) {
    lines.push(`### \`${path}\``);
    for (const f of findings) {
      lines.push(`- L${f.line} **${f.label}**: \`${f.snippet}\``);
    }
    lines.push('');
  }
  lines.push(
    '本番へのこの種の変更は `AGENTS.md` §シンプルルール の `EXPLICIT AUTHORITY`（明示指示 + 独立レビュー + dry-run/backup）を要する。',
  );
  return `${lines.join('\n')}\n`;
}

export function formatGithubOutput(results) {
  const destructive = results.length > 0 ? 'true' : 'false';
  return `destructive=${destructive}\n`;
}

// ─── contract narrowing × app コードの同一 PR 検出（coupled migration）────────
//
// Supabase GitHub integration は main merge 時点で migration を production へ適用し、
// Vercel の promote は E2E 完走後の別 job（promote.yml）で行う。既存オブジェクトの
// 権限・契約を**縮める** migration と、その新しい経路を使う app コードを同一 PR に
// 束ねると、promote が失敗している間ずっと旧 build が新 schema に当たる。
//
// 実測（2026-09-08）: PR #2672 は `mfa_recovery_codes` への REVOKE ALL + DROP POLICY と
// RPC 切替を同一 PR に持ち、promote が E2E で 4 run 連続失敗したため **5 時間 4 分**
// 旧 build（table を直接 INSERT / DELETE）が revoke 済み schema に当たり続けた。
// `docs/decisions.md` 2026-09-04 が PR 分割を規律として書いていたが機械強制が無かった。
//
// 判定は「縮小」だけを対象にする。DELETE FROM / TRUNCATE / DROP TRIGGER / DROP CONSTRAINT
// / backfill は旧 build の契約を縮めないので coupled の対象外（plain な destructive 検知
// には残る）。同一 PR の新規 migration が**作った**オブジェクトへの縮小は除外する
// （新規テーブル雛形の `REVOKE ALL ... FROM PUBLIC, anon, authenticated` → `GRANT`、
// 新規列への列レベル REVOKE は旧 build が知らないオブジェクトなので窓が開かない）。
//
// plain な destructive 検知は fail open のまま（#2272）。coupled だけを hard fail にする。

export const NARROWING_KINDS = new Set([
  'DROP_TABLE',
  'DROP_COLUMN',
  'DROP_POLICY',
  'REVOKE',
  'RENAME',
  'ALTER_COLUMN_TYPE',
  'DROP_FUNCTION',
]);

/**
 * identifier を `schema.name`（小文字・quote 除去、既定 schema は public）へ正規化する。
 * @param {string} raw
 */
function normalizeIdent(raw) {
  // `format('... ON public.%I ...')` のような動的 SQL は識別子が `public.` で切れる。
  // migration 自身が DO ブロックで実行する REVOKE なので検知対象に残し、対象名だけ
  // `<dynamic>` にする（除外判定には乗らない = 縮小として扱う）。
  const unquoted = raw.replace(/"/g, '').trim();
  const parts = unquoted
    .split('.')
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean)
    .map((part) => (part.includes('%') ? '<dynamic>' : part));
  if (unquoted.endsWith('.')) parts.push('<dynamic>');
  if (parts.length === 0) return '';
  if (parts.length === 1) return `public.${parts[0]}`;
  return parts.slice(-2).join('.');
}

/**
 * masked text（`maskForTopLevelScan`）を `;` 区切りの文へ分け、各文の開始行を付ける。
 * masked は改行位置を保つので、行番号は生のファイルと一致する。
 * @param {string} masked
 * @returns {{ text: string, line: number }[]}
 */
function splitStatements(masked) {
  const statements = [];
  let start = 0;
  for (let i = 0; i <= masked.length; i += 1) {
    if (i === masked.length || masked[i] === ';') {
      const raw = masked.slice(start, i);
      const leading = raw.length - raw.trimStart().length;
      const text = raw.trim();
      if (text) {
        const line = masked.slice(0, start + leading).split('\n').length;
        statements.push({ text, line });
      }
      start = i + 1;
    }
  }
  return statements;
}

/**
 * PR で追加された migration 群が**作る**オブジェクトを集める。ここに入るものへの
 * 縮小は旧 build が知らないため coupled の対象外。
 * `tables` には VIEW / MATERIALIZED VIEW も入れる（`REVOKE ... ON TABLE` / 無修飾 `ON` は
 * view にも同じ構文で書かれ、この repo の定型が `CREATE VIEW private.x; REVOKE ALL ON
 * TABLE private.x ...` だから）。`CREATE SCHEMA` は `schemas` に別で持つ
 * （`REVOKE ALL ON SCHEMA private` を新規 schema なら除外するため）。
 * @param {string[]} sqlTexts
 * @returns {{ tables: Set<string>, functions: Set<string>, columns: Set<string>, schemas: Set<string> }}
 */
export function collectCreatedObjects(sqlTexts) {
  const tables = new Set();
  const functions = new Set();
  const columns = new Set();
  const schemas = new Set();
  for (const sql of sqlTexts) {
    for (const { text } of splitStatements(maskForTopLevelScan(sql))) {
      const table =
        /\bCREATE\s+(?:UNLOGGED\s+|TEMP(?:ORARY)?\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([\w".]+)/i.exec(
          text,
        );
      if (table) tables.add(normalizeIdent(table[1]));
      const view =
        /\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:MATERIALIZED\s+)?VIEW\s+(?:IF\s+NOT\s+EXISTS\s+)?([\w".]+)/i.exec(
          text,
        );
      if (view) tables.add(normalizeIdent(view[1]));
      const schema =
        /\bCREATE\s+SCHEMA\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:AUTHORIZATION\s+\w+\s+)?([\w"]+)/i.exec(
          text,
        );
      if (schema) schemas.add(schema[1].replace(/"/g, '').toLowerCase());
      const fn = /\bCREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+([\w".]+)/i.exec(text);
      if (fn) functions.add(normalizeIdent(fn[1]));
      const alter = /\bALTER\s+TABLE\s+(?:ONLY\s+)?(?:IF\s+EXISTS\s+)?([\w".]+)/i.exec(text);
      if (alter) {
        const tableName = normalizeIdent(alter[1]);
        const addColumn = /\bADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?([\w"]+)/gi;
        let m = addColumn.exec(text);
        while (m !== null) {
          columns.add(`${tableName}.${m[1].replace(/"/g, '').toLowerCase()}`);
          m = addColumn.exec(text);
        }
      }
    }
  }
  return { tables, functions, columns, schemas };
}

/**
 * 1 文から縮小の対象オブジェクトを引く。対象が同一 PR で作られていれば `exempt: true`。
 * 文の先頭に anchor しない: masked text は関数本体・文字列・コメントを潰してあるので、
 * `DO $$ BEGIN REVOKE ...;` のように匿名ブロックの内側にある文も同じ規則で拾える
 * （migration 自身が実行する REVOKE を DO で包んだ形を素通りさせない）。
 * @param {string} text 文（masked）
 * @param {ReturnType<typeof collectCreatedObjects>} created
 * @returns {{ kind: string, target: string, exempt: boolean }[]}
 */
function classifyNarrowing(text, created) {
  // `REVOKE ... ON a, b, c FROM ...` は対象ごとに 1 件にする（#2666 の 6 テーブル列挙）。
  // 関数の引数リスト `f(UUID, TEXT[])` はカンマを含むので、分割前に括弧ごと落とす。
  const revoke =
    /\bREVOKE\b([\s\S]*?)\bON\s+(?:(TABLE|FUNCTION|PROCEDURE|ROUTINE|SEQUENCE|TYPE|SCHEMA|ALL)\s+)?([\s\S]*?)\s+FROM\b/i.exec(
      text,
    );
  if (revoke) {
    const privileges = revoke[1];
    const objectKind = (revoke[2] ?? '').toUpperCase();
    if (objectKind === 'SCHEMA') {
      const schemaName = revoke[3].trim().replace(/"/g, '').toLowerCase();
      return [
        { kind: 'REVOKE', target: `schema ${schemaName}`, exempt: created.schemas.has(schemaName) },
      ];
    }
    if (objectKind === 'ALL') {
      return [{ kind: 'REVOKE', target: revoke[3].trim().replace(/\s+/g, ' '), exempt: false }];
    }
    const idents = revoke[3]
      .replace(/\([^)]*\)/g, '')
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean);
    const isFunction =
      objectKind === 'FUNCTION' || objectKind === 'PROCEDURE' || objectKind === 'ROUTINE';
    const columnLists = [...privileges.matchAll(/\(([^)]*)\)/g)].map((m) => m[1]);
    const cols = columnLists
      .flatMap((list) => list.split(','))
      .map((c) => c.replace(/"/g, '').trim().toLowerCase())
      .filter(Boolean);
    return idents.map((ident) => {
      const target = normalizeIdent(ident);
      if (isFunction) return { kind: 'REVOKE', target, exempt: created.functions.has(target) };
      if (created.tables.has(target)) return { kind: 'REVOKE', target, exempt: true };
      if (cols.length > 0) {
        const allNew = cols.every((c) => created.columns.has(`${target}.${c}`));
        return { kind: 'REVOKE', target, exempt: allNew };
      }
      return { kind: 'REVOKE', target, exempt: false };
    });
  }

  const dropPolicy = /\bDROP\s+POLICY\s+(?:IF\s+EXISTS\s+)?(?:"[^"]*"|\w+)\s+ON\s+([\w".]+)/i.exec(
    text,
  );
  if (dropPolicy) {
    const target = normalizeIdent(dropPolicy[1]);
    return [{ kind: 'DROP_POLICY', target, exempt: created.tables.has(target) }];
  }

  const dropTable = /\bDROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?([\w".]+)/i.exec(text);
  if (dropTable) {
    const target = normalizeIdent(dropTable[1]);
    return [{ kind: 'DROP_TABLE', target, exempt: created.tables.has(target) }];
  }

  const dropFunction = /\bDROP\s+FUNCTION\s+(?:IF\s+EXISTS\s+)?([\w".]+)/i.exec(text);
  if (dropFunction) {
    const target = normalizeIdent(dropFunction[1]);
    return [{ kind: 'DROP_FUNCTION', target, exempt: created.functions.has(target) }];
  }

  const alter = /\bALTER\s+TABLE\s+(?:ONLY\s+)?(?:IF\s+EXISTS\s+)?([\w".]+)/i.exec(text);
  if (alter) {
    const target = normalizeIdent(alter[1]);
    const tableIsNew = created.tables.has(target);
    const dropColumn = /\bDROP\s+COLUMN\s+(?:IF\s+EXISTS\s+)?([\w"]+)/i.exec(text);
    if (dropColumn) {
      const col = dropColumn[1].replace(/"/g, '').toLowerCase();
      return [
        {
          kind: 'DROP_COLUMN',
          target: `${target}.${col}`,
          exempt: tableIsNew || created.columns.has(`${target}.${col}`),
        },
      ];
    }
    if (/\bRENAME\s+(COLUMN|TO)\b/i.test(text)) {
      return [{ kind: 'RENAME', target, exempt: tableIsNew }];
    }
    if (/\bALTER\s+COLUMN\s+\S+\s+(?:SET\s+DATA\s+)?TYPE\b/i.test(text)) {
      return [{ kind: 'ALTER_COLUMN_TYPE', target, exempt: tableIsNew }];
    }
  }
  return [];
}

/**
 * 追加 migration 群のうち、**既存オブジェクト**の契約を縮める文を列挙する。
 * @param {{ path: string, content: string }[]} addedMigrations
 * @returns {{ path: string, line: number, kind: string, target: string, snippet: string }[]}
 */
export function detectContractNarrowing(addedMigrations) {
  const created = collectCreatedObjects(addedMigrations.map((f) => f.content));
  const findings = [];
  for (const file of addedMigrations) {
    const rawLines = file.content.split('\n');
    for (const { text, line } of splitStatements(maskForTopLevelScan(file.content))) {
      for (const hit of classifyNarrowing(text, created)) {
        if (hit.exempt || !NARROWING_KINDS.has(hit.kind)) continue;
        findings.push({
          path: file.path,
          line,
          kind: hit.kind,
          target: hit.target,
          snippet: (rawLines[line - 1] ?? '').trim().slice(0, 200),
        });
      }
    }
  }
  return findings.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
}

// 旧 build が配信され続ける側 = product の runtime。web は DB を触らない。
// test / story / 生成型（migration と同時に更新するのが正）は runtime に乗らないので除く。
const NON_RUNTIME_PATH = [
  /\.test\.[cm]?[jt]sx?$/,
  /\.stories\.[jt]sx?$/,
  /(^|\/)__tests__\//,
  /^apps\/product\/src\/lib\/test\//,
  /^apps\/product\/src\/lib\/database\/generated\//,
  /\.mdx?$/,
];

/** @param {string} path */
export function isProductRuntimePath(path) {
  if (!path.startsWith('apps/product/') && !path.startsWith('packages/')) return false;
  return !NON_RUNTIME_PATH.some((re) => re.test(path));
}

/**
 * @param {{ addedMigrations: { path: string, content: string }[], prFiles: string[] }} input
 * @returns {{ coupled: boolean, narrowing: ReturnType<typeof detectContractNarrowing>, appFiles: string[] }}
 */
export function evaluateCoupledMigration({ addedMigrations, prFiles }) {
  const narrowing = detectContractNarrowing(addedMigrations);
  const appFiles = prFiles.filter(isProductRuntimePath);
  return { coupled: narrowing.length > 0 && appFiles.length > 0, narrowing, appFiles };
}

/**
 * @param {ReturnType<typeof evaluateCoupledMigration>} evaluation
 */
export function formatCoupledSummary(evaluation) {
  const lines = [
    '## Coupled migration（この PR は merge できません）',
    '',
    '❌ **既存オブジェクトの契約を縮める migration と、product の runtime コード変更が同一 PR にあります。**',
    '',
    'Supabase の GitHub 連携は main merge 時点で migration を production へ適用しますが、Vercel の promote は E2E 完走後の別 job です。promote が失敗している間、**旧 build が新 schema に当たり続けます**（2026-09-08、#2672 で 5 時間 4 分。`mfa_recovery_codes` の直接 INSERT が revoke 後も旧 build から呼ばれ続けた）。',
    '',
    '### 縮小している文',
  ];
  for (const f of evaluation.narrowing) {
    lines.push(`- \`${f.path}\` L${f.line} **${f.kind}** \`${f.target}\`: \`${f.snippet}\``);
  }
  lines.push('', '### 同一 PR の runtime 変更');
  for (const p of evaluation.appFiles.slice(0, 20)) lines.push(`- \`${p}\``);
  if (evaluation.appFiles.length > 20) lines.push(`- ほか ${evaluation.appFiles.length - 20} 件`);
  lines.push(
    '',
    '### 直し方',
    '',
    '1. **app コードだけの PR を先に出荷する**（旧 schema でも新 schema でも動く形にする。旧経路への参照をゼロにする）',
    '2. production に promote されたことを確認してから、**migration だけの PR** を merge する',
    '',
    '新規オブジェクト（同一 PR の `CREATE TABLE` / `CREATE FUNCTION` / `ADD COLUMN`）への REVOKE / DROP は旧 build が知らないので対象外です。規律は `docs/decisions.md` 2026-09-04 [db]（#2175）、順序表は `docs/engineering/infra.md` §スキーマ変更を含むリリースの順序。',
  );
  return `${lines.join('\n')}\n`;
}

// ─── CLI ────────────────────────────────────────────────────────────

async function readStdin() {
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

const isDirectRun = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  const args = process.argv.slice(2);
  const useStdin = args.includes('--stdin');
  const githubOutput = args.includes('--github-output');

  if (!useStdin) {
    process.stderr.write('usage: check-destructive-migration.mjs --stdin < files.ndjson\n');
    process.exitCode = 1;
  } else {
    const raw = await readStdin();
    // risk-reviewer 指摘（#2271/#2272 push前反証レビュー）: `gh api --paginate` は
    // ページごとに jq filter を適用して stdout へ流すため、単一 JSON 配列へ包む filter
    // （`[.[] | {...}]`）を使うと複数ページで `[{...}]\n[{...}]` になり JSON.parse が
    // 例外を投げる。この経路を「JSON が壊れている = 検知なし」として fail open すると
    // 複数ページの PR で「安全」という誤った肯定シグナルを積極的に出してしまう。
    // NDJSON（1 行 1 JSON object、`--jq '.[] | {...} | tojson'` の出力形式）へ変更し、
    // ページ境界に対して安全にする。行単位でパースし、壊れた行はスキップして stderr に出す
    // （呼び出し元の workflow 側で「fetch 自体が失敗したか」は別途明示的に判定する）。
    /** @type {{ filename: string, status: string }[]} */
    const entries = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        entries.push(JSON.parse(trimmed));
      } catch (error) {
        process.stderr.write(
          `[check-destructive-migration] skipping unparsable line: ${
            error instanceof Error ? error.message : String(error)
          }\n`,
        );
      }
    }

    const files = entries
      .filter((e) => e && typeof e.filename === 'string' && isMigrationSqlPath(e.filename))
      .map((e) => {
        let content = '';
        try {
          content = readFileSync(resolve(ROOT, e.filename), 'utf8');
        } catch {
          // 削除・rename されたファイル等、ローカルに存在しない場合は空扱い（検知なし）
          content = '';
        }
        return { path: e.filename, status: e.status, content };
      });

    const results = checkFiles(files);

    if (githubOutput) {
      process.stdout.write(formatGithubOutput(results));
    } else {
      process.stdout.write(formatSummary(results));
    }
  }
}
