---
status: current
last_verified: 2026-09-07
---

# 予定・記録の独立モデルへの移行

この変更は2026-09-07に本番適用済み。物理テーブルと保存行は維持し、相互参照と手動 skip の状態だけを撤去した。

## 配備順と復旧

1. `[hours]` 本番と同じ旧スキーマの隔離環境へバックアップを復元する。予定・記録について `id` と全列を保存し、復元できることを確認する。実値をリポジトリへ保存しない。
2. `[hours]` `supabase/migrations/20260907081237_independent_plan_record_commands.sql` を適用する。旧列は残すが、FK・関連トリガー・関連一意制約を外し、書き込み関数を独立操作へ置換する。特に FK をこの段階で外し、予定削除による記録への副作用をなくす。旧アプリが送るリンク引数は受理して保存せず、旧skip writerはロールバック互換のため維持する。
3. `[hours]` アプリを更新し、Previewで操作・API・Undo・集計を検証する。契約撤去前なら旧コードと旧関数へ戻せる。ただし新規の独立記録を勝手に再リンクしてはならない。
4. `[hours]` 列撤去だけの別PRで `supabase/migrations/20260907125000_drop_plan_record_relation_columns.sql` を検証する。旧skip writerを明示エラーへ替え、新規Undoからskip項目を拒否し、移行前の通常Plan作成Undoだけ互換適用してから列を落とす。`CASCADE` は使わない。
5. `[irreversible]` 独立レビュー・Preview確認・バックアップ復元検証と明示的な出荷指示が揃った後に撤去を適用する。以後の関連情報・旧状態の復旧にはバックアップが必要。保持列・行集合に意図しない差があれば移行失敗として扱う。

各migrationはlock timeout 5秒、statement timeout 30秒。ロック取得失敗時は中断し、部分適用しない。旧migrationは改変しない。

## 行保存の検証

隔離DBで次を順に実行する。`before` は合成fixtureを追加するため、既存ユーザーのDBでは実行しない。

- `supabase/tests/derived-migration-before.sql`: 旧リンク付き記録・旧skip付き予定を作成し、全保持列のスナップショットを保存。
- 拡張migration → `supabase/tests/derived-migration-after.sql`。
- contract migration → 同じ `derived-migration-after.sql`。

比較は両方向の `EXCEPT` で、ID集合・件数・全保持列（所有者、論理削除、更新日時、外部参照を含む）を検証する。第1段階とcontract段階のfixture検証はいずれも差分0件で、旧リンク付き記録1件と旧skip付き予定1件の保持列と行が残った。

`supabase/tests/independent-plan-record.sql` はトランザクション内で操作し、最後にrollbackする。コピー、重複拒否、移動・伸縮・アクティビティ変更、再コピー、一部重複の一括除外、一括再実行、所有者分離、削除・復元、旧入力を保存に使わないことを検証する。

## 公開契約

- MCP読み取りスキーマはv4。予定・記録の関連IDとskip状態は返さない。nullまたは省略のリンク入力は独立作成として受理し、非nullは更新案内付き入力エラー。ただし配備前に同じ旧入力で成功済みのoperationIdは、保存済みreceiptを先に照合して冪等に再生する。
- MCP reviewの期間は `active_overlapping_period` / `clipped_to_period`。従来の開始時刻による選択・全行時間から期間交差時間へ変更する。予算差・精度の既存フィールドは維持する。
- レポートの予定比・見積もり係数は記録合計 / 経過済み予定合計。分母15分未満は表示しない。作成時見積もりは直近28日の期間合計比で、予定別比率の中央値ではない。
- CSVからリンク・skip列を除く。外部カレンダー参照は維持する。
- 過去のmutation receiptの版と冪等性digestは変更しない。旧skip更新のUndoは適用前にDR008で原子的に拒否する。full maskにskipped_atを含む旧形式の通常Plan作成Undoは維持する。通常のUndo対象IDは関連IDではない。

## 監査の分類

具体的な変更前の検索位置は [監査一覧](./independent-plan-record-audit.md) に記録する。行番号は変更前の基準SHAに対する位置。

