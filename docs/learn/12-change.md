---
status: current
last_verified: 2026-09-21
---

# 12. 変更（影響範囲を自分で判断する）

## この章で答えられるようになる問い

- あるファイルを変える時、どの操作のどの段に響くか
- 変更の前に何を確かめ、どのテストを回すか
- その変更は可逆か、外部契約に触るか

## 概念

変更の影響は 3 つの方向に広がる。

1. **同じ操作の前後の段** — 例: DB の規則を変えると、UI の写しとテストの期待値も変わる
2. **同じコードを通る別の操作** — 例: `protectedProcedure` は全 tRPC、`create_plan_command_v1` は UI と MCP の両方
3. **外の consumer** — MCP のツール・OAuth scope・webhook の payload・外部カレンダーの形。repo の外の誰かが依存している

## 変更前のチェック

1. **逆引きする**: 下の一覧で、変えるファイルを参照している経路の段と「ここを変えると」を読む。一覧に無ければ `rg` で呼び出し元を探す
2. **規則の強制点か写しかを確かめる**: 時刻の規則なら `docs/engineering/invariants.md` の写し表。写しだけを変えても規則は変わらない
3. **外部契約か**: MCP / OAuth / webhook / 課金 / 外部カレンダー / migration は、既存の consumer を壊さない形にする（REVIEW-3）
4. **可逆か**: 不可逆（データ削除・破壊的 migration・本番の変更）なら慎重に、可逆なら速く（シンプルルール 4）
5. **テストの層を選ぶ**: [6. テスト](06-testing.md) の対応表で、その段を守るテストを探す。無ければ最小の層に赤を入れてから直す
6. **この教材も直す**: コードを動かして `pnpm docs:check` が参照切れを出したら、その経路の JSON の `find` を追従させ、`pnpm learn:generate` を実行する

## ファイルから経路への逆引き

経路の正本から生成している（`pnpm learn:generate`）。

<!-- learn:generated:start — 正本 docs/learn/journeys の JSON（change-map） / 再生成 pnpm learn:generate / 検証 pnpm docs:check。この範囲は手編集しない -->

経路の段が参照しているコードを、ファイルごとに逆引きした一覧。あるファイルを変える時、どの操作のどの段に響くか、その段に書いた「ここを変えると」を並べる。
一覧に無いファイルは、どの経路からも参照していないだけで、影響が無いとは限らない。

#### `.agents/skills/supabase/SKILL.md`

- [merge → 本番公開](journeys/deploy.md) の 2. migration 適用 — ここから promote が終わるまで、新しい schema の上で旧コードが動く時間がある（E2E が完走するまで）。migration は旧コードでも壊れない形で書く。

#### `.github/workflows/promote.yml`

- [merge → 本番公開](journeys/deploy.md) の 4. 影響判定 — 影響なしと判定された project の検証は走らない。docs だけの merge でも build は作られ、判定を通る。
- [merge → 本番公開](journeys/deploy.md) の 5. E2E などで検証 — ここが merge 後の本番を守る唯一の実行検証。遅くすると、migration と旧コードが共存する時間も伸びる。
- [merge → 本番公開](journeys/deploy.md) の 6. smoke → 公開 — 緊急時の Force Promote は理由の入力が必須。層 3 を飛ばすので、使ったら記録を残す。

#### `AGENTS.md`

- [merge → 本番公開](journeys/deploy.md) の 1. main へ merge — required check に paths filter 付きの check を入れると、満たせない PR が merge できなくなる。

#### `apps/product/src/app/[locale]/(app)/(workspace)/_composition/ReportViewClient.tsx`

- [レポートを開く（集計）](journeys/report.md) の 1. 期間を決める — date を server component の prop で受けると、期間の ‹ › 移動が画面に反映されなくなる（移動は history.replaceState で URL を書くだけで、server component は再描画されない）。page.tsx と ReportViewClient のコメントが理由を持つ。

#### `apps/product/src/app/[locale]/(app)/(workspace)/_server/calendar-prefetch.ts`

- [Google Calendar 連携](journeys/google-calendar.md) の 11. カレンダーに薄く表示 — 変換した Plan には source: external_calendar と元の予定の ID が付く。Google の予定を消しても、変換済みの Plan は残る。

#### `apps/product/src/app/[locale]/(app)/(workspace)/report/page.tsx`

- [レポートを開く（集計）](journeys/report.md) の 1. 期間を決める — date を server component の prop で受けると、期間の ‹ › 移動が画面に反映されなくなる（移動は history.replaceState で URL を書くだけで、server component は再描画されない）。page.tsx と ReportViewClient のコメントが理由を持つ。

#### `apps/product/src/app/[locale]/(app)/_providers/useApplyUpdateWhenSafe.ts`

- [merge → 本番公開](journeys/deploy.md) の 7. タブが新版に気づく — API の入出力を変えた直後は、旧版の画面が新版のサーバーを呼ぶ時間がある。tRPC の入力を必須化する変更は、旧画面からの呼び出しを壊す。

#### `apps/product/src/app/[locale]/(app)/settings/[category]/page.tsx`

- [データを書き出す](journeys/data-export.md) の 1. 形式と範囲を選ぶ — 同じ画面の下に、全件削除（deleteBlocks / deleteAllData）がある。こちらは不可逆なので、エクスポートとは別の経路として扱い、ここを変える時に巻き込まない。
- [Google Calendar 連携](journeys/google-calendar.md) の 7. 設定に戻る（接続済み） — デスクトップでは設定はモーダルなので、戻ってきた後にカレンダーの上で開き直す。
- [Pro を契約する（課金）](journeys/billing.md) の 4. 戻りの URL を読む — 成功の toast は URL だけを根拠に出る（webhook 到達前でも「契約が有効になりました」と出る）。文言や判定をいじる時は、ここが確定情報ではないことを前提にする。query は PC では設定モーダルを開いて消すので、BillingSettings 側では読めない。

#### `apps/product/src/app/[locale]/(app)/settings/_utils/billing-return.ts`

- [Pro を契約する（課金）](journeys/billing.md) の 4. 戻りの URL を読む — 成功の toast は URL だけを根拠に出る（webhook 到達前でも「契約が有効になりました」と出る）。文言や判定をいじる時は、ここが確定情報ではないことを前提にする。query は PC では設定モーダルを開いて消すので、BillingSettings 側では読めない。

#### `apps/product/src/app/[locale]/(auth)/auth/callback/route.ts`

- [ログイン（MFA 含む）](journeys/login.md) の 1. サインイン画面 — ボタンの活性は Turnstile の状態で決まる。Turnstile の設定を変える時はこの画面と登録画面の両方を見る。
- [サインアップ → ウェルカムメール](journeys/signup.md) の 4. 確認リンクで着地 — email_change / recovery も同じ route を通る。ウェルカムメールは type が signup の時だけ。

#### `apps/product/src/app/[locale]/(auth)/auth/confirm/route.ts`

- [サインアップ → ウェルカムメール](journeys/signup.md) の 4. 確認リンクで着地 — email_change / recovery も同じ route を通る。ウェルカムメールは type が signup の時だけ。
- [パスワードを再設定する](journeys/password-reset.md) の 4. リンクで着地 — signup・email_change も同じ route を通る。分岐を変える時は type ごとの着地先をテストで確かめる。/auth/confirm と /auth/reset-password はサインイン中でも通れる path に登録してある（access-policy.ts）。

#### `apps/product/src/app/[locale]/(auth)/auth/mfa-verify/page.tsx`

- [ログイン（MFA 含む）](journeys/login.md) の 4. 6 桁のコード入力 — リカバリーコードの tRPC だけは、まだ aal1 のままでも protectedProcedure を通れるよう例外にしてある。MFA の関門を変える時はこの例外を壊さない。
- [ログイン（MFA 含む）](journeys/login.md) の 5. コードを検証 — 遷移先は getSafeRedirectPath で必ず検査する。外部 URL を渡されるとオープンリダイレクトになる。

#### `apps/product/src/app/[locale]/(auth)/auth/page.tsx`

- [パスワードを再設定する](journeys/password-reset.md) の 5. 設定画面を出す — ここに来るのは recovery session とは限らない。通常のサインイン中に直接開いた場合も通り、その時は更新が GoTrue に拒否される（次の段）。

#### `apps/product/src/app/[locale]/(auth)/auth/reset-password/page.tsx`

- [パスワードを再設定する](journeys/password-reset.md) の 5. 設定画面を出す — ここに来るのは recovery session とは限らない。通常のサインイン中に直接開いた場合も通り、その時は更新が GoTrue に拒否される（次の段）。

#### `apps/product/src/app/[locale]/oauth/authorize/page.tsx`

- [AI クライアントから Plan を作る（MCP）](journeys/mcp.md) の 2. 認可リクエストを検証 — redirect_uri の登録や PKCE の要件を緩めると、code が第三者のドメインへ渡る穴になる（clients.ts のコメント）。security skill の観点で読む。

#### `apps/product/src/app/[locale]/oauth/consent/actions.ts`

- [AI クライアントから Plan を作る（MCP）](journeys/mcp.md) の 3. 同意して code を得る — scope の表示名と付与判定は外部契約に直結する。付与判定（resolveGrantableScopes）は token 検証側（段 6）と規則を共有しているので、片方だけ変えると同意時と利用時で権限が食い違う。

#### `apps/product/src/app/api/cron/billing-reconciliation/route.ts`

- [Pro を契約する（課金）](journeys/billing.md) の 11. 夜間の照合 — 直すのは人間。検出したら Stripe Dashboard から該当 event を再送する（runbook Playbook 3）。Stripe の env が全て無ければ configured: false で素通りし、一部だけなら 503 にする。

#### `apps/product/src/app/api/cron/calendar-account-deletion-settle/_composition/settle-dispatcher.ts`

- [アカウントを削除する（不可逆）](journeys/account-deletion.md) の 11. 毎時の後始末 — 時間の予算は 50 秒（1 回あたり最大 5 件）。write fence 中は 503 で何もしない。本番では cron の heartbeat を監査し、最終完了から 180 分を超えると異常として扱う。

#### `apps/product/src/app/api/cron/calendar-sync/route.ts`

- [Google Calendar 連携](journeys/google-calendar.md) の 8. 15 分ごとの同期 cron — 取りこぼした回を埋め直さない。止まったことは heartbeat の完了時刻が古くなることで気づく（production の監査が見る）。

#### `apps/product/src/app/api/integrations/google-calendar/callback/route.ts`

- [Google Calendar 連携](journeys/google-calendar.md) の 4. callback で検証 — 失敗の理由はすべて ?calendar=error&reason=… で設定画面へ返し、専用の文言を出す。理由を足したら文言も足す。
- [Google Calendar 連携](journeys/google-calendar.md) の 5. code を token に交換 — ここより後で失敗した時は必ず revokeOrphanedGrant を試す。新しい失敗理由を足す時もこの後始末を通す。

#### `apps/product/src/app/api/integrations/google-calendar/start/route.ts`

- [Google Calendar 連携](journeys/google-calendar.md) の 2. /start で準備 — MFA を利用権や rate limit より先に見るのは、MFA 不足で断る時に DB 読み取りや枠を消費しないため。

#### `apps/product/src/app/api/mcp/_server.ts`

- [AI クライアントから Plan を作る（MCP）](journeys/mcp.md) の 7. 利用権と scope の関門 — tool と scope の対応（registry）は外部契約。scope を変えると、既に付与済みの接続でその tool が見えなくなる。tool の足し引きは list-tools.test.ts の集合一致テストが止める。

#### `apps/product/src/app/api/mcp/_tools/registry.ts`

