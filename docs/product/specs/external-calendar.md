---
status: current
last_verified: 2026-09-25
code: apps/product/src/features/external-calendar
public_docs:
  - google-calendar
lp:
  - 'Google Calendar sync'
---

# External Calendar（外部カレンダー連携）

Google カレンダーの予定を読み取り専用でミラーし、Calendar 画面に ghost（未変換の外部予定）として表示する feature。接続・切断・カレンダー選択の設定 UI は [Settings](./settings.md) が所有し、本 spec はミラーの同期・表示・変換対象化のロジックを扱う。

## 現在の振る舞い

- 接続は **読み取り専用**。Dayopt から Google カレンダー側を変更することはない。1 ユーザーが複数の Google アカウントを接続でき、アカウントごとに取り込むカレンダーを選べる
- 同期は 15 分間隔の cron が全接続を回す。接続ごとに 1 日 1 回、決定的に割り当てたスロットで全件洗い替え（full sync）を行い、それ以外は provider の増分同期（sync token）を使う。取り込み対象は現在時刻を中心とした前後 90 日
- calendar 画面は ghost を Pro 限定の tRPC procedure（`listEvents`）経由で取得する。読み取りは `±5 分` の `staleTime` を持ち、15 分ごとに自動で再取得する。**取得失敗時は前回成功データを再利用せず空配列にする**（解約直後に古い外部予定が描画され続けるのを防ぐ fail closed）
- ghost をタップすると Plan または Record に変換される。終了時刻が未来なら Plan、過去なら Record になる。一度変換された予定はミラーから独立し、以後 Google 側の変更や削除の影響を受けない
- Calendar 上では Plan は実線の枠、Record は塗りつぶし、外部予定は外部カレンダーアイコン付きの破線枠で表示する。外部予定のカード全体が変換操作で、メニューを挟まず一度のタップで確定する
- 不要な ghost は非表示（dismiss）にできる。dismiss は取り消し（undo）可能な状態切り替えで、独立した undo 経路ではなく同じ操作を `dismissed: false` で呼び直す形にしている
- 接続の再認証が必要な状態（`reauth_required`）になった接続は、同期を止め、ghost の表示対象からも除外する（stale なミラーを見せ続けない）
- カレンダーの選択を解除すると、そのカレンダー由来で未変換の ghost は即時に取り込み対象から外れる。既に Plan / Record に変換済みの予定は影響を受けない
- 接続を切断すると、未参照のミラー行を削除してから provider 側の許可を取り消し、最後に接続情報を削除する。解約済みユーザーでも接続状態の閲覧と切断は常に行える（読み取り 4 procedure と切断は `protectedProcedure`、ghost 表示・書き込み・オンデマンド操作は `entitledProcedure(entitlementKeys.externalCalendarSync)`）
- アカウント削除が進行中の間は、Calendar 接続の削除・revoke を独立 cron（`/api/cron/calendar-account-deletion-settle`）が担う。アカウント削除全体のフローの一段として "pending" 状態から確定（settle）させ、通常の接続操作（sync / 切断）とは別経路で処理する
- OAuth start は state / PKCE verifier の SHA-256 digest だけを server-side attempt に保存する。callback は Google の一回限りの認可コードを交換する前に attempt を claim し、generation / authority fence に結び付けた RPC で接続を保存する
- 再接続は start 時点で選んだ `reauth_required` 行、または authority fence が欠けた legacy `active` 行の ID・user・provider・Google `sub` を条件にした保存だけを許可する。OAuth 中にその行が切断・削除されていた場合、再作成せず `missing` を返す
- fenced writer 導入前に作られた active 行で fence が NULL の場合、カレンダー一覧・選択更新の前に対象接続専用の service-role RPC が user data generation と project / quarantine / subject fence の ready 状態を確認し、1 行だけを原子的に fence へ結び付ける。CAS を迂回する未 fence 操作にはフォールバックしない。generation が古い接続や fence が処理中の接続は再認証へ誘導する
- fenced 同期は `begin_calendar_sync_run_v1` が `missing` を返した接続だけ同じ fence repair を試し、`ready` の場合に begin を再試行する。接続がない場合や generation / authority 条件を満たさない場合は Google API へ進まない
- Google 側の grant 発行後に Dayopt の保存が確実に rollback した場合は orphan grant の revoke を試みる。DB 応答が失われ commit 結果が不明な場合は、保存済み token を失効させないため revoke を行わず、失敗を記録する（#2072, #2156）
- 2026-09-25 の Production 読み取り確認では `get_external_lifecycle_app_version_v3` marker は存在し、Google 接続は 1 件、その接続は active だが fence 欠損、data-generation mismatch は 0 件だった。`authority_fence_id` / `authority_epoch` はどちらも NULL、最終同期は 2026-08-20 05:45 UTC。cron heartbeat は 8 件すべて新しかったが、接続の同期成功は確認できていない
- 2026-09-25 の Supabase Production migration 一覧は `20260924120643` が末尾で、branch の `20260925000000_fenced_calendar_reconnect_command` と `20260925100000_repair_legacy_calendar_connection_fence` は未反映。`repair_calendar_connection_authority_fence_v1` も未反映で、`private.calendar_authority_projects` の singleton 行も存在しなかった。したがって migration を適用するだけでは接続を回復できず、Production の Google authority identity を確認して provision・activate した後、一覧・選択・同期を実際に確認する必要がある。Production への変更は未実施
- Vercel Product の最新 Production deployment は 2026-09-24 22:17 JST に Ready となり、read-only deployment metadata は ref `main` / SHA `93bb3544cc90541dc9e3c996378d017cf075463d` を示す。現在の `codex/external-calendar-fence-2673` の変更は Production に未配信
- 接続の集計では選択カレンダー 1 件、ミラー予定 1 件、未 dismiss の ghost 1 件を確認した。接続は active・連続失敗 0・`last_sync_error` なしだが最終同期は約 35 日前で、この ghost は現在の同期成功を示さない。Vercel Product の Production target には OAuth client ID / project number / client secret / 暗号鍵 / redirect URI の 5 key が登録済みだが、値は今回の read-only 確認では取得せず、client ID と project number の一致は未確認

## Stateの正本

- 接続・選択カレンダー・ミラーされた予定: Supabase（`calendar_connections` / `calendar_connection_calendars` / `external_calendar_events`）
- 同期処理: `apps/product/src/app/api/cron/calendar-sync/route.ts`（cron）と `syncNow` procedure（手動）が `sync-service.ts` の共通ロジックを使う
- calendar 画面への受け渡し: `useExternalCalendarEvents` hook が tRPC 経由でミラーを取得し、描画用の形へ変換する

## 関連する意思決定

- ADR-025: Plan / Record / 外部カレンダーミラーへの分割（削除済み、git 履歴参照）
- [Settings](./settings.md)
