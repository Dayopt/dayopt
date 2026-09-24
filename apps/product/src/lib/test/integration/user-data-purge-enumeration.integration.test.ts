/**
 * account-preserving purge の列挙漏れを機械で止める（#2444）。
 *
 * 実行: USE_LOCAL_DB=true pnpm test:integration
 * RUN_LOCAL が false だと describe ごと skip されるため、**passed 件数を読む**こと。
 * skipped は緑に見えるが何も検証していない。
 *
 * account-preserving purge は `auth.users` を消さずにユーザーデータだけを消す。消す対象は
 * **関数本文の列挙**であり、新しいテーブルを足した人が列挙にも足すことを覚えていないと
 * 静かに漏れる。実際 2 回起きている:
 *
 *   1 回目 — #2162（2026-08-18）で `tags` を `activities` / `categories` / `segments` へ
 *            置き換えた時。旧モデルは消えるのに後継が残るという逆転が 9 日間続いた
 *   2 回目 — #2433 の plan review で新規 `undo_receipts` について同じ指摘が出た時、
 *            裏取りで 1 回目が発覚した（#2444）
 *
 * **検査対象の関数名をハードコードしない。** 3 回目は「直したつもりの関数が製品経路に
 * 無い」形で起きかけた（Codex C の P1、2026-08-27）— #2444 の修復と初版のこの test は
 * どちらも `v3` を見ていたが、製品は `v5 → v4` を通る。v3 には生きた呼び出し元が無く、
 * **製品経路は壊れたまま test が green を返していた**。
 *
 * だからここでは **製品コードの RPC 定数を起点に、DB 側の呼び出しチェーンを辿って**
 * 検査対象を決める。関数名を固定する限り、また同じ形で死んだ関数を検査しうる。
 *
 * `user_id` を持つ `public` の table は、次のどれか 1 つに必ず該当しなければならない:
 *
 *   A. purge チェーンのどれかの関数が直接 DELETE する
 *   B. A のいずれかから ON DELETE CASCADE で到達できる（＝消える）
 *   C. 下の allowlist に「消さない理由」付きで載っている
 *
 * どれにも当てはまらない table が現れたらこの test が落ちる。新規テーブルを足した PR は
 * その場で「消すのか、消さないのか」を決めさせられる。
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const RUN_LOCAL = process.env.USE_LOCAL_DB === 'true';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../..');
/** 製品の削除経路の入口。ここに書かれた RPC 名が唯一の起点。 */
const ACCOUNT_DELETION_SOURCE = resolve(
  REPO_ROOT,
  'apps/product/src/features/external-calendar/server/account-deletion.ts',
);

/**
 * 製品コードから purge の入口 RPC 名を読む。
 *
 * **test 側に関数名を書かない**のが要点。書くと、製品が別の version を呼ぶようになった
 * 時に test だけが古い関数を検査し続ける（#2444 の修復で実際に起きかけた）。
 */
function productPurgeEntryPoint(): string {
  const source = readFileSync(ACCOUNT_DELETION_SOURCE, 'utf8');
  const match = /const\s+DELETE_ALL_DATA_RPC\s*=\s*'([^']+)'/.exec(source);
  if (!match) {
    throw new Error(
      `DELETE_ALL_DATA_RPC が ${ACCOUNT_DELETION_SOURCE} に見つからない。` +
        '製品の削除経路が変わったなら、この test の入口検出も更新すること。',
    );
  }
  return match[1]!;
}

/**
 * purge が**意図的に消さない** table と、その理由。
 *
 * 「漏れ」と「意図的な保持」が見分けられない状態そのものが再発の温床だったので、
 * ここに理由まで書く。次に棚卸しする人が同じ table を ⚠️ として拾い直さずに済む。
 *
 * mfa_recovery_codes / oauth_audit_log / product_events の 3 件は 2026-08-27 に
 * User 裁可で「3 件とも現状維持」と確定した（#2444）。
 */