- [AI クライアントから Plan を作る（MCP）](journeys/mcp.md) の 5. plans.create を呼ぶ — tool 名（plans.create）・入力 schema・必要 scope（write:plans）は外部契約。改名・削除・必須項目の追加は、既存クライアントと、それを前提に書かれた利用者の指示を壊す。tool の説明文は「Create one future Plan」のままで、過去にも Plan を置ける現行の規則と食い違っている。

#### `apps/product/src/app/api/mcp/_tools/timeblock-mutations.ts`

- [AI クライアントから Plan を作る（MCP）](journeys/mcp.md) の 5. plans.create を呼ぶ — tool 名（plans.create）・入力 schema・必要 scope（write:plans）は外部契約。改名・削除・必須項目の追加は、既存クライアントと、それを前提に書かれた利用者の指示を壊す。tool の説明文は「Create one future Plan」のままで、過去にも Plan を置ける現行の規則と食い違っている。
- [AI クライアントから Plan を作る（MCP）](journeys/mcp.md) の 10. 受領証を受け取る — 受領証の field と schemaVersion は外部契約。変えると、保存済みの受領証を再送で返す時に outputSchema の検証が失敗し、全 mutation tool が壊れる（timeblock-mutations.ts のコメント）。

#### `apps/product/src/app/api/mcp/_tools/tool-result.ts`

- [AI クライアントから Plan を作る（MCP）](journeys/mcp.md) の 10. 受領証を受け取る — 受領証の field と schemaVersion は外部契約。変えると、保存済みの受領証を再送で返す時に outputSchema の検証が失敗し、全 mutation tool が壊れる（timeblock-mutations.ts のコメント）。

#### `apps/product/src/app/api/mcp/route.ts`

- [AI クライアントから Plan を作る（MCP）](journeys/mcp.md) の 1. 401 から接続先を発見 — scopes_supported・endpoint の URL・client の allowlist は外部契約。scope を改名・削除すると、既に接続済みのクライアントの token が解釈できなくなる（保存済み scope が未知だと token 不正扱い）。
- [AI クライアントから Plan を作る（MCP）](journeys/mcp.md) の 6. /api/mcp で token を検証 — 401 / 403 の WWW-Authenticate の形は、クライアントが再認可するかを決める外部契約。5xx を 401 に丸めると、クライアントが再認可を繰り返して本当の障害が見えなくなる（route.ts のコメント）。
- [AI クライアントから Plan を作る（MCP）](journeys/mcp.md) の 7. 利用権と scope の関門 — tool と scope の対応（registry）は外部契約。scope を変えると、既に付与済みの接続でその tool が見えなくなる。tool の足し引きは list-tools.test.ts の集合一致テストが止める。

#### `apps/product/src/app/api/oauth/token/route.ts`

- [AI クライアントから Plan を作る（MCP）](journeys/mcp.md) の 4. code を token に換える — token endpoint の応答形式・grant_type は外部契約。Write Fence が止めるのは authorization_code（新規接続）だけで、refresh は通す。fence 中も既存の接続は既存の token で書けるため、refresh を止めても防げるものが無い、という判断。

#### `apps/product/src/app/api/trpc/[trpc]/route.ts`

- [Plan を保存](journeys/save-plan.md) の 5. /api/trpc で受ける — ここは全 tRPC 共通の入口。context に項目を足すと全 procedure の実行前コストが増える。

#### `apps/product/src/app/api/trpc/_server/_composition/account-deletion-coordinator.ts`

- [アカウントを削除する（不可逆）](journeys/account-deletion.md) の 4. 削除を開始（閉鎖へ） — DB の RPC は失敗 code が 40P01 / 55P03 / 57014（deadlock・lock 待ち・timeout）なら 3 回まで呼び直す。それでも取れなければ contention として利用者に押し直してもらう。
- [アカウントを削除する（不可逆）](journeys/account-deletion.md) の 5. Google の token を無効化 — Google Calendar を繋いでいない人は、この段は空で完了する。token の復号に失敗した時は Google を呼ばず not_attempted として記録する（Google 側では token の期限切れを待つことになる）。
- [アカウントを削除する（不可逆）](journeys/account-deletion.md) の 6. ファイルを消す — 段の順番は DB が強制する（Calendar が済むまで Storage の claim は通らない）。bucket を増やしたら STORAGE_BUCKETS に足す。最後の auth.users 削除の trigger も bucket に残りが無いかを独立に確かめる。
- [アカウントを削除する（不可逆）](journeys/account-deletion.md) の 7. Stripe を解約・削除 — 解約すると Stripe から customer.subscription.deleted の webhook が別に届く。それが削除より先に処理されて解約確認メールが出るかどうかは、到着の順番次第で未確認。返金の扱いはこのコードには無い。

#### `apps/product/src/app/api/trpc/_server/_composition/account-deletion-selector.ts`

- [アカウントを削除する（不可逆）](journeys/account-deletion.md) の 3. 経路を選ぶ — gate を有効にする migration は repo に無く、運用で切り替える前提。production で今どちらの経路が動いているかは未確認。旧経路は「古い instance が捌け切ったら消す」一時的な分岐。

#### `apps/product/src/app/api/webhooks/resend/route.ts`

- [サインアップ → ウェルカムメール](journeys/signup.md) の 7. 配送結果を受ける — ここが止まると、新しい bounce が記録されず、届かない宛先へ送り続ける。
- [問い合わせを送る](journeys/contact.md) の 8. 配送結果の通知 — tags の source や宛先を変えると、ここで問い合わせと判定できず、support 宛てのアドレスが送信停止リストに入りうる。

#### `apps/product/src/app/api/webhooks/stripe/route.ts`

- [Pro を契約する（課金）](journeys/billing.md) の 5. webhook の署名検証 — 外部契約。URL（/api/webhooks/stripe）は Stripe Dashboard に登録してあり、動かすと全 event が届かなくなる。secret を回したら Vercel の env を同時に更新して再デプロイする（runbook ケースA）。
- [Pro を契約する（課金）](journeys/billing.md) の 6. fence・照合・予約 — 予約の状態（processing / processed / failed）は夜間の照合 cron も読む。状態名を変えると照合が invalidState を数え出す。5 分以上 processing のままの予約は古いとみなして取り直せる。
- [Pro を契約する（課金）](journeys/billing.md) の 7. 契約状態を書く — 外部契約。Stripe の status の写し（mapStripeSubscriptionStatus）を変えると、active / trialing / past_due を「契約中」とみなす判定（isProSubscriptionStatus）と噛み合わなくなる。メール送信は失敗しても 200 を返す（throw すると Stripe が再送し、状態同期が揺れる）。durable 経路では未対応の event 種別を 500 にするので、Stripe Dashboard で購読 event を足すとそれが再送され続ける。

#### `apps/product/src/app/api/webhooks/stripe/stripe-webhook-idempotency.ts`

- [Pro を契約する（課金）](journeys/billing.md) の 6. fence・照合・予約 — 予約の状態（processing / processed / failed）は夜間の照合 cron も読む。状態名を変えると照合が invalidState を数え出す。5 分以上 processing のままの予約は古いとみなして取り直せる。

#### `apps/product/src/components/shell/sidebar/UserMenu.tsx`

- [問い合わせを送る](journeys/contact.md) の 1. ダイアログを開く — 入力の上限（10〜5000 文字、環境情報の各長さ）はサーバーの zod schema が正本で、画面の 10 文字検査はその写し。カテゴリを足す時は schema、件名の対応表、翻訳を揃える。

#### `apps/product/src/features/auth/components/LoginForm.tsx`

- [ログイン（MFA 含む）](journeys/login.md) の 1. サインイン画面 — ボタンの活性は Turnstile の状態で決まる。Turnstile の設定を変える時はこの画面と登録画面の両方を見る。
- [ログイン（MFA 含む）](journeys/login.md) の 3. MFA が要るか確かめる — 問い合わせに失敗した時は、安全側に倒して MFA 画面へ送る（fail-closed）。

#### `apps/product/src/features/auth/components/MFAVerifyForm.tsx`

- [パスワードを再設定する](journeys/password-reset.md) の 7. MFA で昇格（有効時だけ） — リカバリーコードで通すと MFA は無効になる（recovery-service.ts の既存の副作用）。成功画面に警告を出すのはそのため。MFA 画面の部品は dynamic import で、MFA の無い大多数の訪問者には読み込まない。

#### `apps/product/src/features/auth/components/PasswordResetForm.tsx`

- [パスワードを再設定する](journeys/password-reset.md) の 1. リセットを依頼 — 画面の出し分けを足すと列挙防止が崩れる。保証境界は docs/product/specs/auth.md のパスワードリセットの節。失敗の観測は画面ではなく store 側の Sentry が持つ。

#### `apps/product/src/features/auth/components/ResetPasswordForm.tsx`

- [パスワードを再設定する](journeys/password-reset.md) の 6. 新しいパスワードを送る — エラー code の読み分けは ResetPasswordForm の RECOVERY_UPDATE_BLOCKED_CODES と isMfaBlocked。message の文字列で判定しない方針。
- [パスワードを再設定する](journeys/password-reset.md) の 7. MFA で昇格（有効時だけ） — リカバリーコードで通すと MFA は無効になる（recovery-service.ts の既存の副作用）。成功画面に警告を出すのはそのため。MFA 画面の部品は dynamic import で、MFA の無い大多数の訪問者には読み込まない。
- [パスワードを再設定する](journeys/password-reset.md) の 8. 他の端末を切る — 今の端末の session は残る。そのため 3 秒後の /auth/login への移動は、proxy が「サインイン済みで auth 系 path へ来た」と見て /calendar へ送り直すはず（コードから読んだ挙動。ブラウザでは未確認）。文言は「まもなくサインインページに移動します」。

#### `apps/product/src/features/auth/components/SignupForm.tsx`

- [サインアップ → ウェルカムメール](journeys/signup.md) の 1. 登録フォーム — Turnstile の secret は app の env ではなく Supabase Auth の Bot Protection にある。site key と secret は別の場所で管理している。

#### `apps/product/src/features/auth/server/password-reauthentication.ts`

- [アカウントを削除する（不可逆）](journeys/account-deletion.md) の 2. 本人を確かめ直す — captcha を免除している経路なので、呼び出し元を増やす前に password-reauthentication.ts の契約と docs/product/specs/auth.md の保証境界を読む。検証用の session は scope: 'local' で消す（既定の global だと全端末がログアウトする）。

#### `apps/product/src/features/auth/server/recovery-service.ts`

- [ログイン（MFA 含む）](journeys/login.md) の 4. 6 桁のコード入力 — リカバリーコードの tRPC だけは、まだ aal1 のままでも protectedProcedure を通れるよう例外にしてある。MFA の関門を変える時はこの例外を壊さない。

#### `apps/product/src/features/auth/server/router.ts`

- [アカウントを削除する（不可逆）](journeys/account-deletion.md) の 2. 本人を確かめ直す — captcha を免除している経路なので、呼び出し元を増やす前に password-reauthentication.ts の契約と docs/product/specs/auth.md の保証境界を読む。検証用の session は scope: 'local' で消す（既定の global だと全端末がログアウトする）。
- [データを書き出す](journeys/data-export.md) の 4. Service が 6 本読む — service role は RLS を越えるので、Plan / Record では .eq('user_id', userId) だけが他人のデータとの境界になる（REVIEW-1）。userId は必ず ctx から取り、入力で受けない。列は public-projections の select に限っているので、列を足す時はそこを変える。

#### `apps/product/src/features/auth/server/user-service.ts`