- **撤去・置換**: 保存用リンク列、skip列、FK/index/trigger、writer側相互検証、Inspectorの元予定、カードの個別差分、リンク検索、CSV、公開projection、関連比率・中央値。
- **正当な残存**: 操作対象の予定ID、Undo effectの対象ID、外部予定参照、旧入力の明示拒否と成功済みMCP receipt再生に必要なRPC引数。
- **履歴**: 適用済みmigration、旧不変条件を説明する歴史的文書、移行前データを作る検証fixture。新規書き込み・読み取りの根拠にはしない。

contract migrationは本番と検証専用DBへ適用済み。既存の共有ローカルSupabaseには適用していない。

## ローカル検証記録

- Node 24で `pnpm check`: exit 0。内包するtypecheck、lint、境界・token・format・i18n・copy検査、deadcode検査を通過。
- 同コマンドの単体テストは合計5,703件（Product 3,944、Web 288、scripts 1,402、共有package 69）。
- `derived-migration-after.sql`: 第1段階で保持列一致。移行前に保存した旧skip更新receiptのDR008による原子的拒否、旧形式の通常Plan作成Undo、通常Undoの再試行も検証。
- `independent-plan-record-concurrency.py dayopt_derived_pr1_*`: 同時一括要求の作成数 `[0, 1]`、保存記録1件。
- contract用隔離DB `dayopt_derived_contract_2648`: expand前fixture → expand migration → contract migration → `derived-migration-after.sql` を順に適用し、保持列の両方向差分0件。旧skip更新UndoはDR008、旧形式の通常Plan作成Undoと通常Undoの再試行は成功。
- 同じ隔離DBで `independent-plan-record.sql`: exit 0。旧列が行型に存在しないこと、旧skip writerがDT012で拒否されること、コピー・一括記録・相互非干渉を確認。
- 認証済みブラウザE2E `derived-plan-record-flow.spec.ts` で、同一週内の記録ドラッグ後に予定Inspectorの記録一覧だけが消え、レポートの予定比150%は維持されることを確認。ローカル隔離ユーザーと共有ローカルSupabaseでexit 0。共有ローカルDBは旧スキーマのままであり、そこへ今回のmigrationを適用して検証したことにはしない。Supabase/Vercel Previewは成功。
- 独立レビューで修正した点: DB先行配備中の旧writer互換、成功済みMCP再送、旧形式の通常Plan作成Undo、公開tRPCのskip入力、純粋モデルとDB変換の配置。
- セルフレビューで修正した点: 拡張段階にも残るFKの副作用、旧列がAPI応答へ混ざる問題、取得上限による集計漏れ、変更後の集計キャッシュ再取得。

## 本番適用前の復旧証跡

2026-09-07 22:15 JSTに本番をread-onlyで確認し、expand migration `20260907081237` の適用、Plan 54行、Record 72行、旧リンク42件、skip済み0件を確認した。

不可逆に失われる値だけを `~/Backups/dayopt/plan-record-contract-before-20260907.json` へ保存した。ファイルは所有者のみ読み書き可能なmode 600で、SHA-256は `ac264faa5804507fda76e1ee232f5c98c7320fcbe3eede26ca2e6bad9d50a9bd`。メモ、タイトル、所有者などの保持列は含めない。保持列と行集合はtransactional migrationと上記fixture検証で保護する。

このbackupをcontract適用済み隔離DBの一時テーブルへUUID / timestamptz型で復元し、旧リンク42件・skip値0件が一致することを確認してrollbackした。Supabase組織はProでdaily physical backup対象だが、CLI credentialが未認証だったため直近backupの成功時刻は取得していない。この契約専用backupと復元演習を今回の撤去のrollback証跡とする。

## 本番適用結果

2026-09-07にPR #2649をmerge commit `ea52ad484f6552f77b187eaace7fdcf299a0e4e0` でmainへ取り込み、本番migration `20260907125000_drop_plan_record_relation_columns` を適用した。

- `records.plan_id` と `plans.skipped_at` は不存在。両列を参照するindex / constraintも0件。
- 適用前後ともPlan 54行・Record 72行で、行削除は発生していない。
- 旧skip RPCはDT012を返す互換stubとして残存。
- Production Release run `34130076165` はProduct E2EとProduction promotionを含め成功。
- `https://dayopt.app/` と `https://app.dayopt.app/api/health` はHTTP 200。health responseは `{"status":"healthy"}`。
- Supabase advisorは適用前後ともsecurity 9件、performance 57件で、新規指摘なし。Vercelの直近15分のruntime errorも0件。
