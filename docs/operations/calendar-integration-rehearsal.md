---
status: draft
last_verified: 2026-09-30
code: apps/product/src/features/external-calendar
---

# Google Calendar Integration 実測手順

Google Calendar の接続・同期・ゴースト表示・明示変換を、固定 Integration URL と専用テストカレンダーで確認する。Production 準備完了とは別に判定する。

## 実行前条件

- 共有 Integration の Calendar 実測に対する保留解除を確認する。固定 Integration の設定保存・接続・同期・変換・切断・配備は引き続き保留。#2910 所有の合成2ユーザーを通常 PR の immutable Preview で検証する限定解除を、Calendar 実測の許可へ読み替えない。
- 固定 URL は `https://product-git-integration-dayopt.vercel.app`。その時点の配備 SHA、Supabase ref、migration、Calendar authority readiness を記録する。過去の Ready 表示を現在の証拠にしない。
- Supabase は `integration` ブランチを確認する。本番 ref `yvglwblxrnrenfifsnje` が接続先なら実測しない。
- Calendar OAuth の5変数は [シークレット台帳](./secrets.md) に従う。Preview / integration 専用 client・secret・暗号鍵と固定 callback を使い、値を証跡へ記載しない。
- 検証用 Dayopt ユーザーの利用許可・ログイン方法・外部同期 entitlement を確認する。他作業の fixture や課金フラグを無断で変更しない。

### Dayopt ログインと Calendar 接続の区別

Dayopt にメールでログインしてから、別の Google アカウントのカレンダーを接続できる。Calendar callback は開始時の Dayopt user と現在のセッション user を照合し、Google の `sub` を別の provider identity として保存する。新規接続で両方のメール一致は要求しない。

今回の Calendar テストは Chrome の「ともや」を使う。管理設定用ブラウザーと混同せず、Google の選択画面でも対象アカウントを確認する。

Dayopt Google ログインの `redirect_uri_mismatch` は別の認証経路の問題であり、メールログインできれば Calendar テストを阻まない。Calendar テストだけのために追加 client を作成したり、Supabase Google provider を変更したりする必要はない。

## テストデータ

専用カレンダーに以下の識別できる予定を用意する。実際の個人予定を変換・削除しない。

| ケース                                 | 期待する結果                                             |
| -------------------------------------- | -------------------------------------------------------- |
| 終了時刻が未来の時間指定予定           | ゴーストをタップすると Plan                              |
| 終了済みの時間指定予定                 | ゴーストをタップすると Record                            |
| 深夜から翌日へ続く時間指定予定         | 日ごとに表示をクリップし、変換では原本の開始・終了を保持 |
| 既存の Dayopt 予定と時間が重複する予定 | 変換失敗を表示し、ゴーストが再表示される                 |
| 繰り返し予定の1回分の変更・取消        | 次の同期で対象回だけ更新・除外                           |
| 終日予定                               | 現行仕様では取り込まない                                 |

## 実測と合格条件

各行に配備 SHA・実行時刻・対象の非秘密 ID・画面の証拠と結果を残す。実測していない行は未確認とする。

| 操作                                        | 合格条件                                                                                                  |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| メールで Dayopt にログイン                  | 専用テストユーザーの Calendar が開く                                                                      |
| Settings から Google Calendar を接続        | 対象アカウント、readonly scope、Integration callback を確認して戻れる                                     |
| 専用カレンダーだけを選択し同期              | 一覧と選択が成功し、既知の予定がゴーストとして表示される                                                  |
| 変換前の Calendar を確認                    | Plan は実線、Record は塗り、外部予定は破線と外部アイコンで識別できる。同期だけで Plan / Record が増えない |
| 未来のゴーストを1回タップ                   | 選択した1件だけ Plan に確定。他のゴーストは残る                                                           |
| 終了済みのゴーストを1回タップ               | 選択した1件だけ Record に確定。未来終了の Record は作られない                                             |
| 再読込・連続タップ                          | 同じ予定が重複して作成されない。確定済みのゴーストは表示されない                                          |
| 古いタブから再確定                          | 2タブに同じゴーストを表示し、片方で確定・移動した後でも、もう片方の元時間への操作で二重確定しない         |
| 成功トーストの取り消し                      | 作成した Plan / Record が消え、ゴーストに戻る                                                             |
| 時間重複で変換失敗                          | エラー表示後にゴーストが復元され、意図しない確定はない                                                    |
| 日・週・狭い幅の表示                        | 日付・時刻・日跨ぎの表示が正しく、3種を識別できる                                                         |
| Google 原本を変更して再同期                 | 未変換ゴーストだけが追従。確定済み Plan / Record は独立して残る                                           |
| Dayopt 側の変換・編集後に Google 原本を確認 | Google 側へ書き戻されていない                                                                             |
| 接続を切断                                  | 接続と未変換ゴーストが消え、確定済み Plan / Record は残る。失効処理の結果も確認する                       |