- [アカウントを削除する（不可逆）](journeys/account-deletion.md) の 2. 本人を確かめ直す — captcha を免除している経路なので、呼び出し元を増やす前に password-reauthentication.ts の契約と docs/product/specs/auth.md の保証境界を読む。検証用の session は scope: 'local' で消す（既定の global だと全端末がログアウトする）。
- [アカウントを削除する（不可逆）](journeys/account-deletion.md) の 3. 経路を選ぶ — gate を有効にする migration は repo に無く、運用で切り替える前提。production で今どちらの経路が動いているかは未確認。旧経路は「古い instance が捌け切ったら消す」一時的な分岐。
- [アカウントを削除する（不可逆）](journeys/account-deletion.md) の 8. 封をして本体を消す — auth.users から ON DELETE CASCADE で届かないテーブルは、ここでは消えない。email_suppressions は削除後も残す扱いで未裁定（invariants.md）。この trigger は gate が有効な時だけ働く。
- [アカウントを削除する（不可逆）](journeys/account-deletion.md) の 9. 削除完了メール — 削除のあとは user_settings も profiles も無い。メールに要る値はすべて削除の前に控えておく。
- [データを書き出す](journeys/data-export.md) の 4. Service が 6 本読む — service role は RLS を越えるので、Plan / Record では .eq('user_id', userId) だけが他人のデータとの境界になる（REVIEW-1）。userId は必ず ctx から取り、入力で受けない。列は public-projections の select に限っているので、列を足す時はそこを変える。
- [データを書き出す](journeys/data-export.md) の 5. 行を読む — PostgREST は 1 回の応答の行数に上限（max_rows）があり、超えた分は黙って切られる。local の設定は 1000。Plan / Record が多い利用者に効くので、直すなら collectQueryPages で読み切る。

#### `apps/product/src/features/auth/server/welcome-email.ts`

- [サインアップ → ウェルカムメール](journeys/signup.md) の 5. 送る権利を取る — 1 回限りの通知を足す時の手本。列を足すだけだと既存ユーザー全員へ次のサインインで飛ぶので、migration 時点の既存行を送信済みで埋める。

#### `apps/product/src/features/auth/stores/useAuthStore.ts`

- [ログイン（MFA 含む）](journeys/login.md) の 2. パスワードを確かめる — 想定内の認証エラー（401 / 422 / 429 など）は Sentry に送らない。送る対象を変える時は isExpectedAuthError を見る。
- [サインアップ → ウェルカムメール](journeys/signup.md) の 2. Auth に登録 — 認証は Supabase に最も深く依存している部分。乗り換えの重さは出口コスト台帳。
- [パスワードを再設定する](journeys/password-reset.md) の 1. リセットを依頼 — 画面の出し分けを足すと列挙防止が崩れる。保証境界は docs/product/specs/auth.md のパスワードリセットの節。失敗の観測は画面ではなく store 側の Sentry が持つ。
- [パスワードを再設定する](journeys/password-reset.md) の 6. 新しいパスワードを送る — エラー code の読み分けは ResetPasswordForm の RECOVERY_UPDATE_BLOCKED_CODES と isMfaBlocked。message の文字列で判定しない方針。
- [パスワードを再設定する](journeys/password-reset.md) の 8. 他の端末を切る — 今の端末の session は残る。そのため 3 秒後の /auth/login への移動は、proxy が「サインイン済みで auth 系 path へ来た」と見て /calendar へ送り直すはず（コードから読んだ挙動。ブラウザでは未確認）。文言は「まもなくサインインページに移動します」。

#### `apps/product/src/features/calendar/components/controller/hooks/useCalendarData.ts`

- [AI クライアントから Plan を作る（MCP）](journeys/mcp.md) の 11. Dayopt の画面に現れる — すぐ反映したくなったら Realtime を足す判断になるが、infra.md は Realtime を現状の構成に含めていない。staleTime を短くすると全 query の取得回数が増える。

#### `apps/product/src/features/calendar/components/create/InlineCreatePanel.tsx`

- [Plan を保存](journeys/save-plan.md) の 2. 作成を依頼 — 作成の入口はここと、サイドバーのアクティビティタップの 2 つ。手数を変える時は両方を見る。

#### `apps/product/src/features/calendar/components/create/useInlineCreate.ts`

- [Plan を保存](journeys/save-plan.md) の 2. 作成を依頼 — 作成の入口はここと、サイドバーのアクティビティタップの 2 つ。手数を変える時は両方を見る。

#### `apps/product/src/features/calendar/components/views/shared/components/CalendarGridContent.tsx`

- [Record を作る・Plan を記録する](journeys/record-plan.md) の 2. 列へ落とす — 「そのまま記録」と違い、成功時に取り消しトーストが出ない。揃える時は useTimeblockRecordMutations の取り消しを流用する。

#### `apps/product/src/features/calendar/hooks/keyboard/useCalendarTimeblockKeyboard.ts`

- [削除と取り消し](journeys/delete-undo.md) の 1. 入口を選ぶ — 入口を足したら、useTimeblockDeleteUndo を通して同じ取り消しを出す。messages には「完全に削除されます。取り消せません」という確認文言が残っているが、Plan / Record の削除からは使われていない（未使用の文言）。

#### `apps/product/src/features/calendar/hooks/operations/useConvertGhostEvent.ts`

- [Google Calendar 連携](journeys/google-calendar.md) の 11. カレンダーに薄く表示 — 変換した Plan には source: external_calendar と元の予定の ID が付く。Google の予定を消しても、変換済みの Plan は残る。

#### `apps/product/src/features/calendar/hooks/operations/useTimeblockContextActions.ts`

- [削除と取り消し](journeys/delete-undo.md) の 1. 入口を選ぶ — 入口を足したら、useTimeblockDeleteUndo を通して同じ取り消しを出す。messages には「完全に削除されます。取り消せません」という確認文言が残っているが、Plan / Record の削除からは使われていない（未使用の文言）。

#### `apps/product/src/features/calendar/hooks/operations/useTimeblockOperations.ts`

- [Plan / Record を動かす・直す](journeys/edit-timeblock.md) の 2. 更新を依頼 — 時刻の規則の写し。規則を変える時は invariants.md §時刻 の写し表に沿ってここも消す。移行された Record を黙って無視する分岐は、UI 側で動かせないようにしている前提に立つ。
- [Plan / Record を動かす・直す](journeys/edit-timeblock.md) の 8. 確定して取り消しを出す — 取り消しも同じ更新 command を通るので、版の扱いを変えると取り消しも壊れる。集計画面を足したら取り直し対象に入れる。
- [削除と取り消し](journeys/delete-undo.md) の 1. 入口を選ぶ — 入口を足したら、useTimeblockDeleteUndo を通して同じ取り消しを出す。messages には「完全に削除されます。取り消せません」という確認文言が残っているが、Plan / Record の削除からは使われていない（未使用の文言）。

#### `apps/product/src/features/calendar/interaction/GhostRenderer.tsx`

- [Plan / Record を動かす・直す](journeys/edit-timeblock.md) の 1. ドラッグを離す — Plan を Record の列へ落とした時だけは更新ではなく記録になる（「Record を作る・Plan を記録する」）。重なりの判定を変える時は、DB の排他制約（Plan 同士・Record 同士、半開区間 [start, end)）と揃っているかを見る。

#### `apps/product/src/features/calendar/interaction/interaction-effects.ts`

- [Plan / Record を動かす・直す](journeys/edit-timeblock.md) の 1. ドラッグを離す — Plan を Record の列へ落とした時だけは更新ではなく記録になる（「Record を作る・Plan を記録する」）。重なりの判定を変える時は、DB の排他制約（Plan 同士・Record 同士、半開区間 [start, end)）と揃っているかを見る。
- [Record を作る・Plan を記録する](journeys/record-plan.md) の 1. 入口を選ぶ — 出す条件は DB 規則の写し。規則を変える時は invariants.md §時刻 の写し表に沿って 3 つとも見る。日の単位でまとめて記録する ConfirmDayButton も部品としてはあるが、画面に置いている箇所は見つからなかった（未確認）。

#### `apps/product/src/features/calendar/interaction/useInteraction.ts`

- [Plan / Record を動かす・直す](journeys/edit-timeblock.md) の 1. ドラッグを離す — Plan を Record の列へ落とした時だけは更新ではなく記録になる（「Record を作る・Plan を記録する」）。重なりの判定を変える時は、DB の排他制約（Plan 同士・Record 同士、半開区間 [start, end)）と揃っているかを見る。
- [Record を作る・Plan を記録する](journeys/record-plan.md) の 2. 列へ落とす — 「そのまま記録」と違い、成功時に取り消しトーストが出ない。揃える時は useTimeblockRecordMutations の取り消しを流用する。

#### `apps/product/src/features/calendar/lib/plan-record-drop.ts`

- [Record を作る・Plan を記録する](journeys/record-plan.md) の 2. 列へ落とす — 「そのまま記録」と違い、成功時に取り消しトーストが出ない。揃える時は useTimeblockRecordMutations の取り消しを流用する。

#### `apps/product/src/features/contact/components/ContactDialog.tsx`

- [問い合わせを送る](journeys/contact.md) の 2. 送信 ID を決める — ID を使い回す条件を広げると、別の問い合わせが前の送信と同じ扱いになって Resend に捨てられる。狭めると、再送で同じメールが 2 通届く。
- [問い合わせを送る](journeys/contact.md) の 7. 結果を出す — エラーの種類ごとに文言を増やす時は、error.data.code の分岐をここに足す。

#### `apps/product/src/features/contact/components/ContactDialogContent.tsx`

- [問い合わせを送る](journeys/contact.md) の 1. ダイアログを開く — 入力の上限（10〜5000 文字、環境情報の各長さ）はサーバーの zod schema が正本で、画面の 10 文字検査はその写し。カテゴリを足す時は schema、件名の対応表、翻訳を揃える。

#### `apps/product/src/features/contact/schemas.ts`

- [問い合わせを送る](journeys/contact.md) の 1. ダイアログを開く — 入力の上限（10〜5000 文字、環境情報の各長さ）はサーバーの zod schema が正本で、画面の 10 文字検査はその写し。カテゴリを足す時は schema、件名の対応表、翻訳を揃える。

#### `apps/product/src/features/contact/server/contact-service.ts`

- [問い合わせを送る](journeys/contact.md) の 5. Resend へ送る — 件名は [Dayopt Contact][Product][カテゴリ] の固定形、tags の source は contact-product。後段の Resend webhook はこの source と宛先で問い合わせの配送だと判定するので、変えると配送失敗が Sentry に出なくなる。LP（apps/web）のフォームは別実装で、Idempotency-Key の名前空間を contact-web- に分けてある。
- [問い合わせを送る](journeys/contact.md) の 6. Resend が受け付ける — 宛先は packages/config の supportEmail が正本。変えると Resend webhook の判定（宛先一致）も同時に変わる。

#### `apps/product/src/features/contact/server/router.ts`

- [問い合わせを送る](journeys/contact.md) の 3. 関門と回数制限 — Production のビルドは Upstash の env を必須にしているので、Production で回数制限が素通りになることはない。Preview では Upstash が無いと回数制限を飛ばすが、そもそも配送しない。
- [問い合わせを送る](journeys/contact.md) の 4. 送り主を確かめる — 返信先のアドレスは service 側でも検査する（改行やカンマで宛先を増やせないように）。

#### `apps/product/src/features/external-calendar/components/GoogleCalendarSettings.tsx`

- [Google Calendar 連携](journeys/google-calendar.md) の 1. 連携設定で接続 — ボタンは利用権（課金）を見ていない。利用権が切れた人が押すと /start が 403 の JSON を返し、ブラウザに JSON がそのまま出る。

#### `apps/product/src/features/external-calendar/lib/calendar-callback-result.ts`

- [Google Calendar 連携](journeys/google-calendar.md) の 4. callback で検証 — 失敗の理由はすべて ?calendar=error&reason=… で設定画面へ返し、専用の文言を出す。理由を足したら文言も足す。

#### `apps/product/src/features/external-calendar/server/../schemas/google.ts`

- [Google Calendar 連携](journeys/google-calendar.md) の 2. /start で準備 — MFA を利用権や rate limit より先に見るのは、MFA 不足で断る時に DB 読み取りや枠を消費しないため。