const INTENTIONALLY_RETAINED: Record<string, string> = {
  mfa_recovery_codes:
    'アカウントを保持するなら資格情報も保持する（purge 後もログインできる必要がある）。2026-08-27 User 裁可',
  oauth_audit_log: '監査ログを削除対象にすると監査の意味が消える。2026-08-27 User 裁可',
  product_events: '個人データ性が低い分析イベント。2026-08-27 User 裁可',
  mcp_mutation_receipts:
    '削除ではなく tombstone 方式（purged_generation / purged_at を打つ）。設計どおり',
  oauth_authorization_codes: '削除ではなく consumed_at を打って無効化する（OAuth ライフサイクル）',
  oauth_connections: '削除ではなく revoked_at / revoked_reason を打って失効させる',
  undo_receipts:
    '#2434: 削除ではなく tombstone として残す。親行は PII を持たず（PII は undo_receipt_effects/field_changes 側）、UNIQUE(user_id, operation_id) が遅延再送への冪等ガードを兼ねる。PII は undo_receipt_effects の直接 DELETE（CASCADE で field_changes も消える）で除去する',
  oauth_tokens: '削除ではなく revoked_at を打って失効させる',
};

/**
 * email を持ちながら、**アカウント削除でも purge でも消えない** table と、その理由。
 *
 * 上の列挙 test は「`user_id` を持つ public table」だけを母集合にするため、email を key に
 * 持つ table はそもそも検査対象に入らない。2026-09-20 の境界検証で `email_suppressions` が
 * この死角にあった（account deletion 後も raw email が残り、Privacy Policy の「削除後 30 日
 * 以内に完全削除」と食い違う）。ここに載せるのは「決めた」ことの記録であって、正当化ではない。
 * 消す方針にした時はこの allowlist から外し、削除経路（account deletion coordinator）へ足す。
 *
 * **`auth.users` から `ON DELETE CASCADE` で到達できる table は対象外**（`profiles` など）。
 * それらは `user_id` 列を持たなくてもアカウント削除で確実に消えるので、ここで決める話が無い。
 */
const EMAIL_KEYED_WITHOUT_USER_ID: Record<string, string> = {
  email_suppressions:
    '未裁定。bounce / complaint 済み address の配信評価保護が目的で、account deletion でも消さない。' +
    '削除後も raw email が残るため Privacy Policy と不整合（#2859 で裁定する）',
};

/**
 * 入口 RPC から `PERFORM` / `SELECT` で辿れる関数を再帰的に集める CTE（`purge_chain` /
 * `purge_body`）。列挙 test と email 列 test の両方が使うので、**1 箇所で定義する**
 * （2 つに書き分けると「片方だけ purge の到達判定が古い」状態が静かに生まれる）。
 */
function purgeChainCte(entryPoint: string): string {
  return `
    purge_chain(schema_name, proname) AS (
      SELECT 'public'::name, '${entryPoint}'::name
      UNION
      SELECT callee.schema_name, callee.proname
      FROM purge_chain
      JOIN pg_proc AS caller ON caller.proname = purge_chain.proname
      JOIN pg_namespace AS caller_ns
        ON caller_ns.oid = caller.pronamespace AND caller_ns.nspname = purge_chain.schema_name
      CROSS JOIN LATERAL regexp_matches(
        caller.prosrc, '\\m(?:PERFORM|SELECT)\\s+(public|private)\\.(\\w+)\\s*\\(', 'g'
      ) AS m
      CROSS JOIN LATERAL (SELECT m[1]::name AS schema_name, m[2]::name AS proname) AS callee
      WHERE EXISTS (
        SELECT 1 FROM pg_proc AS p2
        JOIN pg_namespace AS n2 ON n2.oid = p2.pronamespace
        WHERE n2.nspname = callee.schema_name AND p2.proname = callee.proname
      )
    ),
    purge_body AS (
      SELECT string_agg(routine.prosrc, E'\\n') AS src
      FROM purge_chain
      JOIN pg_proc AS routine ON routine.proname = purge_chain.proname
      JOIN pg_namespace AS ns
        ON ns.oid = routine.pronamespace AND ns.nspname = purge_chain.schema_name
    )`;
}

function runOwnerSql(sql: string): string {
  const result = spawnSync(
    'psql',
    [
      '-X',
      '-qAt',
      '-v',
      'ON_ERROR_STOP=1',
      '-h',
      '127.0.0.1',
      '-p',
      '54322',
      '-U',
      'postgres',
      '-d',
      'postgres',
      '-c',
      sql,
    ],
    { encoding: 'utf8', env: { ...process.env, PGPASSWORD: 'postgres' } },
  );
  if (result.status !== 0) {
    throw new Error(`psql failed (${result.status}): ${result.stderr}`);
  }
  return result.stdout.trim();
}