Google の権限付与は対象アカウントと scope を確認し、ブラウザー操作の確認規則に従う。拒否・一部 scope のみ許可・再認証の経路も、接続成功を誤表示しないことを確認する。

## 実装と証拠の場所

- 表示比較は `ExternalEventCard.stories.tsx` の `ThreeSources`、操作は `Convertible` / `DismissConfirm`。
- 変換と取り消しは `useConvertGhostEvent.ts` とそのテスト。新規 DB 書き込みは既存の timeblock mutation を使う。
- セッション照合と Google identity 保存は Google Calendar callback route。接続作成・修復は `connection-service.ts`。
- 同期と読み取り専用 API は `sync-service.ts` / `providers/google.ts`。
- 全体の契約は [外部カレンダー仕様](../product/specs/external-calendar.md) と [接続フロー](../learn/journeys/google-calendar.md)。

Story・mock test・CI・health はそれぞれの範囲の証拠であり、Google 接続から切断までの実測の代わりにならない。

### Google 書き戻し経路の確認（2026-09-29、コード確認）

`providers/google.ts` の Calendar API 呼び出しは `requestGoogleApi` を経由し、method 指定のない GET で一覧を取得する。`useConvertGhostEvent.ts` の確定・取り消しは Dayopt の `createPlan` / `createRecord` / `deletePlan` / `deleteRecord` を呼び、Google API を呼ばない。OAuth の token 取得・失効の POST は予定の更新とは別である。

これは対象 HEAD のコード経路の確認であり、Google 原本を実際に比較した結果ではない。実接続後に専用予定の変換・編集・取り消しを実行し、Google 原本が保持されることを別途確認する。

### 共有環境の再開状況（2026-09-29）