#### `apps/product/src/features/external-calendar/server/account-deletion.ts`

- [アカウントを削除する（不可逆）](journeys/account-deletion.md) の 5. Google の token を無効化 — Google Calendar を繋いでいない人は、この段は空で完了する。token の復号に失敗した時は Google を呼ばず not_attempted として記録する（Google 側では token の期限切れを待つことになる）。

#### `apps/product/src/features/external-calendar/server/connection-service.ts`

- [Google Calendar 連携](journeys/google-calendar.md) の 6. 暗号化して保存 — CALENDAR_TOKEN_ENCRYPTION_KEY を変えると、保存済みの token をすべて読めなくなる（全員が再接続になる）。

#### `apps/product/src/features/external-calendar/server/fenced-sync-writer.ts`

- [Google Calendar 連携](journeys/google-calendar.md) の 10. 予定を保存 — Plan / Record と別テーブルなので、時刻の規則（DT003 / DT005）はここには掛からない。

#### `apps/product/src/features/external-calendar/server/google-oauth.ts`

- [Google Calendar 連携](journeys/google-calendar.md) の 3. Google の同意画面 — 求める権限（scope）を増やすと、既存の接続は再同意が要る。Google の審査（OAuth verification）にも関わる。

#### `apps/product/src/features/external-calendar/server/providers/google.ts`

- [Google Calendar 連携](journeys/google-calendar.md) の 9. 予定を差分で取得 — refresh token の回転（新しい token の保存）はこの同期の中で行う。別の cron ではない。

#### `apps/product/src/features/external-calendar/server/router.ts`

- [Google Calendar 連携](journeys/google-calendar.md) の 1. 連携設定で接続 — ボタンは利用権（課金）を見ていない。利用権が切れた人が押すと /start が 403 の JSON を返し、ブラウザに JSON がそのまま出る。

#### `apps/product/src/features/external-calendar/server/sync-dispatcher.ts`

- [Google Calendar 連携](journeys/google-calendar.md) の 8. 15 分ごとの同期 cron — 取りこぼした回を埋め直さない。止まったことは heartbeat の完了時刻が古くなることで気づく（production の監査が見る）。

#### `apps/product/src/features/external-calendar/server/sync-service.ts`

- [Google Calendar 連携](journeys/google-calendar.md) の 10. 予定を保存 — Plan / Record と別テーブルなので、時刻の規則（DT003 / DT005）はここには掛からない。

#### `apps/product/src/features/external-calendar/server/token-crypto.ts`

- [Google Calendar 連携](journeys/google-calendar.md) の 6. 暗号化して保存 — CALENDAR_TOKEN_ENCRYPTION_KEY を変えると、保存済みの token をすべて読めなくなる（全員が再接続になる）。

#### `apps/product/src/features/external-calendar/server/token-rotation.ts`

- [Google Calendar 連携](journeys/google-calendar.md) の 9. 予定を差分で取得 — refresh token の回転（新しい token の保存）はこの同期の中で行う。別の cron ではない。

#### `apps/product/src/features/review/components/report/ReportBody.tsx`

- [レポートを開く（集計）](journeys/report.md) の 8. 派生して描く — computeDenominators の allActivities にフィルタを掛けてはいけない（仕様の 13-2）。予定比や鏡の閾値（EXECUTION_MIN_PLAN_MINUTES 等）は report-view-model.ts の定数。モバイル専用の集計を作らない。

#### `apps/product/src/features/review/domain/report/report-view-model.ts`

- [レポートを開く（集計）](journeys/report.md) の 2. 集計を問い合わせる — 集計の項目を足す時は、保存済みの古い形が復元されても落ちないよう normalizeReportPeriodPayload に既定値を足す。タブごとに別の query を作ると、仕様（review.md §5）の「1 期間 1 往復」が崩れる。
- [レポートを開く（集計）](journeys/report.md) の 8. 派生して描く — computeDenominators の allActivities にフィルタを掛けてはいけない（仕様の 13-2）。予定比や鏡の閾値（EXECUTION_MIN_PLAN_MINUTES 等）は report-view-model.ts の定数。モバイル専用の集計を作らない。

#### `apps/product/src/features/review/hooks/useReportActivityDetail.ts`

- [レポートを開く（集計）](journeys/report.md) の 9. 詳細を開いた時だけ取る — 明細から代表値を計算し直さない。期間を移すとパネルは閉じ、タブの切替では閉じない。モバイルは推移を出さないので includeTrend: false で呼ぶ。

#### `apps/product/src/features/review/hooks/useReportPeriod.ts`

- [レポートを開く（集計）](journeys/report.md) の 1. 期間を決める — date を server component の prop で受けると、期間の ‹ › 移動が画面に反映されなくなる（移動は history.replaceState で URL を書くだけで、server component は再描画されない）。page.tsx と ReportViewClient のコメントが理由を持つ。
- [レポートを開く（集計）](journeys/report.md) の 2. 集計を問い合わせる — 集計の項目を足す時は、保存済みの古い形が復元されても落ちないよう normalizeReportPeriodPayload に既定値を足す。タブごとに別の query を作ると、仕様（review.md §5）の「1 期間 1 往復」が崩れる。

#### `apps/product/src/features/review/lib/report-period.ts`

- [レポートを開く（集計）](journeys/report.md) の 5. 期間の境界を出す — 日付境界の組み方を変えるなら timezone.md の禁止パターン（ブラウザ TZ の 0 時を UTC 変換する等）を先に読む。ここの規則は詳細パネルの集計と共有している。

#### `apps/product/src/features/review/server/report-aggregation-service.ts`

- [レポートを開く（集計）](journeys/report.md) の 7. TS で集計 — 集計の数え方は lib/time の aggregate を詳細パネルと共有している。中央値の母集団（期間へ切り取った長さ、auto_migrated を除く）を片方だけ変えると、一覧と詳細パネルで同じアクティビティの中央値が食い違う。現在時刻（nowAt）はサーバーの値を返して、ブラウザの時計とのずれで数字が揺れないようにしている。

#### `apps/product/src/features/review/server/report-detail-service.ts`

- [レポートを開く（集計）](journeys/report.md) の 9. 詳細を開いた時だけ取る — 明細から代表値を計算し直さない。期間を移すとパネルは閉じ、タブの切替では閉じない。モバイルは推移を出さないので includeTrend: false で呼ぶ。

#### `apps/product/src/features/review/server/report-fetchers.ts`

- [レポートを開く（集計）](journeys/report.md) の 6. 行を取る — RLS（利用者の権限の client）に加えて user_id でも絞っている。PostgREST の 1 回あたりの行数上限に黙って切られないよう collectQueryPages で読み切るので、ここを単発の select に戻すと多い期間で数字が欠ける。
- [レポートを開く（集計）](journeys/report.md) の 9. 詳細を開いた時だけ取る — 明細から代表値を計算し直さない。期間を移すとパネルは閉じ、タブの切替では閉じない。モバイルは推移を出さないので includeTrend: false で呼ぶ。

#### `apps/product/src/features/review/server/router.ts`

- [レポートを開く（集計）](journeys/report.md) の 4. Router で検証 — timezone の正当性は長さしか見ておらず、実在しない名前は日付計算の側で失敗する（その時の挙動は未確認）。検証を足すなら ANCHOR_DATE / TIMEZONE の定義を変える。

#### `apps/product/src/features/settings/components/AccountDeletionDialog.tsx`

- [アカウントを削除する（不可逆）](journeys/account-deletion.md) の 1. 確認ダイアログ — どの再認証手段を出すかは画面の推定（hasPasswordIdentity）。実際に何を求めるかはサーバーが user の identity から決め直すので、画面だけ変えても再認証は緩まない。
- [アカウントを削除する（不可逆）](journeys/account-deletion.md) の 10. サインイン画面へ — 同じメールアドレスで入り直そうとしても、ユーザーはもういないのでサインインできない（E2E が確かめている）。

#### `apps/product/src/features/settings/components/BillingSettings.tsx`

- [Pro を契約する（課金）](journeys/billing.md) の 1. 請求画面で購入 — 課金を強制していない間も、この購入ボタンは出る（説明文だけ「現在、全機能を無料で利用できます。」に変わる）。表示条件は契約状態（subscription_status）で、利用権（access）ではない。失敗時の文言と再試行の可否は billing-operation.ts の対応表に集約してあり、消費側 4 箇所が共有する。

#### `apps/product/src/features/settings/components/DataSettings.tsx`

- [データを書き出す](journeys/data-export.md) の 1. 形式と範囲を選ぶ — 同じ画面の下に、全件削除（deleteBlocks / deleteAllData）がある。こちらは不可逆なので、エクスポートとは別の経路として扱い、ここを変える時に巻き込まない。
- [データを書き出す](journeys/data-export.md) の 2. 押した時に問い合わせる — refetch の結果は例外にならず、失敗しても前回成功した data を持ったまま返る。成否を data の有無だけで判定しているので、ここを触る時は result.isError も見る形にする。
- [データを書き出す](journeys/data-export.md) の 7. 期間で絞る — 日付の境界をブラウザで組んでいて、利用者の timezone 設定を使っていない（timezone.md の禁止パターンに近い書き方）。開始日は UTC の 0 時として読まれ、終了日はブラウザの timezone で閉じるので、両端の扱いが揃っていない。直すなら toTZStartISO / toTZEndISO を利用者の timezone で使う。絞り込みは開始時刻だけで、期間を跨ぐ Plan / Record は開始側の期間にしか入らない。
- [データを書き出す](journeys/data-export.md) の 8. CSV か JSON にする — CSV の列を足すと、既存のスプレッドシートの取り込み手順が壊れうる（外部に渡る形式）。列は TIMEBLOCK_CSV_COLUMNS 1 か所で決まる。CSV にはカテゴリとアクティビティの名前が入らず、activity_id だけになる。
- [データを書き出す](journeys/data-export.md) の 9. ファイルを保存する — 成功のトーストは click を呼んだ時点で出していて、ブラウザが実際に保存したかは確かめていない。

#### `apps/product/src/features/settings/components/PasswordChangeDialog.tsx`

- [パスワードを再設定する](journeys/password-reset.md) の 10. （別入口）設定から変更 — production の require_current_password が off になると、current_password は黙って無視され、現在のパスワードを知らなくても変えられる。Auth config audit がこの値を固定している。他端末のサインアウトに失敗した時は、こちらは画面に警告を出す（リセット経路とは違う）。

#### `apps/product/src/features/settings/lib/billing-operation.ts`

- [Pro を契約する（課金）](journeys/billing.md) の 1. 請求画面で購入 — 課金を強制していない間も、この購入ボタンは出る（説明文だけ「現在、全機能を無料で利用できます。」に変わる）。表示条件は契約状態（subscription_status）で、利用権（access）ではない。失敗時の文言と再試行の可否は billing-operation.ts の対応表に集約してあり、消費側 4 箇所が共有する。

#### `apps/product/src/features/settings/lib/billing-poll.ts`

- [Pro を契約する（課金）](journeys/billing.md) の 4. 戻りの URL を読む — 成功の toast は URL だけを根拠に出る（webhook 到達前でも「契約が有効になりました」と出る）。文言や判定をいじる時は、ここが確定情報ではないことを前提にする。query は PC では設定モーダルを開いて消すので、BillingSettings 側では読めない。

#### `apps/product/src/features/settings/lib/timeblock-csv-export.ts`

- [データを書き出す](journeys/data-export.md) の 8. CSV か JSON にする — CSV の列を足すと、既存のスプレッドシートの取り込み手順が壊れうる（外部に渡る形式）。列は TIMEBLOCK_CSV_COLUMNS 1 か所で決まる。CSV にはカテゴリとアクティビティの名前が入らず、activity_id だけになる。