describe.skipIf(!RUN_LOCAL)('account-preserving purge の列挙 (#2444)', () => {
  /**
   * A ∪ B の集合を **DB 側で** 計算する。
   *
   * B（CASCADE 到達）を再帰で辿るのが要点。子テーブルを足した時に purge の列挙へ
   * 足す必要が無いのは「親が消えれば CASCADE で消えるから」であって、その事実は
   * pg_constraint に書いてある。人間の記憶ではなくカタログから導く。
   */
  const entryPoint = productPurgeEntryPoint();

  /**
   * 入口 RPC から `PERFORM` / `SELECT` で辿れる関数を再帰的に集める。
   *
   * v5 のように「自分では消さず別 version へ委譲する」形があるため、入口 1 本だけを見ても
   * 何が消えるかは分からない。**チェーン全体の DELETE の和**が実際の削除対象になる。
   */
  const purgeCoverageSql = `
    WITH RECURSIVE ${purgeChainCte(entryPoint)},
    user_tables AS (
      SELECT relation.oid, relation.relname
      FROM pg_class AS relation
      JOIN pg_namespace AS ns ON ns.oid = relation.relnamespace
      JOIN pg_attribute AS attribute
        ON attribute.attrelid = relation.oid
       AND attribute.attname = 'user_id'
       AND attribute.attnum > 0
       AND NOT attribute.attisdropped
      WHERE ns.nspname = 'public' AND relation.relkind = 'r'
    ),
    -- A: purge 本文が直接 DELETE している table
    directly_deleted AS (
      SELECT user_tables.oid, user_tables.relname
      FROM user_tables, purge_body
      WHERE purge_body.src ~ ('DELETE FROM public\\.' || user_tables.relname || '\\M')
    ),
    -- B: A から ON DELETE CASCADE の辺だけを辿って到達できる table
    cascade_reachable AS (
      WITH RECURSIVE walk(oid) AS (
        SELECT oid FROM directly_deleted
        UNION
        SELECT child.conrelid
        FROM pg_constraint AS child
        JOIN walk ON walk.oid = child.confrelid
        WHERE child.contype = 'f' AND child.confdeltype = 'c'
      )
      SELECT oid FROM walk
    )
    SELECT user_tables.relname,
           (user_tables.oid IN (SELECT oid FROM directly_deleted)) AS directly_deleted,
           (user_tables.oid IN (SELECT oid FROM cascade_reachable)) AS cascade_reachable
    FROM user_tables
    ORDER BY user_tables.relname;
  `;

  function coverage() {
    return runOwnerSql(purgeCoverageSql)
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [relname, direct, cascade] = line.split('|');
        return {
          relname,
          directlyDeleted: direct === 't',
          cascadeReachable: cascade === 't',
        };
      });
  }

  it('user_id を持つ public table が 1 件以上見つかる（クエリ自体が空振りしていない）', () => {
    // 空配列に対する every() は自明に true になるので、本命の test が「何も検査せず緑」に
    // なる経路を先に塞ぐ。
    expect(coverage().length).toBeGreaterThan(10);
  });

  it('purge が消さない table は、すべて理由付きで allowlist に載っている', () => {
    const unaccounted = coverage()
      .filter((row) => !row.cascadeReachable)
      .filter((row) => !(row.relname in INTENTIONALLY_RETAINED))
      .map((row) => row.relname);

    // 落ちた時に「何をすればいいか」がメッセージだけで分かるようにする。
    expect(
      unaccounted,
      unaccounted.length === 0
        ? ''
        : [
            `account-preserving purge から漏れている table: ${unaccounted.join(', ')}`,
            '',
            '次のどちらかを選ぶこと:',
            `  - 消す  → 製品経路の purge（入口: ${entryPoint}）の列挙へ DELETE を追加する`,
            '           **委譲先の関数へ足すこと**。入口が委譲するだけの薄い関数の場合、',
            '           入口へ足しても実際には実行されない',
            '  - 消さない → この test の INTENTIONALLY_RETAINED へ理由付きで追加する',
            '',
            'どちらでもない状態＝「決め忘れ」であり、#2162 / #2444 で 2 回起きた漏れの正体。',
          ].join('\n'),
    ).toEqual([]);
  });

  it('email を持ちアカウント削除でも消えない public table は、扱いが理由付きで決まっている', () => {
    // 列挙 test の母集合（user_id を持つ table）から漏れる PII 保持 table を機械で拾う。
    //
    // `user_id` が無いだけでは「消えない」根拠にならない。`profiles` は `id` が
    // `auth.users(id)` を `ON DELETE CASCADE` で参照するのでアカウント削除で消える。
    // 同様に、purge chain が直接 DELETE する table とその CASCADE 到達分も消える。
    // 残すべき問いは「email を持つのに、そのどれからも到達されない table」だけなので、
    // 両方の到達集合（deletion_closure）を DB 側で引いてから比べる。
    // 片方だけで引くと、purge 経路へ table を足した時に「消えるのに未決」で落ちる。
    const rows = runOwnerSql(`
      WITH RECURSIVE ${purgeChainCte(entryPoint)},
      -- アカウント削除で消える起点: auth.users 本体と、purge chain が直接 DELETE する table。
      -- 製品の削除経路は coordinator の step → purge RPC → auth.users 削除の順に進むので、
      -- どちらか片方だけを見ると「消えるのに未決として検出される」table が出る。
      deletion_seed AS (
        SELECT users.oid
        FROM pg_class AS users
        JOIN pg_namespace AS auth_ns ON auth_ns.oid = users.relnamespace
        WHERE auth_ns.nspname = 'auth' AND users.relname = 'users'
        UNION
        SELECT relation.oid
        FROM pg_class AS relation
        JOIN pg_namespace AS ns ON ns.oid = relation.relnamespace
        CROSS JOIN purge_body
        WHERE ns.nspname = 'public'
          AND relation.relkind = 'r'
          AND purge_body.src ~ ('DELETE FROM public\\.' || relation.relname || '\\M')
      ),
      -- 起点から ON DELETE CASCADE の辺だけを辿って到達できる table を足した閉包
      deletion_closure(oid) AS (
        SELECT oid FROM deletion_seed
        UNION
        SELECT child.conrelid
        FROM pg_constraint AS child
        JOIN deletion_closure ON deletion_closure.oid = child.confrelid
        WHERE child.contype = 'f' AND child.confdeltype = 'c'
      )
      SELECT relation.relname
      FROM pg_class AS relation
      JOIN pg_namespace AS ns ON ns.oid = relation.relnamespace
      WHERE ns.nspname = 'public'
        AND relation.relkind = 'r'
        AND relation.oid NOT IN (SELECT oid FROM deletion_closure)
        AND EXISTS (
          SELECT 1 FROM pg_attribute AS email_column
          WHERE email_column.attrelid = relation.oid
            AND email_column.attname = 'email'
            AND email_column.attnum > 0
            AND NOT email_column.attisdropped
        )
        AND NOT EXISTS (
          SELECT 1 FROM pg_attribute AS owner_column
          WHERE owner_column.attrelid = relation.oid
            AND owner_column.attname = 'user_id'
            AND owner_column.attnum > 0
            AND NOT owner_column.attisdropped
        )
      ORDER BY relation.relname;
    `)
      .split('\n')
      .filter(Boolean);

    const undecided = rows.filter((name) => !(name in EMAIL_KEYED_WITHOUT_USER_ID));
    expect(
      undecided,
      undecided.length === 0
        ? ''
        : `email を持ちアカウント削除でも消えない table の扱いが未決: ${undecided.join(', ')}。` +
            '消すなら削除経路へ足し、消さないなら EMAIL_KEYED_WITHOUT_USER_ID へ理由を書く',
    ).toEqual([]);

    const stale = Object.keys(EMAIL_KEYED_WITHOUT_USER_ID).filter((name) => !rows.includes(name));
    expect(
      stale,
      stale.length === 0
        ? ''
        : `allowlist に死んだエントリ: ${stale.join(', ')}。削除経路へ入ったなら allowlist から外す`,
    ).toEqual([]);
  });

  it('allowlist に死んだエントリが残っていない', () => {
    // 消す方針へ変えた table が allowlist に残り続けると、次に本当に漏れた時の
    // 検出力が落ちる。allowlist 自体の鮮度もここで守る。
    const present = new Set(coverage().map((row) => row.relname));
    const stale = Object.keys(INTENTIONALLY_RETAINED).filter((name) => {
      if (!present.has(name)) return true; // table 自体が消えた
      const row = coverage().find((entry) => entry.relname === name);
      return row?.cascadeReachable === true; // 消える側になったのに allowlist に残っている
    });
    expect(stale).toEqual([]);
  });

  it('入口 RPC が製品コードから読めている', () => {
    // ここが空振りすると以降の SQL が「存在しない関数」を起点にし、チェーンが空のまま
    // 全 test が vacuous に通る。先に潰しておく。
    expect(entryPoint).toMatch(/^delete_all_user_data_command_v\d+$/);
  });

  it('入口 RPC が DB に実在し、チェーンが実際に削除へ到達する', () => {
    // Codex C の P1 の再発防止。「入口はあるが、そこから辿れる関数がどれも DELETE を
    // 持たない」= 製品経路が何も消していない状態を検出する。
    const rows = coverage();
    expect(
      rows.some((row) => row.directlyDeleted),
      [
        `入口 ${entryPoint} から辿れる関数が 1 つも DELETE を持たない。`,
        '製品の削除経路が壊れているか、この test のチェーン解決が入口を見失っている。',
      ].join('\n'),
    ).toBe(true);
  });

  it('製品経路が委譲先まで正しく辿れている（v5 -> v4 の委譲）', () => {
    // 入口が「委譲するだけ」の場合、入口の本文だけを見ると削除対象がゼロに見える。
    // チェーン解決が委譲を追えていることを明示的に固定する。
    const chainSql = `
      WITH RECURSIVE purge_chain(schema_name, proname) AS (
        SELECT 'public'::name, '${entryPoint}'::name
        UNION
        SELECT callee.schema_name, callee.proname
        FROM purge_chain
        JOIN pg_proc AS caller ON caller.proname = purge_chain.proname
        JOIN pg_namespace AS caller_ns
          ON caller_ns.oid = caller.pronamespace AND caller_ns.nspname = purge_chain.schema_name
        CROSS JOIN LATERAL regexp_matches(
          caller.prosrc, '\\m(?:PERFORM|SELECT)\\s+(public|private)\\.(\\w+)\\s*\\(', 'g'
        ) AS m
        CROSS JOIN LATERAL (SELECT m[1]::name AS schema_name, m[2]::name AS proname) AS callee
        WHERE EXISTS (
          SELECT 1 FROM pg_proc AS p2
          JOIN pg_namespace AS n2 ON n2.oid = p2.pronamespace
          WHERE n2.nspname = callee.schema_name AND p2.proname = callee.proname
        )
      )
      SELECT proname FROM purge_chain
      WHERE schema_name = 'public' AND proname LIKE 'delete_all_user_data_command_v%'
      ORDER BY proname;
    `;
    const chain = runOwnerSql(chainSql).split('\n').filter(Boolean);
    expect(chain).toContain(entryPoint);
    // 入口以外の purge version も辿れている（= 委譲を追えている）
    expect(chain.length).toBeGreaterThan(1);
  });

  it('#2444 の回帰: 分類モデル 3 件が purge 対象に入っている', () => {
    const rows = coverage();
    for (const name of ['activities', 'categories', 'segments']) {
      const row = rows.find((entry) => entry.relname === name);
      expect(row, `${name} が user_id を持つ public table として見つからない`).toBeDefined();
      expect(row?.directlyDeleted, `${name} が purge の列挙に無い（#2444 の回帰）`).toBe(true);
    }
  });

  it('#2434: undo substrate は effects を直接 DELETE し、receipts 親行は tombstone として残す', () => {
    const rows = coverage();
    // PII（before_value/after_value）を持つ effects を直接 DELETE し、field_changes は
    // CASCADE で落とす。PII を持たない receipts 親行は消さない（INTENTIONALLY_RETAINED）。
    expect(rows.find((entry) => entry.relname === 'undo_receipt_effects')?.directlyDeleted).toBe(
      true,
    );
    expect(
      rows.find((entry) => entry.relname === 'undo_receipt_field_changes')?.cascadeReachable,
      'undo_receipt_field_changes が CASCADE で到達できない',
    ).toBe(true);
    expect(
      rows.find((entry) => entry.relname === 'undo_receipts')?.directlyDeleted,
      'undo_receipts が直接 DELETE されている（tombstone として残す設計に反する）',
    ).toBe(false);
  });

  it('CASCADE 頼みの table が実際に CASCADE 経路を持つ', () => {
    // 「列挙しなくてよい」と判断した根拠そのものを固定する。
    const rows = coverage();
    for (const name of ['segment_activities', 'calendar_connection_calendars']) {
      const row = rows.find((entry) => entry.relname === name);
      expect(row?.directlyDeleted, `${name} は直接 DELETE していない前提`).toBe(false);
      expect(row?.cascadeReachable, `${name} が CASCADE で到達できない`).toBe(true);
    }
  });
});
