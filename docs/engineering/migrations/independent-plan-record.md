# 予定・記録の独立モデルへの移行

この変更はローカル検証済みの実装であり、本番適用を意味しない。物理テーブルと保存行は維持し、相互参照と手動 skip の状態だけを撤去する。

## 配備順と復旧

1. `[hours]` 本番と同じ旧スキーマの隔離環境へバックアップを復元する。予定・記録について `id` と全列を保存し、復元できることを確認する。実値をリポジトリへ保存しない。
2. `[hours]` `supabase/migrations/20260907081237_independent_plan_record_commands.sql` を適用する。旧列は残すが、FK・関連トリガー・関連一意制約を外し、書き込み関数を独立操作へ置換する。特に FK をこの段階で外し、予定削除による記録への副作用をなくす。旧非nullリンク入力・skip操作は明示的に拒否する。
3. `[hours]` アプリを更新し、Previewで操作・API・Undo・集計を検証する。契約撤去前なら旧コードと旧関数へ戻せる。ただし新規の独立記録を勝手に再リンクしてはならない。
4. `[irreversible]` 独立レビュー・Preview確認・バックアップ復元検証と明示的な出荷指示が揃った後、列撤去だけの別PRで通常migrationを新規作成する。その時点の未適用migration順序に合わせて新しいtimestampを使い、第1PRにはDROP文を同梱しない。
5. `[irreversible]` 撤去を適用する。`CASCADE` は使わず依存関数・列を明示的に落とす。以後の関連情報・旧状態の復旧にはバックアップが必要。保持列・行集合に意図しない差があれば移行失敗として扱う。

各migrationはlock timeout 5秒、statement timeout 30秒。ロック取得失敗時は中断し、部分適用しない。旧migrationは改変しない。

## 行保存の検証

隔離DBで次を順に実行する。`before` は合成fixtureを追加するため、既存ユーザーのDBでは実行しない。

- `supabase/tests/derived-migration-before.sql`: 旧リンク付き記録・旧skip付き予定を作成し、全保持列のスナップショットを保存。
- 拡張migration → `supabase/tests/derived-migration-after.sql`。
- 列撤去SQL → 同じ `after.sql`。

比較は両方向の `EXCEPT` で、ID集合・件数・全保持列（所有者、論理削除、更新日時、外部参照を含む）を検証する。fixtureの検証結果は両段階とも差分0件。移行前の完全dumpを別DBへ復元し、比較一致・旧リンク1件・旧skip1件も確認した。

`supabase/tests/independent-plan-record.sql` はトランザクション内で操作し、最後にrollbackする。コピー、重複拒否、移動・伸縮・アクティビティ変更、再コピー、一部重複の一括除外、一括再実行、所有者分離、削除・復元、旧入力拒否を検証する。

## 公開契約

- MCP読み取りスキーマはv4。予定・記録の関連IDとskip状態は返さない。nullまたは省略のリンク入力は独立作成として受理し、非nullは更新案内付き入力エラー。
- MCP reviewの期間は `active_overlapping_period` / `clipped_to_period`。従来の開始時刻による選択・全行時間から期間交差時間へ変更する。予算差・精度の既存フィールドは維持する。
- レポートの予定比・見積もり係数は記録合計 / 経過済み予定合計。分母15分未満は表示しない。作成時見積もりは直近28日の期間合計比で、予定別比率の中央値ではない。
- CSVからリンク・skip列を除く。外部カレンダー参照は維持する。
- 過去のmutation receiptの版と冪等性digestは変更しない。旧skip field changeを含むUndoは、適用前にDR008で原子的に拒否する。通常のUndo対象IDは関連IDではない。

## 監査の分類

具体的な変更前の検索位置は [監査一覧](./independent-plan-record-audit.md) に記録する。行番号は変更前の基準SHAに対する位置。

- **撤去・置換**: 保存用リンク列、skip列、FK/index/trigger、writer側相互検証、Inspectorの元予定、カードの個別差分、リンク検索、CSV、公開projection、関連比率・中央値。
- **正当な残存**: 操作対象の予定ID、Undo effectの対象ID、外部予定参照、旧入力の明示拒否用RPC引数、移行中の不活性な旧列。
- **履歴**: 適用済みmigration、旧不変条件を説明する歴史的文書、移行前データを作る検証fixture。新規書き込み・読み取りの根拠にはしない。

本番・共有ローカルDBには適用していない。検証専用DBのみを使用した。

## ローカル検証記録

- Node 24で `pnpm check`: exit 0。内包するtypecheck、lint、境界・token・format・i18n・copy検査、deadcode検査を通過。
- 同コマンドの単体テストは合計5,690件（Product 3,931、Web 288、scripts 1,402、共有package 69）。
- `derived-migration-after.sql`: 拡張・列撤去の両段階で保持列一致。移行前に保存した旧skip receiptのDR008による原子的拒否、通常Undoの再試行も検証。
- `independent-plan-record-concurrency.py dayopt_derived_validation`: 同時一括要求の作成数 `[0, 1]`、保存記録1件。
- API経由の既存結合テストの旧リンク期待値は更新したが、HTTP経由での実行と認証済みカレンダー/InspectorのE2Eは未実施。既存の共有ローカルSupabaseは旧スキーマのままであり、そこへ今回のmigrationを適用して検証したことにはしない。Previewと独立レビューも未実施。
- セルフレビューで修正した点: 拡張段階にも残るFKの副作用、旧列がAPI応答へ混ざる問題、取得上限による集計漏れ、変更後の集計キャッシュ再取得。