#### `apps/product/src/features/settings/server/account-deletion.ts`

- [アカウントを削除する（不可逆）](journeys/account-deletion.md) の 7. Stripe を解約・削除 — 解約すると Stripe から customer.subscription.deleted の webhook が別に届く。それが削除より先に処理されて解約確認メールが出るかどうかは、到着の順番次第で未確認。返金の扱いはこのコードには無い。

#### `apps/product/src/features/settings/server/billing-mutation-service.ts`

- [Pro を契約する（課金）](journeys/billing.md) の 2. Checkout を作る — 外部契約。success_url / cancel_url の query を変えると、復帰を解釈する parseBillingReturn と E2E が同時に壊れる。idempotency key の接頭辞を変えると、切り替えをまたいだ再送で Checkout が二重に作られうる。課金を強制していない間は、試用歴が無ければ Stripe 側に 7 日の trial（dayoptProTrialDays）を付け、強制時はカード決済のみで trial を付けない。
- [Pro を契約する（課金）](journeys/billing.md) の 10. Customer Portal — 外部契約。return_url の query を変えると parseBillingReturn が復帰を検出できず、IndexedDB に永続化した古い課金概要が 5 分間そのまま出る。解約予約中は期間終了まで active のまま（予約した時点で利用権を落とさない）。

#### `apps/product/src/features/settings/server/billing-router.ts`

- [Pro を契約する（課金）](journeys/billing.md) の 2. Checkout を作る — 外部契約。success_url / cancel_url の query を変えると、復帰を解釈する parseBillingReturn と E2E が同時に壊れる。idempotency key の接頭辞を変えると、切り替えをまたいだ再送で Checkout が二重に作られうる。課金を強制していない間は、試用歴が無ければ Stripe 側に 7 日の trial（dayoptProTrialDays）を付け、強制時はカード決済のみで trial を付けない。

#### `apps/product/src/features/settings/server/billing-service.ts`

- [Pro を契約する（課金）](journeys/billing.md) の 2. Checkout を作る — 外部契約。success_url / cancel_url の query を変えると、復帰を解釈する parseBillingReturn と E2E が同時に壊れる。idempotency key の接頭辞を変えると、切り替えをまたいだ再送で Checkout が二重に作られうる。課金を強制していない間は、試用歴が無ければ Stripe 側に 7 日の trial（dayoptProTrialDays）を付け、強制時はカード決済のみで trial を付けない。
- [Pro を契約する（課金）](journeys/billing.md) の 7. 契約状態を書く — 外部契約。Stripe の status の写し（mapStripeSubscriptionStatus）を変えると、active / trialing / past_due を「契約中」とみなす判定（isProSubscriptionStatus）と噛み合わなくなる。メール送信は失敗しても 200 を返す（throw すると Stripe が再送し、状態同期が揺れる）。durable 経路では未対応の event 種別を 500 にするので、Stripe Dashboard で購読 event を足すとそれが再送され続ける。
- [Pro を契約する（課金）](journeys/billing.md) の 10. Customer Portal — 外部契約。return_url の query を変えると parseBillingReturn が復帰を検出できず、IndexedDB に永続化した古い課金概要が 5 分間そのまま出る。解約予約中は期間終了まで active のまま（予約した時点で利用権を落とさない）。

#### `apps/product/src/features/settings/server/billing-webhook-reconciliation.ts`

- [Pro を契約する（課金）](journeys/billing.md) の 11. 夜間の照合 — 直すのは人間。検出したら Stripe Dashboard から該当 event を再送する（runbook Playbook 3）。Stripe の env が全て無ければ configured: false で素通りし、一部だけなら 503 にする。

#### `apps/product/src/features/timeblock/components/editor/TimeblockInspectorForm.tsx`

- [Plan / Record を動かす・直す](journeys/edit-timeblock.md) の 3. Inspector で直す — まとめ方を変えると、競合時にどの変更を捨てるか（古い版の待ち行列は捨てる）と、結果が分からない時に止めるか（止めて自動再送しない）の 2 つが崩れる。Inspector は自前の取り消しトーストを出さない。
- [Record を作る・Plan を記録する](journeys/record-plan.md) の 1. 入口を選ぶ — 出す条件は DB 規則の写し。規則を変える時は invariants.md §時刻 の写し表に沿って 3 つとも見る。日の単位でまとめて記録する ConfirmDayButton も部品としてはあるが、画面に置いている箇所は見つからなかった（未確認）。
- [Record を作る・Plan を記録する](journeys/record-plan.md) の 3. 編集を保存しきる — 記録を Plan の最新内容と揃える要。ここを飛ばすと版が古くなり、記録は DT002 で弾かれる。
- [削除と取り消し](journeys/delete-undo.md) の 1. 入口を選ぶ — 入口を足したら、useTimeblockDeleteUndo を通して同じ取り消しを出す。messages には「完全に削除されます。取り消せません」という確認文言が残っているが、Plan / Record の削除からは使われていない（未使用の文言）。
- [削除と取り消し](journeys/delete-undo.md) の 2. 編集を保存しきる — カレンダー側の入口はこの準備をしない（キャッシュの版を使う）。Inspector を開いたままのキーボード削除は、保存が走っている最中だと版が古くなりうる（未確認・推測）。
- [削除と取り消し](journeys/delete-undo.md) の 6. 取り消しを出す — 取り消しの出し方はカレンダーと Inspector で 1 つにする意図（useTimeblockDeleteUndo）だが、Inspector は自前で同じトーストを組んでいる。変える時は両方を見る。「元に戻す」付きのトーストが出ている間、action の無い成功トーストは出さない（lib/toast）ので、「復元しました」が出ないこともある。

#### `apps/product/src/features/timeblock/components/editor/TimeblockRecordActions.tsx`

- [Record を作る・Plan を記録する](journeys/record-plan.md) の 3. 編集を保存しきる — 記録を Plan の最新内容と揃える要。ここを飛ばすと版が古くなり、記録は DT002 で弾かれる。
- [Record を作る・Plan を記録する](journeys/record-plan.md) の 4. 記録を依頼 — 楽観的に描く形へ変えるなら、DB の写し方（タイトル・メモ・アクティビティ・時刻）と一致させる必要がある。

#### `apps/product/src/features/timeblock/domain/timeblock-destination.ts`

- [Plan を保存](journeys/save-plan.md) の 1. Plan か Record か決める — 時刻の規則を強制しているのは DB trigger で、ここはその写し。ここだけ変えても保存できるかどうかは変わらない。規則を撤去・変更する時は invariants.md §時刻 の写し表を全部たどる。
- [Record を作る・Plan を記録する](journeys/record-plan.md) の 1. 入口を選ぶ — 出す条件は DB 規則の写し。規則を変える時は invariants.md §時刻 の写し表に沿って 3 つとも見る。日の単位でまとめて記録する ConfirmDayButton も部品としてはあるが、画面に置いている箇所は見つからなかった（未確認）。

#### `apps/product/src/features/timeblock/hooks/useCoalescedTimeblockSave.ts`

- [Plan / Record を動かす・直す](journeys/edit-timeblock.md) の 3. Inspector で直す — まとめ方を変えると、競合時にどの変更を捨てるか（古い版の待ち行列は捨てる）と、結果が分からない時に止めるか（止めて自動再送しない）の 2 つが崩れる。Inspector は自前の取り消しトーストを出さない。

#### `apps/product/src/features/timeblock/hooks/useTimeblockDeleteUndo.ts`

- [削除と取り消し](journeys/delete-undo.md) の 6. 取り消しを出す — 取り消しの出し方はカレンダーと Inspector で 1 つにする意図（useTimeblockDeleteUndo）だが、Inspector は自前で同じトーストを組んでいる。変える時は両方を見る。「元に戻す」付きのトーストが出ている間、action の無い成功トーストは出さない（lib/toast）ので、「復元しました」が出ないこともある。

#### `apps/product/src/features/timeblock/hooks/useTimeblockRecordMutations.ts`

- [Record を作る・Plan を記録する](journeys/record-plan.md) の 4. 記録を依頼 — 楽観的に描く形へ変えるなら、DB の写し方（タイトル・メモ・アクティビティ・時刻）と一致させる必要がある。
- [Record を作る・Plan を記録する](journeys/record-plan.md) の 8. 出して取り消しを出す — 取り消しは recordCommands.delete（ソフト削除）を通るので、「削除と取り消し」の規則がそのまま効く。

#### `apps/product/src/features/timeblock/hooks/useTimeblockWriteMutations.ts`

- [Plan を保存](journeys/save-plan.md) の 3. 先に画面へ出す — キャッシュのキーや一覧の絞り込み条件を変えると、差し込み先と巻き戻し対象がずれる。書き込み mutation を足す時は optimistic-update skill の手順に従う。
- [Plan を保存](journeys/save-plan.md) の 4. tRPC で送る — link を足す・変える影響は全 API に及ぶ。エラーを受ける共通処理（401 で画面ごとログインへ移動、Sentry 送信）は QueryClient 側にある。
- [Plan を保存](journeys/save-plan.md) の 10. 確定して取り直す — 新しい集計画面を足したら、ここの取り直し対象に入れないと保存後も古い数字が残る。
- [Plan / Record を動かす・直す](journeys/edit-timeblock.md) の 4. 先に書き換える — 書き換える項目はタイトル・メモ・開始・終了（Record は充実度も）だけ。アクティビティの変更はここでは一覧へ反映せず、返事で差し替わる。書き換える項目を足す時はここと onSuccess の差し替えを揃える。
- [Plan / Record を動かす・直す](journeys/edit-timeblock.md) の 8. 確定して取り消しを出す — 取り消しも同じ更新 command を通るので、版の扱いを変えると取り消しも壊れる。集計画面を足したら取り直し対象に入れる。
- [削除と取り消し](journeys/delete-undo.md) の 3. 先に消す — 削除の失敗文言は 1 種類だけ。競合を区別したくなったら reportDeleteError で code を見る。
- [削除と取り消し](journeys/delete-undo.md) の 8. 入れ直す — 集計画面を足したら取り直し対象に入れないと、削除・復元の前後で数字が揃わない。

#### `apps/product/src/features/timeblock/server/mcp-mutation-client.ts`

- [AI クライアントから Plan を作る（MCP）](journeys/mcp.md) の 8. DB が書き込みを認可 — gate の開閉は SQL を直接書かず pnpm mcp:gate（revision 付きの service role 限定 RPC）で行う。Write Fence はこの gate に効かないので、障害時に MCP の書き込みを止めるには gate を別に閉じる。認可の条件を変える時は REVIEW-1（ユーザー分離）の観点で読む。
- [AI クライアントから Plan を作る（MCP）](journeys/mcp.md) の 9. 画面と同じ関数で書く — create_plan_command_v1 の規則を変えると、画面と MCP の両方が同時に変わる。MCP のエラーコード対応表（EXPECTED_ERROR_CODES）は画面側の表とは別にあるので、新しい SQLSTATE を足したら両方に足さないと MCP だけ MUTATION_FAILED になる。

#### `apps/product/src/features/timeblock/server/mcp-mutation-db.ts`

- [AI クライアントから Plan を作る（MCP）](journeys/mcp.md) の 8. DB が書き込みを認可 — gate の開閉は SQL を直接書かず pnpm mcp:gate（revision 付きの service role 限定 RPC）で行う。Write Fence はこの gate に効かないので、障害時に MCP の書き込みを止めるには gate を別に閉じる。認可の条件を変える時は REVIEW-1（ユーザー分離）の観点で読む。

#### `apps/product/src/features/timeblock/server/plan-commands-router.ts`