[2026-09-29 の #2867 調整記録](https://github.com/Dayopt/dayopt/issues/2867#issuecomment-5887746642) では、#2867 は blocked、前の検証 handle は全て terminal と記録された。以前の active / inProgress の観測を現在も実行中という根拠にしない。#2910 所有の新規合成2ユーザーを通常 PR の immutable Preview で login・CRUD・ユーザー分離検証・所有 cleanup する範囲だけ、共有保留から除外された。

固定 Integration の origin / SHA / alias / env / 配備、DB schema、Auth / OAuth 設定、Google 接続・同期設定、既存利用者と #2867 の所有データは引き続き保留。本レーンの接続・同期・変換・切断は未実施。2026-09-30 にユーザーから二重確定防止と競合表示の対応指示を受け、旧行復元を拒否する推奨案のローカル実装を進めた。#2867 の Google アカウント選択までの記録は、本レーンによる権限付与・同期成功の証拠ではない。

再開時は Chrome の「ともや」で、メールログイン済みの専用 Dayopt ユーザーから Calendar 接続を開始する。管理用 Chrome で止まっている Google 同意画面を、そのまま本レーンの接続に流用しない。

### ローカル確認記録（2026-09-29）

対象 HEAD は `7e6fb801d8f3f7a6056509702cdb6e53b58917fd`。現在の Integration 配備との一致は主張しない。

- Node 24 で `pnpm --filter @dayopt/storybook exec storybook dev -p 6006 --ci` を起動し、`Storybook ready` を確認。
- ブラウザーで `ThreeSources` を表示。ライト・ダークの両方で Plan の実線、Record の塗り、外部予定の破線とアイコンを観察した。狭いカードではタイトル・時刻の省略があり、この1例だけで全サイズの識別性を保証しない。
- `Convertible` の Interactions は11項目 PASS。表示・Tab focus・中央のクリック対象・クリック1回・Enterによる追加1回・dismiss未発火を確認。Accessibility は violations 0 / inconclusive 1 であり、完全適合とは判定しない。
- `DismissConfirm` の Interactions は3項目 PASS。非表示ボタンから確認ダイアログが開くことを確認。実際の非表示保存や DB 確定はこの Story の検証範囲外。
- Google OAuth、共有 Supabase、Production への設定保存・データ書き込み・配備は行っていない。

### 二重確定の保証不足（コード確認、実 DB 再現は未実施）

`useConvertGhostEvent.ts` の二重変換防止は時間重複制約の副作用に依存している。外部予定 ID の参照 index は unique ではなく、`assert_timeblock_external_event_v1` は ID と user の所有者一致だけを確認する。Plan 作成 command に既存参照を拒否する判定はない。

到達する筋書きは、2タブで同じゴーストを開き、タブAで Plan に確定して別の時間へ移動した後、古いゴーストが残るタブBで元の時間へ確定すること。既存 Plan と時間が重ならないため、時間重複制約だけでは同じ外部予定を参照する2件目を拒否できない。画面の anti-join は次回取得後に隠すだけで、古いタブの書き込みを制約しない。

2026-09-29 の GitHub compare（この HEAD → `integration`）では、外部 Calendar / 変換 hook / timeblock command の当該経路に変更はなかった。追加 migration は Integration OAuth identity/origin の3件だけで、この保証を追加するものではなかった。これはコード上の確認であり、実 DB の重複件数・再現結果ではない。

修正は外部予定 ID を基準とする DB の原子的な判定が必要。UI の pending flag や単なる service 層 SELECT だけでは複数タブ・同時要求を防げない。既存 Plan から Record を作る正規操作、取り消し・soft delete・復元の契約を保ち、既存行を勝手に削除・統合しない。共有 DB の凍結解除後に専用データで再現し、migration の検証と保護対象レビューを行う。

既存データの有無は、許可された読み取り確認で以下の件数を調べる。実行はまだ行っていない。

```sql
SELECT 'plans' AS kind, count(*) AS duplicate_event_groups
FROM (
  SELECT user_id, external_calendar_event_id
  FROM public.plans
  WHERE deleted_at IS NULL AND external_calendar_event_id IS NOT NULL
  GROUP BY user_id, external_calendar_event_id HAVING count(*) > 1
) AS duplicates
UNION ALL
SELECT 'records', count(*)
FROM (
  SELECT user_id, external_calendar_event_id
  FROM public.records
  WHERE deleted_at IS NULL AND external_calendar_event_id IS NOT NULL
  GROUP BY user_id, external_calendar_event_id HAVING count(*) > 1
) AS duplicates;
```

## Production の出荷条件

[PR #2903](https://github.com/Dayopt/dayopt/pull/2903) の未解決 P1 は、authority singleton の provision / activate が未充足のまま fenced OAuth を必須化すると接続開始が失敗すること。2026-09-29 の review 読取時点で未解決だった。

Production 出荷前に、その時点の Google identity・migration・authority readiness・legacy NULL fence の修復条件と許可を確認する。既存経路への fallback や CAS 迂回で閉じない。Production 変更は明示権限・独立レビュー・dry-run/backup を満たして別途実行する。

Integration 実測の合格だけで Production の既存接続回復・定期同期・日常利用まで完了とは判定しない。

## 二重確定防止の実装（2026-09-30）

### Goal

古いタブ・移動後・同時要求でも、同じ外部予定から同種の有効な Dayopt 予定を二重作成しない。

### Minimum Viable Approach

Plan / Record の各 table に `(user_id, external_calendar_event_id)` の部分 unique index を追加する。条件は `deleted_at IS NULL AND external_calendar_event_id IS NOT NULL`。同時要求と復元も DB が同じ規則で制約する。通常の API とエラー変換は既存経路を使う。PostgreSQL の [部分 unique index](https://www.postgresql.org/docs/current/indexes-partial.html) は条件に合う行だけを一意に制約できる。

CLI で作成した `20260930014002_prevent_duplicate_external_calendar_conversion.sql` に次の制約を追加。共有 Integration / Production へは未適用。

```sql
CREATE UNIQUE INDEX plans_active_external_event_unique
  ON public.plans (user_id, external_calendar_event_id)
  WHERE deleted_at IS NULL AND external_calendar_event_id IS NOT NULL;

CREATE UNIQUE INDEX records_active_external_event_unique
  ON public.records (user_id, external_calendar_event_id)
  WHERE deleted_at IS NULL AND external_calendar_event_id IS NOT NULL;
```

両 table を SHARE lock で固定して既存の重複を確認し、あれば適用を止める。両 index は1 transaction で追加し、lock timeout 5秒 / statement timeout 60秒を設定。既存の通常 index は historical anchor の参照・prune に必要なため維持する。

### Reversibility Table

| 手順                           | 可逆性・影響                                                                                                               |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| ローカルの migration 案作成    | [minutes] 未配信ファイルを修正できる                                                                                       |
| 独立したクラウド検証環境で適用 | [hours] 制約を戻せる。共有 Integration の凍結中は行わない                                                                  |
| Production 適用                | [hours] 追加 index は rollback migration で解除可能。適用時の書き込み lock・重複による失敗があり、明示権限と事前確認が必要 |

### Existing Code to Reuse

- `apps/product/src/features/timeblock/server/timeblock-command-client.ts`: `23505` → `CONFLICT` の既存変換。
- `apps/product/src/features/calendar/hooks/operations/useConvertGhostEvent.ts`: 失敗時のゴースト invalidate とエラー表示、成功時の取り消し。
- `supabase/migrations/20260907081237_independent_plan_record_commands.sql`: `record_plan_unserialized_v1` は Record の外部予定 ID を NULL にする。Plan から Record を作る正規経路は制限しない。
- `apps/product/src/features/external-calendar/server/event-query-service.ts`: soft delete 済み参照は除外せずゴーストへ戻す既存契約。

### 受け入れ条件と影響

1. 同じ外部予定を参照する有効 Plan は最大1件。有効 Record も最大1件。時間を移動しても変わらない。
2. 別の外部予定や manual / from_plan の予定・記録を制限しない。Plan と Record の併存は許可する。
3. 取り消し・soft delete 後は再取り込み可能。再取り込みした有効行がある状態で旧行を復元すると `CONFLICT` で拒否し、どちらも勝手に削除しない。
4. 同時要求は1件だけ成功する。後発は `CONFLICT` を返し、UI は実 DB 状態を再取得する。
5. 重複を含む既存 DB の upgrade は適用を停止し、ユーザーデータを変更しない。
6. 制約による error がユーザーに伝わることと、fresh / upgrade / restore / 同時要求の実 DB 挙動を専用クラウド環境で検証するまで ready / 配備しない。現時点では検証未実施。

### 判断する利用者体験と代替案

具体例は、外部予定 E から確定した Plan A を削除し、再表示された E を Plan B として再取り込みした後、A の削除トーストで「取り消し」を押すこと。A と B の時刻が重ならなくても同じ E の二重参照となる。Record でも同じ扱いを提案する。

| 選択肢                                        | 操作後の状態・利用者体験                                                                                    | 影響と最悪ケース                                                                                                      |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| A: 復元を拒否して理由を知らせる（採用）       | B を保持し、A は削除済みのまま。再取り込み済みであることを知らせる。同じ操作の再試行を促さない              | 通常の確定は1タップのまま。復元したかった A の内容はその操作では戻せない                                              |
| B: 残す行を選んでから復元する（代替・未承認） | 競合時に A / B の内容を比較し、B の削除と A の復元を明示承認した場合だけ切り替える。選ばず閉じれば B を保持 | 比較・選択 UI と原子的な切り替え、失敗時の取り消し契約が必要。選択を誤ると B の編集内容を有効な Calendar 表示から失う |

既存行の自動置換・統合は行わず、Plan / Record の併存は許可する。A は通常のワンタップ確定を維持し、ユーザーが選んだ B を別操作の復元が勝手に消さないため採用。B の新規選択 UI は追加しない。

### source の変更と残る検証

- 部分 unique index・重複時の停止・timeout を migration に追加。戻す場合は追加 index 2件を rollback migration で DROP する。通常 index・ユーザーデータを変更しない。
- `timeblock-command-client.ts` は `23505` と対象 index の正確な引用名を照合し、`EXTERNAL_CALENDAR_ALREADY_CONVERTED` に写像。他の一意競合は汎用 `CONFLICT` のまま。DB の user ID・予定内容・生の詳細はクライアントに送らない。tRPC は HTTP 409 と安全な service code を返す。
- `useTimeblockWriteMutations.ts` が「この外部予定は取り込み済みです」または「同じ外部予定を取り込み済みのため、復元できません」を日本語・英語で表示する。通常の復元失敗は既存表示を保つ。
- `useConvertGhostEvent.ts` は ghost を再取得し、共有 mutation の理由通知へ汎用トーストを重ねない。Dayopt の rollback / 再取得は既存の共有 mutation が担う。
- 対象 unit test は修正前に期待する error code / 表示 / 重複通知の不一致で失敗を確認し、修正後に成功した。実 DB 用のテストは移動後の古いタブ・同時要求の非重複時間・soft delete / 再取り込み / 旧行復元・Plan / Record 併存を追加。実 DB の結果は実行後に記録する。既存 Story の成功は DB 競合・復元の証明に使わない。

### What I'm Not Doing

新規 API、外部予定の自動確定、既存の重複データの自動削除・統合、Google 書き戻し、共有 Integration と Production への適用は含めない。表をまたぐ一意制約は Plan / Record 併存の契約と異なるため追加しない。
