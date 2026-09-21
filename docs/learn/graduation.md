---
status: current
last_verified: 2026-09-21
---

# 卒業問題

何も見ずに答えられたら、Dayopt を「作っている」だけでなく、システムとして理解している状態。答えた後に、各問の「答えに含まれているべきこと」と照らし、足りない所だけ該当の経路と章を読み直す。

## 1. 利用者がカレンダーから Plan を作った時、ブラウザから DB まで何が起こる？

<details>
<summary>答えに含まれているべきこと</summary>

- Plan か Record かの既定は終了時刻で決まる（UI の写し）
- アクティビティを選んだ瞬間に作る。先に画面へ出し（楽観的更新）、失敗したら戻す
- tRPC で `/api/trpc` へ。関門は 認証 → MFA → 利用権 → write fence → rate limit
- Router → Service → service role の command adapter → `create_plan_command_v1`（user_id は引数、1 トランザクション）
- DB trigger が時刻の規則を強制する（`DT003`、Record なら `DT005`）
- 返事で一時の行を差し替え、成功・失敗どちらでも関連を取り直す。Realtime は無い

読み直す: [Plan を保存](journeys/save-plan.md)、[2. UI → DB](02-ui-to-db.md)

</details>

## 2. その途中で Supabase が失敗したら何が起こる？

<details>
<summary>答えに含まれているべきこと</summary>

- 画面の Plan は消え、「保存できませんでした…」のトースト。書き込みは自動で再試行しない
- 返事だけが失われた場合、DB には入っていて、取り直しで Plan が現れる（二重作成が起きうる筋）
- deadlock だけは server の中で 1 回だけ再試行する
- 想定外の DB エラーは Sentry に残る。Supabase 全体の停止なら `/api/health` が 503 になり UptimeRobot が通知する
- 表示はキャッシュが残る

読み直す: [Plan を保存](journeys/save-plan.md) の「⚡」、[7. 障害](07-failures.md)、[外部サービスと停止マップ](system/services.md)

</details>

## 3. 別の利用者のデータが見えないのは、何が保証している？

<details>
<summary>答えに含まれているべきこと</summary>

- 読み取り（UI）は利用者のセッションで行い、RLS が自分の行だけに絞る
- 書き込みは直接できない（`authenticated` には SELECT だけ）。command 関数が `user_id` を照合し、他人の行なら `DT001 Plan not found`（存在を漏らさない）
- 行どうしの参照は `(id, user_id)` の複合 FK
- MCP の読み取りは service role なので RLS が効かず、service の `user_id` 絞り込みだけが守る。専用のテストがある
- ブラウザに残すキャッシュも利用者ごとに分ける

読み直す: [3. DB / Auth / RLS](03-data-auth-rls.md)、[8. セキュリティ](08-security.md)

</details>

## 4. 本番に変更が届くまで何が起こる？

<details>
<summary>答えに含まれているべきこと</summary>

- PR ごとに Supabase Preview Branch と Vercel Preview
- main の ruleset（required checks・review thread の解決）を通って merge
- merge の時点で migration が本番 DB に入る。Vercel は本番候補を作る（domain は未割当）
- Production Release が影響を判定し、E2E などを回し、緑なら smoke して promote。赤なら公開せず issue が立つ
- 開いているタブは、編集中でない瞬間に黙って新しい版になる

読み直す: [merge → 本番公開](journeys/deploy.md)、[9. デプロイ](09-deployment.md)

</details>

## 5. 問題が起きたら、どこから調べる？

<details>
<summary>答えに含まれているべきこと</summary>

- 画面に出た文言（翻訳ファイルからコードへ逆引き）と移った画面
- Sentry（environment・release・影響人数）→ 同じ時刻の Vercel の Function ログ → DB や Auth が関わる時だけ Supabase → 外部の status page → runbook
- 「Sentry が無音」は無事の証拠ではない（想定内の失敗は送らない、`/api/health` は見えない、同意の無いブラウザは送らない）
- 書き込みだけを止めるなら write fence。MCP は別の gate

読み直す: [7. 障害](07-failures.md)

</details>

## 6. MCP から同じ操作をすると何が違う？

<details>
<summary>答えに含まれているべきこと</summary>

- 認証は OAuth の bearer token（hash で照合、事前登録のクライアントだけ、PKCE）
- 読み取りは `/api/mcp` の中から tRPC を呼ぶ。OAuth token で `/api/trpc` を直接叩いても通らない
- 書き込みは tRPC を通らず `apply_mcp_*` の DB 関数へ。user_id は接続から DB が決め、最後は UI と同じ `create_plan_command_v1`
- write fence は効かず、MCP 専用の gate で止める。rate limit も MCP 専用で、Upstash が落ちると止まる（UI は通す）
- `operationId` で送り直しても 2 つ目を作らない。UI には冪等の鍵が無い
- 読み取りの分離は RLS ではなく service の絞り込み
- ツール名・scope は外部契約

読み直す: [AI クライアントから Plan を作る](journeys/mcp.md)、[10. API / MCP](10-api-mcp.md)

</details>

## 7. この部分を変更すると、どこをテストすべき？

<details>
<summary>答えに含まれているべきこと</summary>

- 変えるファイルから、それを通る操作と段を逆引きする
- 規則の強制点か写しかを確かめる
- 外部契約・不可逆に触るかを確かめる
- その段を守るテストを探し、無ければ最小の層に赤を入れてから直す。E2E は中核の流れだけ
- 変更の前後で結果が変わるテストか（TEST-1）

読み直す: [12. 変更](12-change.md)、[6. テスト](06-testing.md)

</details>