- [Plan を保存](journeys/save-plan.md) の 7. Router → Service — 業務ロジックは Service に置き、Router に書かない（trpc-router-creating skill）。利用記録は best-effort で、失敗しても保存は取り消さない。
- [Plan / Record を動かす・直す](journeys/edit-timeblock.md) の 5. Router → Service — schema に項目を足す時は、Service で埋める処理と command の引数を揃える。userId を input から受け取る形にしない（REVIEW-1）。
- [Record を作る・Plan を記録する](journeys/record-plan.md) の 5. Router → Service — 入力に項目を足す時も userId は ctx から渡す（REVIEW-1）。
- [削除と取り消し](journeys/delete-undo.md) の 4. Router → Service — 入力に項目を足す時も userId は ctx から渡す（REVIEW-1）。

#### `apps/product/src/features/timeblock/server/record-commands-router.ts`

- [Plan / Record を動かす・直す](journeys/edit-timeblock.md) の 5. Router → Service — schema に項目を足す時は、Service で埋める処理と command の引数を揃える。userId を input から受け取る形にしない（REVIEW-1）。

#### `apps/product/src/features/timeblock/server/timeblock-command-client.ts`

- [Plan を保存](journeys/save-plan.md) の 8. RPC で書き込む — service role は RLS を越える。テナント分離は「この adapter が必ず user_id を渡す」ことで守っている。ここへ command を足す時は REVIEW-1（ユーザー分離）の観点で読む。
- [Plan / Record を動かす・直す](journeys/edit-timeblock.md) の 6. RPC で更新 — 訳したコードは client-safe-service-code.ts の許可一覧に載っているものだけがブラウザへ届く。載っていないコードは「結果不明」として扱われ、Inspector が止まる側に倒れる。
- [Record を作る・Plan を記録する](journeys/record-plan.md) の 6. RPC で記録 — 版付きの操作を足したら VERSIONED_TARGET_OPERATIONS に入れる。
- [削除と取り消し](journeys/delete-undo.md) の 5. deleted_at を付ける — deleted_at の付いた行は一覧・重なりの判定（排他制約は deleted_at IS NULL だけが対象）から外れる。削除済みの行を自動で物理削除する仕組みは見つからなかった（未確認）。
- [削除と取り消し](journeys/delete-undo.md) の 7. deleted_at を外す — Record の復元は DT005（未来に終われない）の対象外（時刻を変えないため trigger が見ない）。

#### `apps/product/src/features/timeblock/server/timeblock-command-service.ts`

- [Plan を保存](journeys/save-plan.md) の 7. Router → Service — 業務ロジックは Service に置き、Router に書かない（trpc-router-creating skill）。利用記録は best-effort で、失敗しても保存は取り消さない。
- [Plan / Record を動かす・直す](journeys/edit-timeblock.md) の 5. Router → Service — schema に項目を足す時は、Service で埋める処理と command の引数を揃える。userId を input から受け取る形にしない（REVIEW-1）。
- [Record を作る・Plan を記録する](journeys/record-plan.md) の 5. Router → Service — 入力に項目を足す時も userId は ctx から渡す（REVIEW-1）。
- [削除と取り消し](journeys/delete-undo.md) の 4. Router → Service — 入力に項目を足す時も userId は ctx から渡す（REVIEW-1）。

#### `apps/product/src/lib/auth/domain/access-policy.ts`

- [ログイン（MFA 含む）](journeys/login.md) の 6. proxy がセッションを確認 — 保護する画面を足す時は access-policy の protectedProductPaths に入れる。入れ忘れると未ログインでも開ける。
- [パスワードを再設定する](journeys/password-reset.md) の 4. リンクで着地 — signup・email_change も同じ route を通る。分岐を変える時は type ごとの着地先をテストで確かめる。/auth/confirm と /auth/reset-password はサインイン中でも通れる path に登録してある（access-policy.ts）。

#### `apps/product/src/lib/auth/session-config.ts`

- [ログイン（MFA 含む）](journeys/login.md) の 7. カレンダーに着地 — しばらく操作しないと自動でサインアウトし、/auth/login?reason=timeout へ戻る。

#### `apps/product/src/lib/billing/BillingAccessProvider.tsx`

- [Pro を契約する（課金）](journeys/billing.md) の 9. 画面へ反映 — state が変わった時だけ getOverview を取り直す。初回解決で取り直すと、同じ読み込みで二重に取得して rate limit を圧迫する（#2669）。

#### `apps/product/src/lib/billing/access-service.ts`

- [Pro を契約する（課金）](journeys/billing.md) の 8. 利用権を判定 — BILLING_ENFORCED は既定 false で、公開手順の文書は本番を false のまま保つと書く（本番の実値はこの教材では未確認）。つまり今の利用者は、契約してもしなくても全機能を使え、45 日体験も始まらない。契約すれば Stripe での課金は実際に走る。true へ切り替える時は DB 側と MCP の切り替えを先に行う順序がある（rollout §公開順序 6）。env だけ変えると MCP と書き込みの判定がずれる。

#### `apps/product/src/lib/billing/enforcement-flag.ts`

- [Pro を契約する（課金）](journeys/billing.md) の 8. 利用権を判定 — BILLING_ENFORCED は既定 false で、公開手順の文書は本番を false のまま保つと書く（本番の実値はこの教材では未確認）。つまり今の利用者は、契約してもしなくても全機能を使え、45 日体験も始まらない。契約すれば Stripe での課金は実際に走る。true へ切り替える時は DB 側と MCP の切り替えを先に行う順序がある（rollout §公開順序 6）。env だけ変えると MCP と書き込みの判定がずれる。

#### `apps/product/src/lib/billing/operation-access.ts`

- [レポートを開く（集計）](journeys/report.md) の 3. /api/trpc と関門 — requiresProductAccess を変えると、レポートを含む全 query の見え方が課金状態で変わる。ここは全 tRPC 共通なので、変更の影響は保存経路（Plan を保存）と同じ範囲に及ぶ。
- [データを書き出す](journeys/data-export.md) の 3. /api/trpc と関門 — requiresProductAccess を query にも掛けると、課金が切れた利用者がエクスポートできなくなる。operation-access.ts の一覧に user.exportData があるのは mutation 向けの例外表で、query のこの経路には効いていない。
- [問い合わせを送る](journeys/contact.md) の 3. 関門と回数制限 — Production のビルドは Upstash の env を必須にしているので、Production で回数制限が素通りになることはない。Preview では Upstash が無いと回数制限を飛ばすが、そもそも配送しない。

#### `apps/product/src/lib/database/collect-query-pages.ts`

- [レポートを開く（集計）](journeys/report.md) の 6. 行を取る — RLS（利用者の権限の client）に加えて user_id でも絞っている。PostgREST の 1 回あたりの行数上限に黙って切られないよう collectQueryPages で読み切るので、ここを単発の select に戻すと多い期間で数字が欠ける。
- [データを書き出す](journeys/data-export.md) の 5. 行を読む — PostgREST は 1 回の応答の行数に上限（max_rows）があり、超えた分は黙って切られる。local の設定は 1000。Plan / Record が多い利用者に効くので、直すなら collectQueryPages で読み切る。

#### `apps/product/src/lib/database/public-projections.ts`

- [データを書き出す](journeys/data-export.md) の 4. Service が 6 本読む — service role は RLS を越えるので、Plan / Record では .eq('user_id', userId) だけが他人のデータとの境界になる（REVIEW-1）。userId は必ず ctx から取り、入力で受けない。列は public-projections の select に限っているので、列を足す時はそこを変える。

#### `apps/product/src/lib/email/notifications.ts`

- [アカウントを削除する（不可逆）](journeys/account-deletion.md) の 9. 削除完了メール — 削除のあとは user_settings も profiles も無い。メールに要る値はすべて削除の前に控えておく。

#### `apps/product/src/lib/email/send.ts`

- [サインアップ → ウェルカムメール](journeys/signup.md) の 6. Resend で送る — メール送信を足す時はここを通す。Resend を直接呼ぶと suppression を素通りする（問い合わせフォームは例外で、自前で idempotency key を付けて Resend の API を呼ぶ）。

#### `apps/product/src/lib/hooks/useLogout.ts`

- [ログイン（MFA 含む）](journeys/login.md) の 7. カレンダーに着地 — しばらく操作しないと自動でサインアウトし、/auth/login?reason=timeout へ戻る。

#### `apps/product/src/lib/hooks/useServiceWorker.ts`

- [merge → 本番公開](journeys/deploy.md) の 7. タブが新版に気づく — API の入出力を変えた直後は、旧版の画面が新版のサーバーを呼ぶ時間がある。tRPC の入力を必須化する変更は、旧画面からの呼び出しを壊す。

#### `apps/product/src/lib/mcp/auth.ts`

- [AI クライアントから Plan を作る（MCP）](journeys/mcp.md) の 6. /api/mcp で token を検証 — 401 / 403 の WWW-Authenticate の形は、クライアントが再認可するかを決める外部契約。5xx を 401 に丸めると、クライアントが再認可を繰り返して本当の障害が見えなくなる（route.ts のコメント）。

#### `apps/product/src/lib/mcp/trpc-bridge.ts`

- [AI クライアントから Plan を作る（MCP）](journeys/mcp.md) の 5. plans.create を呼ぶ — tool 名（plans.create）・入力 schema・必要 scope（write:plans）は外部契約。改名・削除・必須項目の追加は、既存クライアントと、それを前提に書かれた利用者の指示を壊す。tool の説明文は「Create one future Plan」のままで、過去にも Plan を置ける現行の規則と食い違っている。

#### `apps/product/src/lib/oauth-server/clients.ts`

- [AI クライアントから Plan を作る（MCP）](journeys/mcp.md) の 1. 401 から接続先を発見 — scopes_supported・endpoint の URL・client の allowlist は外部契約。scope を改名・削除すると、既に接続済みのクライアントの token が解釈できなくなる（保存済み scope が未知だと token 不正扱い）。

#### `apps/product/src/lib/oauth-server/code-exchange.ts`

- [AI クライアントから Plan を作る（MCP）](journeys/mcp.md) の 4. code を token に換える — token endpoint の応答形式・grant_type は外部契約。Write Fence が止めるのは authorization_code（新規接続）だけで、refresh は通す。fence 中も既存の接続は既存の token で書けるため、refresh を止めても防げるものが無い、という判断。

#### `apps/product/src/lib/oauth-server/metadata.ts`

- [AI クライアントから Plan を作る（MCP）](journeys/mcp.md) の 1. 401 から接続先を発見 — scopes_supported・endpoint の URL・client の allowlist は外部契約。scope を改名・削除すると、既に接続済みのクライアントの token が解釈できなくなる（保存済み scope が未知だと token 不正扱い）。
- [AI クライアントから Plan を作る（MCP）](journeys/mcp.md) の 2. 認可リクエストを検証 — redirect_uri の登録や PKCE の要件を緩めると、code が第三者のドメインへ渡る穴になる（clients.ts のコメント）。security skill の観点で読む。

#### `apps/product/src/lib/oauth-server/scopes.ts`

- [AI クライアントから Plan を作る（MCP）](journeys/mcp.md) の 1. 401 から接続先を発見 — scopes_supported・endpoint の URL・client の allowlist は外部契約。scope を改名・削除すると、既に接続済みのクライアントの token が解釈できなくなる（保存済み scope が未知だと token 不正扱い）。

#### `apps/product/src/lib/oauth-server/tokens.ts`

- [AI クライアントから Plan を作る（MCP）](journeys/mcp.md) の 4. code を token に換える — token endpoint の応答形式・grant_type は外部契約。Write Fence が止めるのは authorization_code（新規接続）だけで、refresh は通す。fence 中も既存の接続は既存の token で書けるため、refresh を止めても防げるものが無い、という判断。

#### `apps/product/src/lib/oauth-server/write-gate.ts`

