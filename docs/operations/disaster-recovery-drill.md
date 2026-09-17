---
status: current
last_verified: 2026-08-13
code:
  - supabase/config.toml
  - supabase/migrations
  - scripts/tasks/generate-rls-snapshot.ts
  - scripts/ci/storage-backup.sh
  - scripts/runbook/storage-restore.sh
  - docs/engineering/infra.md
---

# 復元演習（restore drill）手順書

**この文書は「演習のやり方」を持つ。事故が起きた時に読む復旧手順は [infra.md §災害復旧手順](../engineering/infra.md#災害復旧手順) が正本。**

3 つの文書の役割が紛らわしいので先に区別する。

| 文書                                                              | 何のため                                   | いつ読む             |
| ----------------------------------------------------------------- | ------------------------------------------ | -------------------- |
| [infra.md §DB Migration Rollback 手順書](../engineering/infra.md) | **判断の巻き戻し**（migration を戻す）     | 自分の変更が原因の時 |
| [infra.md §災害復旧手順](../engineering/infra.md)                 | **事故からの復旧**（データ消失・オペミス） | 障害対応中           |
| 本文書                                                            | **平時の演習**（復旧経路が本当に動くか）   | 演習日               |

テストしていないバックアップは「あるつもり」でしかない。この演習の目的は、復元が**できること**の確認ではなく、**どれだけ失われ、どれだけ時間がかかり、何が復元されないか**を数値と一覧で確定させることにある。

> **演習の完了は paid billing 有効化の前提条件**（epic [#1669](https://github.com/Dayopt/dayopt/issues/1669) のゲート）。課金を始めると、失うデータに他人のお金が乗る。

---

## 演習前に確定していないこと

**この手順書は演習前に書かれている。以下は未確認のまま残っており、Step 0 で確定させる。** 確認するまで、後続 Step の所要時間・可否は見積りでしかない。

| 未確認事項                                                       | なぜ未確認か                                                                                 | 確定させる場所    |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ----------------- |
| 現行プランと backup 種別（daily / PITR）、保持期間、直近成功時刻 | Management API の project endpoint は backup 情報を返さない（2026-08-12 実測）               | Dashboard（User） |
| daily backup が **logical / physical** のどちらか                | 方式によって復元経路が変わる。project 作成が 2025-12-23 と新しいため physical の可能性が高い | Dashboard（User） |
| `supabase branches create --with-data` が実在するか              | CLI reference には記載があるが Branching guide は「data-less」と書いており、公式内で矛盾     | `--help` の実出力 |
| pg_cron の `cron.job` が復元を跨いで残るか                       | 公式ドキュメントに記載が無い                                                                 | 演習中の実測      |
| production の cron job の実数                                    | baseline に「本番は Dashboard で設定」とあり、repo が正本でない                              | Step 0 で控える   |
| `auth` schema が復元対象に入るか（経路により異なる）             | 物理復元は cluster 単位なので入るはず。論理 dump は既定で除外                                | 演習中の実測      |
| production DB の実サイズ                                         | RTO はサイズにほぼ比例する                                                                   | Step 0 で計測     |
| **別 project へ復元した時に Vault の secrets が復号できるか**    | 暗号鍵は project 単位。復号できないと 9 件を手で再投入することになる                         | 演習中の実測      |

**空欄のまま infra.md へ数値を書かない。** 測っていない RTO / RPO を復旧手順書に書くのは、無いより危険（障害中にその数値を信じて判断される）。

---

## Step 0: 事前確認（User 操作。演習日の前に済ませる）

Main は Dashboard と課金設定に触れない。ここは User の一次情報。

### 0-1. Supabase Dashboard で確認する

Dashboard → Project `dayopt` → Settings / Database → Backups

- [ ] 現在のプラン（Free / Pro / Team）
- [ ] daily backup の**有無・保持日数・直近の成功時刻**
- [ ] backup 方式が **logical / physical** のどちらか（画面に "Restore" ボタンがあるか、CLI 手順へ誘導されるか）
- [ ] PITR が有効か無効か
- [ ] DB サイズ（Reports → Database、または `SELECT pg_size_pretty(pg_database_size(current_database()));`）
- [ ] **復元前の production の状態を控える**（復元後の比較対象がこれしかない）
  - `SELECT jobname, schedule, active FROM cron.job ORDER BY jobname;`
  - `plans` / `records` / `activities` / `categories` / `profiles` の行数と、各テーブルの最新 `created_at`

**Free プランなら backup は存在しない。** その場合この演習は「backup を作るところ」から始まる（`db dump` の定期実行 + 保管先の決定）。

### 0-2. PITR の費用と復旧可能範囲（判断は User）

| 項目             | daily backup     | PITR                                           |
| ---------------- | ---------------- | ---------------------------------------------- |
| 失う最大時間幅   | **最大 24 時間** | **約 2 分**（WAL の archive 間隔）             |
| 月額             | プランに含まれる | **$100（7 日）/ $200（14 日）/ $400（28 日）** |
| 併用             | —                | **有効化すると daily backup は停止する**       |
| spend cap の対象 | —                | **対象外**（上限で止まらない）                 |

出典は Supabase 公式の [Manage PITR usage](https://supabase.com/docs/guides/platform/manage-your-usage/point-in-time-recovery)。**価格は変動するので演習日に再確認する。**

判断材料は「24 時間分の予定・記録を失って許されるか」。課金開始前の現在は許容できる可能性があるが、**課金後は他人のお金が絡むため基準が変わる**。有効化するかは User の判断。

### 0-3. CLI の実挙動を確認する（Main が実行可）

```bash
supabase branches create --help
```

`--with-data` が存在するかを**実出力で**確認する。ドキュメントは信用しない（公式内で矛盾している）。

### 0-4. 必要な権限・準備物

| 要るもの                            | 誰が持つか | 用途                                                                                                      |
| ----------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------- |
| Supabase Dashboard のログイン       | User       | backup 状態確認、restore 実行                                                                             |
| Supabase 組織の課金設定へのアクセス | User       | PITR 有効化の判断・実行                                                                                   |
| production の DB 接続情報           | User       | 案γ で dump を取る時だけ                                                                                  |
| 1Password `human`                   | User       | 上記 credential の取り出し                                                                                |
| `supabase` CLI（ログイン済み）      | 共通       | dump / branches / functions                                                                               |
| `rclone`（brew 等でローカル導入）   | 共通       | Storage オブジェクトの搬出・復元（`scripts/ci/storage-backup.sh` / `scripts/runbook/storage-restore.sh`） |
| Stripe Dashboard（**test mode**）   | User       | 復元後の billing 確認                                                                                     |

### 0-5. Cloudflare DNS レコードの控え（Supabase 復元とは独立、推奨）

`dayopt.app` の DNS ゾーン（Cloudflare が権威。[infra.md §DNS 管理](../engineering/infra.md#dns-管理cloudflare)）は Supabase の backup 対象に含まれない別リソースで、**失うと復元手段が無い**。**pg_cron の控え（0-1）と同格の扱いとして**、演習日に合わせて次を行う。

- [ ] Cloudflare dashboard → `dayopt.app` → DNS → Export（BIND 形式）で全レコードを export する、または API（`GET /zones/{zone_id}/dns_records`）で取得する
- [ ] export ファイルを演習記録と同じ場所に保管する（値は非公開情報ではないが、共有ディレクトリへの放置は避ける）

Supabase 復元の成否には影響しないため、Step 1 / Step 2 の RTO 計測には含めない。

---

## 演習対象の選択

**production を復元対象にしない。** 復元先は必ず branch / 新規 project / local のいずれか。

| 案                             | 復元先         | 費用 | 何を証明するか                                       | 未解決リスク                                                                                                                                                         |
| ------------------------------ | -------------- | ---- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **α** branch へ複製            | preview branch | 低   | branch 経路                                          | `--with-data` の実在が未確認。加えて 2026-08-11 に作った branch は 2 本とも `MIGRATIONS_FAILED`（[#1461](https://github.com/Dayopt/dayopt/issues/1461)、原因未特定） |
| **β** backup を新規 project へ | 新規 project   | 中   | **実際の DR 経路**。データが Supabase 境界内に留まる | project 作成が要る。physical backup だと Dashboard restore が使えない可能性                                                                                          |
| **γ** 論理 dump を local へ    | local Postgres | ゼロ | 論理復元の手順が通ること                             | 実データを落とすと**顧客 PII のローカル複製**が発生する                                                                                                              |

### 推奨

**γ を synthetic データで先に通し（= dry run）、その後 β を本番経路の証明として 1 回実行する。**

- α は前提が 2 つとも壊れている（`--with-data` 未確認 + branch が migration に失敗する既知不具合）ので**初回演習では採らない**。#1461 が解決したら再評価する
- γ を**実データで**回すのは既定で採らない。production から取るのは schema と roles だけで、データ本体は復元先で seed から作る（Step 1-1 / 1-2）。実データ複製が要ると判断した場合は User の明示判断とし、演習後に dump ファイルと復元先 DB を削除するところまで手順に含める
- β は「本当に戻せるか」を答える唯一の案なので、**最終的に 1 回は通す**

---

## Step 1: dry run（案γ / synthetic データ / ゼロコスト）

目的は**手順を枯らすこと**。ここで詰まった箇所は Step 2 でも詰まる。

### 1-1. 論理 dump を取る（**既定では production のデータを取らない**）

`supabase db dump` は既定で **schema のみ**、かつ `auth` / `storage` / extension 由来 schema を**除外**する。完全な論理バックアップは 3 本に分かれるが、**dry run で production から取るのは roles と schema の 2 本だけ**にする。

```bash
# production から取ってよいのはこの 2 本だけ（データを含まない）
supabase db dump --db-url "$PROD_DB_URL" --role-only -f roles.sql
supabase db dump --db-url "$PROD_DB_URL" -f schema.sql
```

データ本体は **local の seed から作る**（後述 1-2）。production の `--data-only` は `plans` / `records` / `profiles` を平文の SQL としてローカルへ落とすため、**実行した時点で顧客 PII のローカル複製が成立する**。

<details>
<summary><strong>実データで回す必要が出た場合（User の明示判断が要る）</strong></summary>

RTO はデータ量にほぼ比例するため、synthetic では所要時間が実態とずれる。実測が要ると判断した場合だけ、次を**セットで**満たす。

```bash
supabase db dump --db-url "$PROD_DB_URL" --data-only --use-copy -f data.sql
```

- [ ] User の明示判断を得た（「PII をローカルへ複製してよい」）
- [ ] 保存先を決めた（暗号化されたディスク上。共有ディレクトリ・クラウド同期フォルダに置かない）
- [ ] 演習終了後に `data.sql` と復元先 DB を**削除した**ことを確認した
- [ ] 実測記録へ「実データを使った」と残した

これを満たせないなら synthetic で回し、RTO は「データ量に比例して伸びる」と注記して残す。

</details>

> **credential を標準出力へ出さない。** 接続文字列は環境変数へ直接読み込み、値を echo しない。Management API / CLI の出力を見る時は [secrets.md §API 経由の設定読戻し](./secrets.md) の **allowlist 射影**に従う。denylist（危なそうな名前を隠す）方式は 2026-08-11 に実際に破綻している（判定語が `password` で実キー名が `db_pass` だった）。`supabase branches get` は credential を JSON で返す command なので、状態確認には `branches list` を使う。

### 1-2. 復元先を用意する（**`pnpm db:reset` は使わない**）

`pnpm db:reset` は `supabase db reset --local` で、`config.toml` の `[db.migrations] enabled = true` と `[db.seed] enabled = true` により **migration と seed を適用した状態**を作る。ここへ `schema.sql` を流すと既存 object の再作成で失敗し、`data.sql` を入れれば seed と主キーが衝突する。**復元先は空でなければならない。**

```bash
# local Supabase は起動しておく（Postgres だけ使う）
createdb -h 127.0.0.1 -p 54322 -U postgres restore_drill

DRILL_URL="postgresql://postgres:postgres@127.0.0.1:54322/restore_drill"
psql -v ON_ERROR_STOP=1 -d "$DRILL_URL" -f roles.sql     # role は cluster 共有。既存なら skip されうる
psql -v ON_ERROR_STOP=1 -d "$DRILL_URL" -f schema.sql
```

`ON_ERROR_STOP=1` を必ず付ける。付けないと途中のエラーを無視して進み、**壊れた復元を「成功」と誤認する**。

synthetic データは、この復元先に対して `supabase/seed.sql` と手動作成のテストユーザーで作る。**演習後に `dropdb` する。**

### 1-3. 観測ポイント（Step 2 でも同じものを見る）

各項目の**所要時間も測る**。合計が RTO の下限になる。

---

## Step 2: 本番経路の演習（案β）

1. Step 0 で確認した backup（daily / PITR）から**新規 project へ** restore する
2. 復元完了時刻を記録する
3. 下記チェックリストを上から実行する
4. 確認が終わったら**新規 project を削除する**（費用を止める）

**production の restore ボタンは押さない。** in-place restore は破壊的で、実行中プロジェクトは停止する。

**production の pg_cron は止めない。** [infra.md §復元前に止めるもの](../engineering/infra.md#復元前に止めるもの) は**実際の障害時**に production を復元する場合の手順で、演習では production に触れない。演習中に止めてよいのは復元先だけ。

---

## 復元後チェックリスト

復元先で上から実行する。1 つでも落ちたら、その時点の状態を記録してから次へ進む（止めない — 何が落ちるかの一覧を作るのが目的）。

### データ

- [ ] `plans` / `records` / `activities` / `categories` / `profiles` の行数が Step 0 で控えた値と一致する
- [ ] `mcp_mutation_receipts` / `oauth_connections` など MCP 系テーブルが揃っている

**RPO は最新 `created_at` では測れない。** backup 以降に「更新・削除しかなかった」場合、最新 `created_at` は一致するのに変更は失われている。逆に新規作成が長期間なければ、損失ゼロでも大きな RPO を算出してしまう。**sentinel を使う。**

- [ ] backup 取得時刻の**前後に** sentinel 行（既知の内容の Plan など）を作っておき、復元先にどちらが存在するかで境界を挟む
- [ ] あわせて `updated_at` を持つ既知の更新系列と、backup の recovery timestamp を突き合わせる
- [ ] 算出した RPO と、その根拠（どの sentinel が残り／消えたか）を記録する

### 権限（機械判定できる）

```bash
# 復元先を指して check だけを走らせる。exit 0 が合格
DATABASE_URL="$DRILL_URL" pnpm rls:snapshot:check
```

> **`pnpm rls:snapshot`（`--check` なし）を先に実行しない。** `scripts/tasks/generate-rls-snapshot.ts` は checked-in の `rls-snapshot.md` を**上書きする**ため、その直後の `:check` は自分が今書いた内容と比較して必ず一致する。backup から policy や GRANT が欠落していても合格になり、**演習の権限検証がまるごと無意味になる**。比較対象は常に main の golden snapshot に保つ。

期待値は [rls-snapshot.md](../engineering/data/db/rls-snapshot.md) の現行値（policy 43 / RLS 有効テーブル 20 / GRANT 215 / storage policy 8 / Realtime publication 0）。**演習日に本番側の数値を取り直してから比較する**（この数値は 2026-08-12 時点）。

- [ ] `authenticated` に余分な権限が復活していない

### RPC

- [ ] `confirm_day_plans_to_records`
- [ ] `soft_delete_record` / `restore_record`
- [ ] `revoke_oauth_connection`
- [ ] `SECURITY DEFINER` と `search_path` の設定が保たれている

### Realtime

```sql
SELECT schemaname, tablename FROM pg_publication_tables WHERE pubname = 'supabase_realtime';
```

- [ ] **0 行が期待値**（Dayopt は Realtime を使っていない）。行が増えていたら復元先の設定ミス

### pg_cron（**未確認事項。ここで答えを出す**）

```sql
SELECT jobname, schedule, active FROM cron.job ORDER BY jobname;
```

**repo は production の cron job の正本ではない。** baseline migration に「本番は Dashboard で設定」と明記されており（`supabase/migrations/00000000000000_baseline.sql:1298`）、migration に現れない手動 schedule が production に存在しうる。

- [ ] **復元する前に production 側の `cron.job` を控える**（これをやらないと比較対象が無い）
- [ ] 復元後の job 一覧が、控えた production 側と一致するか記録する
- [ ] repo の migration から導ける active job は **5 本**（`cleanup-product-events` / `expire-calendar-revoke-outbox` / `cleanup-calendar-authority-retention` / `expire-calendar-revoke-authority` / `finalize-calendar-revoke-guards`）。baseline の 4 本はいずれも後続 migration で unschedule 済み。**production の実数がこれと違っても異常ではない** — Dashboard 設定分の差なので、その差自体を記録する
- [ ] 残っていない場合、再作成の手順を本文書へ追記する

### Auth

- [ ] `auth.users` の件数が一致する（**経路依存**: 物理復元は cluster 単位なので入るはず、論理 dump は既定で除外）
- [ ] ログインが実際に通る

#### Auth Hook（**別 project へ復元すると失われる。project 単位の GoTrue 設定**）

DB 内の hook function が戻っても、**GoTrue 側の hook 登録は引き継がれない**。`config.toml` は 2 つの hook を定義している。

- [ ] `[auth.hook.send_email]` を再登録する（URI + 署名 secret）。落ちていると**認証メールが 1 通も送れない**
- [ ] `[auth.hook.custom_access_token]`（`pg-functions://postgres/public/custom_access_token_hook`）を再登録する。落ちていると **JWT に `subscription_status` が乗らず有料機能が壊れる**
- [ ] `send-auth-email` の `verify_jwt = false` が保たれている（`true` だと入口で弾かれる）
- [ ] **実際にサインアップ／パスワード再設定のメールが届くところまで確認する**（設定の見た目だけで判定しない）

### Edge Functions（**復元対象外。手動で戻す**）

- [ ] `send-auth-email` を再デプロイする（`--use-api` 必須）
- [ ] **secrets を再投入する。** コードの再デプロイでは戻らない（`RESEND_API_KEY` / `SEND_EMAIL_HOOK_SECRET` 等）。新規 project へ復元した場合は確実に空
- [ ] 再デプロイ後に**実際に認証メールが 1 通届く**ことを確認する（secrets 未投入だと、デプロイは成功するのにメールだけが送れない）

**正本は `supabase/functions/` と `supabase/config.toml` の `[functions.*]` 宣言。** 現在の実体は `send-auth-email` の 1 本だけ。

### Storage（**どの backup にも入らない**）

- [ ] `avatars` / `attachments` バケットが存在する（バケット定義は migration に入っているので schema と一緒に戻る）
- [ ] **オブジェクト本体は空**であることを確認する。これは異常ではなく仕様

> **実運用化・実復元演習ともに完了（2026-08-20、[#2026](https://github.com/Dayopt/dayopt/issues/2026)）。** `scripts/ci/storage-backup.sh` / `scripts/runbook/storage-restore.sh`（rclone ベース、`avatars` / `attachments` の両バケット対応）は 2026-08-13 にローカル Supabase Storage 相手の実 sync + copy で byte-identical な復元を確認済み（[#1972](https://github.com/Dayopt/dayopt/issues/1972)）。日次搬出を実行する [`nightly.yml`](../../.github/workflows/nightly.yml) の storage-backup-export job（[#2147](https://github.com/Dayopt/dayopt/issues/2147)。#2483 で `storage-backup-export.yml` から統合）は destination を Cloudflare R2（bucket `avatars` / `attachments`、Bucket Locks 35 日 retention）へ確定し、2026-08-18 に初回搬出（実 run）を完走した。以後は日次 cron（07:00 JST）が差分同期する。
>
> 2026-08-20、R2 backup からの実復元演習を実施（決定ログ（削除済み、git 履歴参照））。dry-run → 実復元（ローカルディレクトリ、production への書き戻しなし）で 2 オブジェクト・85.150 KiB を復元し、初回搬出時の実測と件数・サイズが完全一致することを確認した。RTO 実測は認証込みで約 2 分。
>
> **これにより production の `avatars` / `attachments` には実運用の復元元が存在する。** paid billing のゲート条件（[#1669](https://github.com/Dayopt/dayopt/issues/1669)）は技術面では満たされたが、有効化そのものの実行判断は別途 `EXPLICIT AUTHORITY` として User の明示裁可を要する。

### Vault / 秘密情報（**案β で最も壊れやすい箇所**）

`vault.secrets` には production の要である 7 件が入っている（`stripe_secret_key` / `stripe_webhook_secret` / `resend_api_key` / `resend_webhook_secret` / `cron_secret` / `recovery_code_pepper` / `anthropic_api_key`）。**暗号鍵は project 単位で管理されるため、案β（別 project への復元）では復号できない可能性が高い。**

`service_role_key` / `supabase_url` の 2 件は `20260917050000_drop_vault_edge_invoke.sql`（[#2733](https://github.com/Dayopt/dayopt/issues/2733)）で撤去した。読んでいたのが撤去済みの `invoke_edge_function` だけだったため、復元対象ではない。

- [ ] `vault.secrets` の**値が実際に復号できるか**確認する（行の存在確認だけでは不十分）
- [ ] `PLACEHOLDER_REPLACE_ME` のままの行が無いか確認する（migration の seed 値）
- [ ] **復号できなかった場合**: 1Password から再投入する。手順は `20260319000002_vault_seed_secrets.sql` の冒頭コメント（Dashboard の SQL Editor で `UPDATE vault.secrets SET secret = '<値>' WHERE name = '<名前>'`）。**値を標準出力・セッションへ表示しない**
- [ ] 復号可否と、再投入が要ったかどうかを実測記録へ残す（この結果次第で「復元されないもの」の表が変わる）

### 課金（Stripe / **test mode で行う**）

- [ ] `profiles.stripe_customer_id` / `subscription_status` / `subscription_id` が保たれている
- [ ] `stripe_webhook_events` の履歴が残っている
- [ ] Stripe test mode で checkout 相当のデータを作り、復元後の DB に対して **webhook resend** が通る
- [ ] **test / production mode を取り違えない**

### アプリ主要フロー

復元先を向いたアプリを起動して実行する。

- [ ] `/api/health` が 200 を返す
- [ ] ログイン → 予定作成 → 記録確定
- [ ] Calendar / Review / Account / Billing の各画面が表示される

---

## 復元されないもの（確定リスト）

演習で覆るまで、**以下は「戻らない」前提で運用する**。

| 対象                              | 状態                                                          | 戻し方                                    |
| --------------------------------- | ------------------------------------------------------------- | ----------------------------------------- |
| **Storage オブジェクト**          | どの DB backup にも入らない                                   | S3 互換経由で別途搬出・復元               |
| **Edge Functions とその secrets** | 復元対象外。コードを戻しても secrets は戻らない               | `--use-api` で再デプロイ + secrets 再投入 |
| **Vault の secrets**              | 別 project へ復元すると復号できない可能性が高い（演習で確定） | 1Password から再投入                      |
| **Realtime publication**          | 別 project へ復元した場合は再有効化が必要                     | 現状は空なので影響なし                    |
| **extension の有効化**            | 別 project へ復元した場合は再有効化が必要                     | 演習で実測する                            |

custom role の password も backup に含まれないが、**現状 Dayopt に custom role は無い**（migration に `CREATE ROLE` / `CREATE USER` が 0 件）。追加したらこの表に足す。

---

## 実測記録（演習日に埋める）

**空欄のまま infra.md へ転記しない。**

```yaml
drill_date: 'YYYY-MM-DD'
target: 'α branch | β new project | γ local'
source_backup: 'daily YYYY-MM-DDTHH:MM:SSZ | PITR <timestamp>'
backup_kind: 'logical | physical'
db_size: '<GB>'
rto_measured: '<復元開始から主要フロー通過までの実時間>'
rpo_measured: '<失われた最大時間幅>'
storage_objects_restored: false
edge_functions_redeployed: ['send-auth-email']
cron_jobs_before: '<復元前に控えた production の job 数と名前>'
cron_jobs_after: '<復元後の job 数と名前>'
auth_users_restored: '<yes|no>'
vault_secrets_decryptable: '<yes|no>'
vault_secrets_reinjected: '<yes|no>'
edge_function_secrets_reinjected: '<yes|no>'
failures: []
operator: '<name>'
```

---

## 中止条件

次のいずれかで演習を止め、状態を記録する。

- 復元先が production project になっている（**即座に中止**）
- credential が標準出力・ログ・Issue・PR のいずれかへ出た（[secrets.md](./secrets.md) の対応へ）
- 案γ で実データの dump ファイルが意図せず作られた（削除まで実施）
- Stripe を production mode で操作していた
- 復元先の DB が production を向いた状態でアプリを起動した

---

## 演習後にやること

1. **実測値を [infra.md §災害復旧手順](../engineering/infra.md#災害復旧手順) へ反映する**（RTO / RPO / 復元されないもの）
2. 記録を GitHub issue として起票する（2026-08-28、#2475 で domain log/ 廃止に伴い移行）
3. 本文書の「演習前に確定していないこと」の表を、**確定した事実で置き換える**
4. 新規 project / branch / dump ファイルを削除する
5. [#1879](https://github.com/Dayopt/dayopt/issues/1879) を閉じ、epic [#1669](https://github.com/Dayopt/dayopt/issues/1669) のゲート充足を報告する

## 演習の頻度

Supabase 公式に DR 演習のガイダンスは無い。自前で決める。

**初回は課金開始前に 1 回。以後は年 1 回、および DB schema の大規模変更後。** 頻度を上げるより、1 回を実測付きで通す方が価値がある。