- [AI クライアントから Plan を作る（MCP）](journeys/mcp.md) の 3. 同意して code を得る — scope の表示名と付与判定は外部契約に直結する。付与判定（resolveGrantableScopes）は token 検証側（段 6）と規則を共有しているので、片方だけ変えると同意時と利用時で権限が食い違う。

#### `apps/product/src/lib/rate-limit/upstash.ts`

- [問い合わせを送る](journeys/contact.md) の 3. 関門と回数制限 — Production のビルドは Upstash の env を必須にしているので、Production で回数制限が素通りになることはない。Preview では Upstash が無いと回数制限を飛ばすが、そもそも配送しない。

#### `apps/product/src/lib/safe-redirect.ts`

- [ログイン（MFA 含む）](journeys/login.md) の 5. コードを検証 — 遷移先は getSafeRedirectPath で必ず検査する。外部 URL を渡されるとオープンリダイレクトになる。
- [ログイン（MFA 含む）](journeys/login.md) の 7. カレンダーに着地 — しばらく操作しないと自動でサインアウトし、/auth/login?reason=timeout へ戻る。

#### `apps/product/src/lib/sentry/integration.ts`

- [ログイン（MFA 含む）](journeys/login.md) の 2. パスワードを確かめる — 想定内の認証エラー（401 / 422 / 429 など）は Sentry に送らない。送る対象を変える時は isExpectedAuthError を見る。

#### `apps/product/src/lib/stripe/webhook-identity.ts`

- [Pro を契約する（課金）](journeys/billing.md) の 6. fence・照合・予約 — 予約の状態（processing / processed / failed）は夜間の照合 cron も読む。状態名を変えると照合が invalidState を数え出す。5 分以上 processing のままの予約は古いとみなして取り直せる。

#### `apps/product/src/lib/tanstack-query/should-persist-query.ts`

- [データを書き出す](journeys/data-export.md) の 6. 応答を受け取る — 全データを端末に残したくないなら、useQuery に meta: { persist: false } を付ける。応答の大きさは件数に比例する。Vercel の応答サイズの上限に当たるかは未確認。

#### `apps/product/src/lib/time/derived-model.ts`

- [レポートを開く（集計）](journeys/report.md) の 7. TS で集計 — 集計の数え方は lib/time の aggregate を詳細パネルと共有している。中央値の母集団（期間へ切り取った長さ、auto_migrated を除く）を片方だけ変えると、一覧と詳細パネルで同じアクティビティの中央値が食い違う。現在時刻（nowAt）はサーバーの値を返して、ブラウザの時計とのずれで数字が揺れないようにしている。

#### `apps/product/src/lib/toast.ts`

- [削除と取り消し](journeys/delete-undo.md) の 6. 取り消しを出す — 取り消しの出し方はカレンダーと Inspector で 1 つにする意図（useTimeblockDeleteUndo）だが、Inspector は自前で同じトーストを組んでいる。変える時は両方を見る。「元に戻す」付きのトーストが出ている間、action の無い成功トーストは出さない（lib/toast）ので、「復元しました」が出ないこともある。

#### `apps/product/src/lib/trpc/browser-client.ts`

- [Plan を保存](journeys/save-plan.md) の 4. tRPC で送る — link を足す・変える影響は全 API に及ぶ。エラーを受ける共通処理（401 で画面ごとログインへ移動、Sentry 送信）は QueryClient 側にある。

#### `apps/product/src/lib/trpc/client-safe-service-code.ts`

- [Plan / Record を動かす・直す](journeys/edit-timeblock.md) の 6. RPC で更新 — 訳したコードは client-safe-service-code.ts の許可一覧に載っているものだけがブラウザへ届く。載っていないコードは「結果不明」として扱われ、Inspector が止まる側に倒れる。

#### `apps/product/src/lib/trpc/context.ts`

- [Plan を保存](journeys/save-plan.md) の 5. /api/trpc で受ける — ここは全 tRPC 共通の入口。context に項目を足すと全 procedure の実行前コストが増える。
- [レポートを開く（集計）](journeys/report.md) の 3. /api/trpc と関門 — requiresProductAccess を変えると、レポートを含む全 query の見え方が課金状態で変わる。ここは全 tRPC 共通なので、変更の影響は保存経路（Plan を保存）と同じ範囲に及ぶ。
- [データを書き出す](journeys/data-export.md) の 3. /api/trpc と関門 — requiresProductAccess を query にも掛けると、課金が切れた利用者がエクスポートできなくなる。operation-access.ts の一覧に user.exportData があるのは mutation 向けの例外表で、query のこの経路には効いていない。

#### `apps/product/src/lib/trpc/procedures.ts`

- [Plan を保存](journeys/save-plan.md) の 6. 関門チェック — 順序に理由がある。write fence を rate limit より先に見るのは、止めている間の依頼で自分の枠を使い切り、復旧直後に締め出されるのを避けるため。
- [レポートを開く（集計）](journeys/report.md) の 3. /api/trpc と関門 — requiresProductAccess を変えると、レポートを含む全 query の見え方が課金状態で変わる。ここは全 tRPC 共通なので、変更の影響は保存経路（Plan を保存）と同じ範囲に及ぶ。
- [ログイン（MFA 含む）](journeys/login.md) の 4. 6 桁のコード入力 — リカバリーコードの tRPC だけは、まだ aal1 のままでも protectedProcedure を通れるよう例外にしてある。MFA の関門を変える時はこの例外を壊さない。
- [Pro を契約する（課金）](journeys/billing.md) の 8. 利用権を判定 — BILLING_ENFORCED は既定 false で、公開手順の文書は本番を false のまま保つと書く（本番の実値はこの教材では未確認）。つまり今の利用者は、契約してもしなくても全機能を使え、45 日体験も始まらない。契約すれば Stripe での課金は実際に走る。true へ切り替える時は DB 側と MCP の切り替えを先に行う順序がある（rollout §公開順序 6）。env だけ変えると MCP と書き込みの判定がずれる。

#### `apps/product/src/lib/trpc/query-client.ts`

- [Plan を保存](journeys/save-plan.md) の 4. tRPC で送る — link を足す・変える影響は全 API に及ぶ。エラーを受ける共通処理（401 で画面ごとログインへ移動、Sentry 送信）は QueryClient 側にある。
- [データを書き出す](journeys/data-export.md) の 6. 応答を受け取る — 全データを端末に残したくないなら、useQuery に meta: { persist: false } を付ける。応答の大きさは件数に比例する。Vercel の応答サイズの上限に当たるかは未確認。
- [AI クライアントから Plan を作る（MCP）](journeys/mcp.md) の 11. Dayopt の画面に現れる — すぐ反映したくなったら Realtime を足す判断になるが、infra.md は Realtime を現状の構成に含めていない。staleTime を短くすると全 query の取得回数が増える。

#### `apps/product/src/lib/turnstile/config.ts`

- [サインアップ → ウェルカムメール](journeys/signup.md) の 1. 登録フォーム — Turnstile の secret は app の env ではなく Supabase Auth の Bot Protection にある。site key と secret は別の場所で管理している。

#### `apps/product/src/proxy.ts`

- [ログイン（MFA 含む）](journeys/login.md) の 6. proxy がセッションを確認 — 保護する画面を足す時は access-policy の protectedProductPaths に入れる。入れ忘れると未ログインでも開ける。
- [パスワードを再設定する](journeys/password-reset.md) の 8. 他の端末を切る — 今の端末の session は残る。そのため 3 秒後の /auth/login への移動は、proxy が「サインイン済みで auth 系 path へ来た」と見て /calendar へ送り直すはず（コードから読んだ挙動。ブラウザでは未確認）。文言は「まもなくサインインページに移動します」。

#### `apps/product/vercel.json`

- [アカウントを削除する（不可逆）](journeys/account-deletion.md) の 11. 毎時の後始末 — 時間の予算は 50 秒（1 回あたり最大 5 件）。write fence 中は 503 で何もしない。本番では cron の heartbeat を監査し、最終完了から 180 分を超えると異常として扱う。
- [Google Calendar 連携](journeys/google-calendar.md) の 8. 15 分ごとの同期 cron — 取りこぼした回を埋め直さない。止まったことは heartbeat の完了時刻が古くなることで気づく（production の監査が見る）。
- [Pro を契約する（課金）](journeys/billing.md) の 11. 夜間の照合 — 直すのは人間。検出したら Stripe Dashboard から該当 event を再送する（runbook Playbook 3）。Stripe の env が全て無ければ configured: false で素通りし、一部だけなら 503 にする。

#### `apps/web/src/app/api/contact/contact-email.ts`

- [問い合わせを送る](journeys/contact.md) の 5. Resend へ送る — 件名は [Dayopt Contact][Product][カテゴリ] の固定形、tags の source は contact-product。後段の Resend webhook はこの source と宛先で問い合わせの配送だと判定するので、変えると配送失敗が Sentry に出なくなる。LP（apps/web）のフォームは別実装で、Idempotency-Key の名前空間を contact-web- に分けてある。

#### `packages/billing/src/subscription.ts`

- [Pro を契約する（課金）](journeys/billing.md) の 7. 契約状態を書く — 外部契約。Stripe の status の写し（mapStripeSubscriptionStatus）を変えると、active / trialing / past_due を「契約中」とみなす判定（isProSubscriptionStatus）と噛み合わなくなる。メール送信は失敗しても 200 を返す（throw すると Stripe が再送し、状態同期が揺れる）。durable 経路では未対応の event 種別を 500 にするので、Stripe Dashboard で購読 event を足すとそれが再送され続ける。

#### `packages/config/src/constants.ts`

- [問い合わせを送る](journeys/contact.md) の 6. Resend が受け付ける — 宛先は packages/config の supportEmail が正本。変えると Resend webhook の判定（宛先一致）も同時に変わる。

#### `scripts/ci/production-auth-config-audit.mjs`

- [パスワードを再設定する](journeys/password-reset.md) の 2. Auth が token を発行 — リンクの有効時間（mailer_otp_exp）や再送間隔は repo ではなく Supabase の Auth 設定が正本。production の値は Auth config audit が監視している（mailer_otp_exp は 3600 秒で固定）。
- [パスワードを再設定する](journeys/password-reset.md) の 6. 新しいパスワードを送る — エラー code の読み分けは ResetPasswordForm の RECOVERY_UPDATE_BLOCKED_CODES と isMfaBlocked。message の文字列で判定しない方針。
- [パスワードを再設定する](journeys/password-reset.md) の 10. （別入口）設定から変更 — production の require_current_password が off になると、current_password は黙って無視され、現在のパスワードを知らなくても変えられる。Auth config audit がこの値を固定している。他端末のサインアウトに失敗した時は、こちらは画面に警告を出す（リセット経路とは違う）。

#### `scripts/ci/production-cron-heartbeat-audit.mjs`

- [Google Calendar 連携](journeys/google-calendar.md) の 8. 15 分ごとの同期 cron — 取りこぼした回を埋め直さない。止まったことは heartbeat の完了時刻が古くなることで気づく（production の監査が見る）。

#### `scripts/ci/production-release.mjs`

- [merge → 本番公開](journeys/deploy.md) の 6. smoke → 公開 — 緊急時の Force Promote は理由の入力が必須。層 3 を飛ばすので、使ったら記録を残す。

#### `scripts/ci/release-impact.mjs`

- [merge → 本番公開](journeys/deploy.md) の 4. 影響判定 — 影響なしと判定された project の検証は走らない。docs だけの merge でも build は作られ、判定を通る。

#### `supabase/config.toml`

- [パスワードを再設定する](journeys/password-reset.md) の 2. Auth が token を発行 — リンクの有効時間（mailer_otp_exp）や再送間隔は repo ではなく Supabase の Auth 設定が正本。production の値は Auth config audit が監視している（mailer_otp_exp は 3600 秒で固定）。
- [パスワードを再設定する](journeys/password-reset.md) の 9. 変更通知メール — production で通知が有効かどうか（mailer_notifications_password_changed_enabled）は Auth config audit が監視する。リセットでも設定画面からの変更でも同じ通知が出る。
- [データを書き出す](journeys/data-export.md) の 5. 行を読む — PostgREST は 1 回の応答の行数に上限（max_rows）があり、超えた分は黙って切られる。local の設定は 1000。Plan / Record が多い利用者に効くので、直すなら collectQueryPages で読み切る。

#### `supabase/functions/send-auth-email/PasswordResetEmail.tsx`

- [パスワードを再設定する](journeys/password-reset.md) の 3. リセットメール送信 — この Function は Vercel ではなく Supabase にデプロイする（supabase functions deploy --use-api）。アプリの deploy では変わらない。メール本文の「24 時間」とリンクの実際の有効時間はここでは揃えていない（下の注意を参照）。

#### `supabase/functions/send-auth-email/confirm-url.ts`

- [パスワードを再設定する](journeys/password-reset.md) の 3. リセットメール送信 — この Function は Vercel ではなく Supabase にデプロイする（supabase functions deploy --use-api）。アプリの deploy では変わらない。メール本文の「24 時間」とリンクの実際の有効時間はここでは揃えていない（下の注意を参照）。

#### `supabase/functions/send-auth-email/index.ts`

- [サインアップ → ウェルカムメール](journeys/signup.md) の 3. 確認メール送信 — この Function は Vercel ではなく Supabase にデプロイされる（supabase functions deploy --use-api）。アプリの deploy とは別に動く。
- [パスワードを再設定する](journeys/password-reset.md) の 3. リセットメール送信 — この Function は Vercel ではなく Supabase にデプロイする（supabase functions deploy --use-api）。アプリの deploy では変わらない。メール本文の「24 時間」とリンクの実際の有効時間はここでは揃えていない（下の注意を参照）。

#### `supabase/functions/send-auth-email/password-changed-notification.ts`

- [パスワードを再設定する](journeys/password-reset.md) の 9. 変更通知メール — production で通知が有効かどうか（mailer_notifications_password_changed_enabled）は Auth config audit が監視する。リセットでも設定画面からの変更でも同じ通知が出る。

#### `supabase/functions/send-auth-email/subjects.ts`

- [パスワードを再設定する](journeys/password-reset.md) の 3. リセットメール送信 — この Function は Vercel ではなく Supabase にデプロイする（supabase functions deploy --use-api）。アプリの deploy では変わらない。メール本文の「24 時間」とリンクの実際の有効時間はここでは揃えていない（下の注意を参照）。

#### `supabase/migrations/20260708232500_add_time_model_tables.sql`

- [Plan / Record を動かす・直す](journeys/edit-timeblock.md) の 7. 版と規則を確かめる — 版の比較を緩めると、別の場所の変更を古い入力が潰す。規則を変える時は DB → service → UI の写しを 1 変更で全部変える。

#### `supabase/migrations/20260729062435_timeblock_atomic_commands.sql`

- [Plan / Record を動かす・直す](journeys/edit-timeblock.md) の 7. 版と規則を確かめる — 版の比較を緩めると、別の場所の変更を古い入力が潰す。規則を変える時は DB → service → UI の写しを 1 変更で全部変える。
- [Record を作る・Plan を記録する](journeys/record-plan.md) の 7. Plan を写して作る — Plan と Record を独立させた後（2026-09-07）の形。紐付けを戻す・写す項目を変える時は、MCP の records.create と日次確定（confirm_day）も同じ規則か確かめる。
- [削除と取り消し](journeys/delete-undo.md) の 5. deleted_at を付ける — deleted_at の付いた行は一覧・重なりの判定（排他制約は deleted_at IS NULL だけが対象）から外れる。削除済みの行を自動で物理削除する仕組みは見つからなかった（未確認）。
- [削除と取り消し](journeys/delete-undo.md) の 7. deleted_at を外す — Record の復元は DT005（未来に終われない）の対象外（時刻を変えないため trigger が見ない）。

#### `supabase/migrations/20260729073122_mcp_stage1_user_write_serialization.sql`

- [削除と取り消し](journeys/delete-undo.md) の 5. deleted_at を付ける — deleted_at の付いた行は一覧・重なりの判定（排他制約は deleted_at IS NULL だけが対象）から外れる。削除済みの行を自動で物理削除する仕組みは見つからなかった（未確認）。

#### `supabase/migrations/20260730090016_calendar_account_deletion_fence.sql`

- [アカウントを削除する（不可逆）](journeys/account-deletion.md) の 11. 毎時の後始末 — 時間の予算は 50 秒（1 回あたり最大 5 件）。write fence 中は 503 で何もしない。本番では cron の heartbeat を監査し、最終完了から 180 分を超えると異常として扱う。

#### `supabase/migrations/20260730090023_account_deletion_gate_foundation.sql`

- [アカウントを削除する（不可逆）](journeys/account-deletion.md) の 3. 経路を選ぶ — gate を有効にする migration は repo に無く、運用で切り替える前提。production で今どちらの経路が動いているかは未確認。旧経路は「古い instance が捌け切ったら消す」一時的な分岐。

#### `supabase/migrations/20260730090024_account_deletion_gate_commands.sql`

- [アカウントを削除する（不可逆）](journeys/account-deletion.md) の 4. 削除を開始（閉鎖へ） — DB の RPC は失敗 code が 40P01 / 55P03 / 57014（deadlock・lock 待ち・timeout）なら 3 回まで呼び直す。それでも取れなければ contention として利用者に押し直してもらう。
- [アカウントを削除する（不可逆）](journeys/account-deletion.md) の 5. Google の token を無効化 — Google Calendar を繋いでいない人は、この段は空で完了する。token の復号に失敗した時は Google を呼ばず not_attempted として記録する（Google 側では token の期限切れを待つことになる）。

#### `supabase/migrations/20260730090026_enforce_generic_account_deletion_gate.sql`

- [アカウントを削除する（不可逆）](journeys/account-deletion.md) の 8. 封をして本体を消す — auth.users から ON DELETE CASCADE で届かないテーブルは、ここでは消えない。email_suppressions は削除後も残す扱いで未裁定（invariants.md）。この trigger は gate が有効な時だけ働く。

#### `supabase/migrations/20260730090027_fence_account_storage.sql`

- [アカウントを削除する（不可逆）](journeys/account-deletion.md) の 6. ファイルを消す — 段の順番は DB が強制する（Calendar が済むまで Storage の claim は通らない）。bucket を増やしたら STORAGE_BUCKETS に足す。最後の auth.users 削除の trigger も bucket に残りが無いかを独立に確かめる。

#### `supabase/migrations/20260730090031_bind_billing_account_deletion.sql`

- [アカウントを削除する（不可逆）](journeys/account-deletion.md) の 4. 削除を開始（閉鎖へ） — DB の RPC は失敗 code が 40P01 / 55P03 / 57014（deadlock・lock 待ち・timeout）なら 3 回まで呼び直す。それでも取れなければ contention として利用者に押し直してもらう。

#### `supabase/migrations/20260730090300_revoke_authenticated_timeblock_dml.sql`

- [Plan を保存](journeys/save-plan.md) の 8. RPC で書き込む — service role は RLS を越える。テナント分離は「この adapter が必ず user_id を渡す」ことで守っている。ここへ command を足す時は REVIEW-1（ユーザー分離）の観点で読む。

#### `supabase/migrations/20260809015344_optimize_soft_delete_rls_initplan.sql`

- [データを書き出す](journeys/data-export.md) の 4. Service が 6 本読む — service role は RLS を越えるので、Plan / Record では .eq('user_id', userId) だけが他人のデータとの境界になる（REVIEW-1）。userId は必ず ctx から取り、入力で受けない。列は public-projections の select に限っているので、列を足す時はそこを変える。

#### `supabase/migrations/20260824090000_detach_tag_id_from_timeblock_write_path.sql`

- [Plan / Record を動かす・直す](journeys/edit-timeblock.md) の 7. 版と規則を確かめる — 版の比較を緩めると、別の場所の変更を古い入力が潰す。規則を変える時は DB → service → UI の写しを 1 変更で全部変える。

#### `supabase/migrations/20260904080216_simplify_timeblock_temporal_rules.sql`

- [Plan を保存](journeys/save-plan.md) の 9. 時刻の規則で検査 — 規則の正本はここ。変える時は DB → service → UI の写しを 1 変更で全部変える。DB だけ緩めて UI の写しが残ると「操作はできるのに保存されない」になる。
- [AI クライアントから Plan を作る（MCP）](journeys/mcp.md) の 9. 画面と同じ関数で書く — create_plan_command_v1 の規則を変えると、画面と MCP の両方が同時に変わる。MCP のエラーコード対応表（EXPECTED_ERROR_CODES）は画面側の表とは別にあるので、新しい SQLSTATE を足したら両方に足さないと MCP だけ MUTATION_FAILED になる。

#### `supabase/migrations/20260907081237_independent_plan_record_commands.sql`

- [Record を作る・Plan を記録する](journeys/record-plan.md) の 7. Plan を写して作る — Plan と Record を独立させた後（2026-09-07）の形。紐付けを戻す・写す項目を変える時は、MCP の records.create と日次確定（confirm_day）も同じ規則か確かめる。
- [削除と取り消し](journeys/delete-undo.md) の 7. deleted_at を外す — Record の復元は DT005（未来に終われない）の対象外（時刻を変えないため trigger が見ない）。

#### `supabase/migrations/20260908022927_add_mcp_billing_access_switch.sql`

- [AI クライアントから Plan を作る（MCP）](journeys/mcp.md) の 8. DB が書き込みを認可 — gate の開閉は SQL を直接書かず pnpm mcp:gate（revision 付きの service role 限定 RPC）で行う。Write Fence はこの gate に効かないので、障害時に MCP の書き込みを止めるには gate を別に閉じる。認可の条件を変える時は REVIEW-1（ユーザー分離）の観点で読む。

#### `supabase/migrations/20260914000000_version_mcp_create_digest.sql`

- [AI クライアントから Plan を作る（MCP）](journeys/mcp.md) の 9. 画面と同じ関数で書く — create_plan_command_v1 の規則を変えると、画面と MCP の両方が同時に変わる。MCP のエラーコード対応表（EXPECTED_ERROR_CODES）は画面側の表とは別にあるので、新しい SQLSTATE を足したら両方に足さないと MCP だけ MUTATION_FAILED になる。

<!-- learn:generated:end -->

## 正本

- [AGENTS.md](../../AGENTS.md) — 実装 plan の必須セクション（Reversibility Table ほか）、レビュー規則
- [docs/engineering/invariants.md](../engineering/invariants.md)
- [docs/engineering/architecture.md](../engineering/architecture.md) の Feature 間の依存

## 自分で確かめる問い

<details>
<summary>1. `useTimeblockWriteMutations.ts` の `onSettled` を変えたい。どこに響くか</summary>

下の一覧で、このファイルを参照する段を見る（Plan の保存・編集・削除など）。保存後に取り直す対象が変わるので、集計やレポートの数字が古いまま残らないかを確かめる。

</details>

<details>
<summary>2. `procedures.ts` の関門の順序を変えたい</summary>

全 tRPC に響く（UI と MCP の両方）。write fence を rate limit より先に見る理由（止めている間に枠を使い切らない）を壊さないか。Plan の保存と MCP の経路の関門の段を読む。

</details>

<details>
<summary>3. Plan の table に列を足す migration を書く。何を確かめるか</summary>

migration は merge の時点で本番に入り、古いコードがしばらく動く（[9. デプロイ](09-deployment.md)）。書き込みは command 関数を通るので関数も更新が要る。全データ削除・アカウント削除の対象になるかも確かめる（[3. DB / Auth / RLS](03-data-auth-rls.md)）。

</details>
