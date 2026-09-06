---
status: current
last_verified: 2026-08-10
---

# Runbook（障害対応・リリース手順）

インシデント対応プレイブックとリリース作業手順（チェックリスト・詳細プロセス・バージョニング・リリースノートテンプレート）を集約する。障害対応は「パニックしない、チェックリストに従う」、リリースは「上から順に確認する」運用を前提にする。

---

# 第1部: インシデント対応プレイブック

> **パニックしない。チェックリストに従う。**
> 一人で全部やる必要はない。まず影響を止めて、それから原因を探す。

**Sentryアラート設定 / Sentry統合ガイド / パフォーマンス監視**: [monitoring.md](./monitoring.md)

## インシデントレベル定義

| レベル | 定義                              | 対応目標  | 例                        |
| ------ | --------------------------------- | --------- | ------------------------- |
| **P0** | サービス全停止 / セキュリティ侵害 | 即時対応  | DB障害、不正アクセス      |
| **P1** | 主要機能が使えない                | 1時間以内 | デプロイ失敗、Webhook停止 |
| **P2** | 一部機能に影響                    | 4時間以内 | Sentryエラー急増          |
| **P3** | 軽微な不具合                      | 翌営業日  | UIの表示崩れ              |

## 共通初動チェックリスト

すべてのインシデントで最初にやること:

- [ ] `/api/health` のレスポンス確認（200 / 503 / タイムアウト）
- [ ] Sentry Issues を開き、直近のエラー急増を確認
- [ ] 直近のデプロイ有無を確認（Vercel Dashboard / `git log --oneline -5`）
- [ ] 影響範囲を判断 → P0/P1なら次の「メンテナンスモード判断」へ

**iCal feed（`/api/v1/calendar/[token]`）の503急増は、Upstash未設定/障害時にproductionでfail-closed（service-role DB保護のため）になる既知挙動**。IP/global集約rate limit層はfail-closedで503を返す一方、per-token層のみin-memory fallback（fail-open）を持つため、Upstash障害時は全購読者が一時的に503になる。Sentryで`operation: check_ip_rate_limit` / `check_global_rate_limit`、`source: upstash`のcaptureが同時多発していればこのケース。復旧はUpstash側の障害解消を待つ（アプリ側の対処は不要）。

### メンテナンスモード有効化

P0またはP1で復旧に時間がかかる場合:

```bash
# Vercel環境変数を設定（即時反映）
# Vercel Dashboard → Settings → Environment Variables
NEXT_PUBLIC_MAINTENANCE_MODE=true
```

- `src/proxy.ts` がフラグを検知し、全リクエストを `/maintenance` にリダイレクト
- `/maintenance` は静的HTML（503 + Retry-After: 3600）を返す
- 復旧後は `NEXT_PUBLIC_MAINTENANCE_MODE=false` に戻す（または削除）
- **⚠ これは画面遷移だけを止める。API 層（tRPC mutation / webhook）の書き込みは止まらない。** 復元前に書き込みを止めるには次の Write Fence を使う

### Write Fence 有効化（API層の書き込み停止）

策定日: 2026-08-13（[#1972](https://github.com/Dayopt/dayopt/issues/1972)）

backup からの復元前など、**API 層の書き込みを止める**必要がある時に使う。読み取りは通したまま書き込みだけ止められる（全停止より影響が小さい）。

#### どこに効くか

| 対象                                                                                                                  | 効くか                  | 影響                                                                                                                                              |
| --------------------------------------------------------------------------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| tRPC mutation（全て）                                                                                                 | 効く                    | `SERVICE_UNAVAILABLE`（503）                                                                                                                      |
| Stripe / Resend webhook                                                                                               | 効く                    | 503 + `Retry-After: 30`。再送で拾われる                                                                                                           |
| `/api/cron/calendar-sync`、`/api/cron/external-connection-maintenance`、`/api/cron/calendar-account-deletion-settle`  | 効く                    | 503（cron は次回実行を待つ）                                                                                                                      |
| `/api/oauth/token`                                                                                                    | 効く                    | 503（`temporarily_unavailable`）                                                                                                                  |
| `/api/integrations/google-calendar/callback`                                                                          | 効く                    | 接続作成前に拒否（Google の一度きりの認可 code を消費する前）                                                                                     |
| MFA リカバリーコード再生成（`recovery-code-actions.ts`）、OAuth consent（`oauth/consent/actions.ts`）の Server Action | 効く                    | 通常のエラー応答（`codes: null` / `temporarily_unavailable` redirect）                                                                            |
| **client 直叩きの Supabase Auth**（signUp / updateUser / resetPasswordForEmail、`useAuthStore.ts`）                   | **効かない**            | `auth.users` は直接更新される                                                                                                                     |
| **client 直叩きの Storage**（avatar アップロード/削除、`lib/supabase/storage.ts`）                                    | **効かない**            | Storage オブジェクトは直接更新される                                                                                                              |
| pg_cron                                                                                                               | **効かない**            | 別途 pg_cron を止める（下記）                                                                                                                     |
| MCP write gate（`mcp_mutation_control`）                                                                              | **効かない**（別 gate） | MCP 経由の書き込みは別途 toggle が必要                                                                                                            |
| **復元先が `write_fence_control` migration（2026-08-12）より前の snapshot**                                           | **効かない**            | relation 不在で fence が disabled 扱いになる（`write-fence.ts` の fail-open 例外）。メンテナンスモード + deployment 停止 + pg_cron 停止で代替する |

**「fence を上げれば全書き込みが止まる」わけではない。** 上表の「効かない」経路が残っている前提で復元判断をする。

#### 有効化

Supabase Dashboard → SQL Editor で実行（`service_role` にも UPDATE 権限は無い。postgres superuser のみ実行可能）:

```sql
UPDATE public.write_fence_control SET fence_enabled = true WHERE singleton_key = true;
```

- [ ] **UPDATE 後 10 秒待ってから次の手順（確認・復元）に進む**: allow 判定は in-process で最大 5 秒キャッシュされ、かつ Vercel の各 instance が個別にキャッシュを持つため、UPDATE 直後は instance ごとに最大 5 秒のずれで新しい値へ切り替わる。実行中リクエストの完走分も含め、10 秒を目安の下限にする
- [ ] **効いていることを目視で確認する**: production の任意の mutation を 1 回実行し（例: 自分のアカウントで tag を 1 件更新）、`SERVICE_UNAVAILABLE`（503）が返ることを確認する
- [ ] **drain を待つ**: tRPC route の `maxDuration=300s`、webhook の `maxDuration=30s` を上限に、これらの秒数だけ待てば有効化前に開始した書き込みは完了しているはず
- [ ] **pg_cron も別途止める**（上表のとおり fence は効かない）。手順は Playbook 1 ケースD参照

#### 解除

```sql
UPDATE public.write_fence_control SET fence_enabled = false WHERE singleton_key = true;
```

- [ ] メンテナンスモードも解除する（`NEXT_PUBLIC_MAINTENANCE_MODE=false`）
- [ ] pg_cron を再登録する（[infra.md §復旧後に戻すもの](../engineering/infra.md#復旧後に戻すもの)）
- [ ] **fence を再送窓を超えて上げていた場合**:
  - Stripe: Dashboard → Webhooks → 失敗イベントの「Resend」で手動再送する
  - Resend: **再送は自動（5s/5m/30m/2h/5h/10h/10h backoff）だが、失敗が続くと endpoint 自体が無効化されメール通知が届く。** Dashboard で endpoint が無効化されていないか確認し、必要なら再有効化する（無効化されたまま気づかないと、bounce/complaint の取り込みが恒久的に止まる）

### MCP write gate の開閉（`mcp_mutation_control`）

Write Fence とは別の gate。MCP 経由の書き込み（`plans.create` 等）だけを対象にする。停止・段階有効化の両方をこの節の手順で行う。詳細な契約は issue [#1754](https://github.com/Dayopt/dayopt/issues/1754) のコメント（step-6 系ドキュメント相当）が正本。

#### 現在の状態を見る（read-only）

```bash
op run -- pnpm mcp:gate
```

`SUPABASE_SERVICE_ROLE_KEY` / `NEXT_PUBLIC_SUPABASE_URL` は 1Password `app` item から `op run` が解決する。`writes_enabled` / `enabled_client_ids` / `revision` を表示するだけで、何も変更しない。

#### 1 client を有効化する（段階導入）

```bash
op run -- pnpm mcp:gate -- --enable-global      # global gate を ON
op run -- pnpm mcp:gate -- --enable-client=claude-ai   # 対象 client を allowlist へ
```

- `client_id` は `claude-ai` / `chatgpt` / `cursor` のいずれか
- Vercel の `MCP_WRITE_ENABLED_CLIENTS` にも同じ client_id を追加する（env gate と DB gate の両方が揃って初めて write scope が発行される）
- 既存 connection は `write_enabled_at` を持たないため、対象ユーザーは再接続（再 consent）が必要

#### 緊急停止（stop and roll forward、上から順に）

1. global gate を OFF にする: `op run -- pnpm mcp:gate -- --disable-global`
2. 対象 client を allowlist から外す: `op run -- pnpm mcp:gate -- --disable-client=<id>`
3. Vercel の `MCP_WRITE_ENABLED_CLIENTS` から対象 client を外す
4. 恒久停止が必要な connection は Settings（本人）または `revoke_oauth_connection` RPC（運用側）で個別 revoke し、同じ token family が復活しないことを確認する

`mcp_mutation_control` は revision を使った CAS 更新（`set_mcp_mutation_control_v1` / `set_mcp_client_write_control_v1`、いずれも `service_role` 限定の `SECURITY DEFINER` RPC）。直接 `UPDATE` できる GRANT はどのロールにも無い。`pnpm mcp:gate` が revision の読み直しと引数整形を行うため、SQL を手で書く必要はない。

### 重要ダッシュボードURL

| ダッシュボード  | URL                                             |
| --------------- | ----------------------------------------------- |
| Vercel          | https://vercel.com/dashboard                    |
| Sentry Product  | https://sentry.io（プロジェクト: `dayopt`）     |
| Sentry Web      | https://sentry.io（プロジェクト: `dayopt-web`） |
| Supabase        | https://supabase.com/dashboard                  |
| Stripe          | https://dashboard.stripe.com                    |
| Supabase Status | https://status.supabase.com                     |

## Playbook 1: Supabase障害（P0）

### 検知

- [ ] Sentry Product: `environment:production` でerror急増を確認し、`release`と許可済みの`feature` / `operation` / `route` / `source`で絞り込む
- [ ] production `/api/health` → 503 / `{ "status": "unhealthy" }`
- [ ] Vercel runtime log の `[health]` eventで `database: "error"`
- [ ] https://status.supabase.com に障害報告あり

### 初動

- [ ] Status Page確認 → Supabase側障害なら **ケースA** へ
- [ ] Status Page正常 → 環境変数チェック → **ケースB** or **ケースC** へ
- [ ] P0判断 → メンテナンスモード有効化を検討

### 復旧

#### ケースA: Supabase外部障害

- [ ] https://status.supabase.com を継続監視
- [ ] メンテナンスモード有効化
- [ ] Status Pageの復旧通知を待つ
- [ ] 復旧後: production `/api/health` が連続して `{ "status": "healthy" }` を返すことを確認
- [ ] メンテナンスモード解除

#### ケースB: 環境変数ミス

- [ ] Vercel Dashboard → Settings → Environment Variables を確認
- [ ] `NEXT_PUBLIC_SUPABASE_URL` と `NEXT_PUBLIC_SUPABASE_ANON_KEY` が設定済みか
- [ ] サーバー側: `SUPABASE_SERVICE_ROLE_KEY` が設定済みか
- [ ] 修正後: 再デプロイ（Vercel Dashboard → Deployments → Redeploy）

#### ケースC: Edge Functions障害

- [ ] Supabase Dashboard → Edge Functions → ログ確認
- [ ] 再デプロイ:

```bash
# IMPORTANT: --use-api 必須（この環境にDockerがない）
supabase functions deploy --use-api
```

- [ ] デプロイ後: Edge Functionsのログで正常動作を確認

#### ケースD: データ消失・DB破損（backup からの復元が要る）

**ケース A〜C はサービスが止まっているだけでデータは無事。データそのものが失われた場合はここへ来る。**

- [ ] **書き込みを止める**: メンテナンスモード（画面遷移）+ Write Fence（API層）の両方を有効化する（上記「Write Fence 有効化」参照）。**Write Fence が届かない経路（client 直叩き Auth/Storage、pg_cron、MCP gate）が残る**ことを自覚したうえで復元する（[infra.md §復元前に止めるもの](../engineering/infra.md#復元前に止めるもの)）
- [ ] **pg_cron も止める**（Write Fence は効かない。Postgres 内部で走るので app 側の操作では止まらない）

```sql
-- ① 先に控えて保存する（Dashboard 設定が正本で migration から戻せない）
SELECT jobid, jobname, schedule, command, active FROM cron.job ORDER BY jobname;
-- ② 控えてから止める
SELECT cron.unschedule(jobname) FROM cron.job WHERE active;
```

- [ ] 原因が自分の migration なら [infra.md §DB Migration Rollback 手順書](../engineering/infra.md#db-migration-rollback-手順書) へ
- [ ] データ消失・オペミスなら [infra.md §災害復旧手順](../engineering/infra.md#災害復旧手順) へ
- [ ] Supabase Dashboard → Database → Backups で **backup の存在と時刻を確認する**（「あるはず」で進めない）
- [ ] 復元しても **Storage オブジェクト・Edge Functions とその secrets・Vault の secrets・Auth Hook 登録は戻らない**（[infra.md §復元でも戻らないもの](../engineering/infra.md#復元でも戻らないもの)）
- [ ] **サービス再開前に、止めた pg_cron を再登録する**（[infra.md §復旧後に戻すもの](../engineering/infra.md#復旧後に戻すもの)）。戻し忘れると期限切れ revoke の処理などが恒久停止する

> **RTO / RPO は未実測**（復元演習が未実施）。復旧時間を約束できる状態にない。手順と確認観点は [復元演習手順書](./disaster-recovery-drill.md)。

### 振り返り

- [ ] 根本原因を記録
- [ ] 影響時間（検知〜復旧）を記録
- [ ] 再発防止策を検討（アラート閾値調整等）

## Playbook 2: Vercelデプロイ失敗（P1）

### 前提: mergeとProduction公開は分離されている

main へ merge しても Production domain は**直接**切り替わらない。Product / Web は Auto-assign Custom Production Domains を無効化してあり、merge が作るのは **domain 未割当の Production build（candidate）** だけである。merge は `Production Release` workflow を自動で起動し（2026-09-03 以降。それ以前は人が dispatch していた）、workflow は影響のある層 3（E2E / Web Build & E2E）を走らせ、**その merge の影響を受ける project**の candidate を READY まで待ち、smoke と Production Config Audit を通してから promote する。影響を受けない project は待たずに skip し、どの app にも影響しない merge は promote 0 件の success（`unaffected`）で終わる。判定仕様は [infra.md](../engineering/infra.md)。

このため「本番が新しくならない」ことは、それ自体では障害ではない。**現行 Production は既知の正常 deployment のまま応答し続けている**。復旧の緊急度は「本番が壊れたか」ではなく「本番が古いままか」で判断する。層 3 が赤い merge では promote が走らないので、その意味でも本番は無傷で残る。

**失敗はどう届くか**: promote は merge した本人の push で起動するため、run が失敗すると GitHub の
既定通知でその本人へ失敗メールが届く。加えて `Production Release` の commit status が main の
当該 commit へ failure で付く（commit 一覧・PR 画面で赤く見える）。専用の異常起票 job は持たない。

ただしこれは **Auto-assign Custom Production Domains を無効化した後**の話。無効化前は main merge が
そのまま公開されるため、release run が赤くても本番が無傷とは限らない。ケース0 へ進む前に、現在の
production deployment がどの SHA かを Vercel Dashboard で確認する（HTTP status だけでは判別できない）。

### 検知

- [ ] GitHub Actions で `Production Release` が failure
- [ ] Vercel Dashboardでビルド失敗通知
- [ ] 本番サイトが古いバージョンのまま（新機能が反映されない）

### 初動

- [ ] **本番が壊れている（rollback するかもしれない）なら、まず自動 promote を止める。** promote は main merge で自動起動するため、rollback しても**その後の無関係な merge が壊れたコードを本番へ戻す**（rollback 後の live は新しい merge の祖先なので、`production-release.mjs` の superseded 判定では止まらない。層 3 もその不具合を検出できない —— 検出できていれば本番に出ていない）。Actions → Production Release → "···" → **Disable workflow**。復旧 commit を merge するまで戻さない
- [ ] `gh run list --workflow=promote.yml --limit 3` で直近の release run を確認。**in_progress の run がある間は、手動の promote / rollback / alias 操作をしない**。release は single-writer 前提で、run 中の手動操作は run の観測・rollback と衝突する（[infra.md §release の並行性モデル](../engineering/infra.md#release-の並行性モデル)）。完了（または cancel の完了）を待ってから以降へ進む
- [ ] run summary で「どこで止まったか」を特定: candidate build / smoke / audit / promote
- [ ] 本番 domain が正常応答しているか確認

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://dayopt.app/
curl -s -o /dev/null -w "%{http_code}\n" https://app.dayopt.app/api/health
```

### 復旧

#### ケース0: candidate build / smoke / audit の失敗（promote 前）

promote は行われていないので、**Production domain は現行 SHA のまま無傷**。緊急操作は不要。

- [ ] run summary のエラーを確認し、原因に応じてケースA / B を実施
- [ ] **修正を main へ merge すれば release gate は自動で再実行される**（`promote.yml` は `push: main` で起動、2026-09-03）。workflow を Disable している場合は先に Enable へ戻す
- [ ] main HEAD をそのまま再試行するだけなら `gh workflow run promote.yml --ref main`。**`sha` input は廃止した**（2026-09-03）ので `-f sha=` は 422 で拒否される。対象は常にその run の commit で、古い SHA を本番へ戻すのは promote ではなく rollback（ケースC）
- [ ] smoke が Deployment Protection で止まった場合は、対象 project の Protection Bypass for Automation と repository secret（`VERCEL_AUTOMATION_BYPASS_PRODUCT` / `VERCEL_AUTOMATION_BYPASS_WEB`）を確認する
- [ ] run summary が `would go out without layer 3` で止まっている場合は manifest の `status: impact-mismatch`。production は触られていないので、ケース0-B の該当項目を見る（対処は rollback ではなく再 run）

#### ケース0-B: 片方だけ promote された（部分リリース）

**前提: Product / Web の live SHA が違うこと自体は異常ではない。** release は変更の影響を受ける project だけを promote するため（[infra.md](../engineering/infra.md)）、片方が数 commit 遅れているのは正常な定常状態。「揃っていない」ことを異常と判断しない。

異常なのは「この run が promote を始めて、途中で失敗した」状態。release workflow は promote 順を web → product に固定し、2 つ目が失敗した場合は 1 つ目を直前 deployment へ自動 rollback する。

- [ ] **run の `release-manifest-<attempt>` artifact を先に見る**（run の Artifacts、保持 90 日）。artifact 名は run attempt ごとに分かれる（re-run した run では複数残る。最新の attempt を見る）。project ごとに「今どの deployment / どの SHA を配信しているか」「この run が動かしたか（`observedAt`）」が入っている。ここが復旧判断の一次情報
- [ ] run log で `rolled back to <deployment id>` を確認する
- [ ] `MANUAL ROLLBACK REQUIRED` が出ている場合は自動 rollback も失敗している。メッセージ中の deployment id へ手動で戻す（ケースC の手順）
- [ ] **まず manifest の `status` を見る。** `settings-drift` なら production は正しい SHA を配信しており、失敗の理由は `autoAssignCustomDomains` の復元だけ。**deployment は戻さず**、Vercel Dashboard で該当 project の Auto-assign を無効へ戻す（放置すると次の merge が gate を迂回する）
- [ ] **`status: impact-mismatch` は promote が 0 件で production は無傷**（#2574）。層 3 の要否を決める impact job（run 開始時点の live SHA が基準）と、release の影響判定（promote 直前の live SHA が基準）は別時刻の基準を使うため、その間に Instant Rollback などで live が**後退**すると、層 3 を走らせていない project を promote しかける。それを検出して止めた状態。**deployment は戻さない。** 各 project の `affected`（release の判定）と `impactAffected`（impact の判定）の食い違いを見て、production が意図した deployment に落ち着いていることを確認してから `gh workflow run promote.yml --ref main` で **workflow 全体を** 再 run する（impact が現在の live を基準に再判定し、必要な層 3 が走る）。**「Re-run failed jobs」は使わない** —— 成功済みの impact job は再実行されず outputs がそのまま再利用されるため、古い verdict が戻ってきて同じ失敗を繰り返す。Actions UI から行うなら「Re-run all jobs」。**この状態は自己修復する** —— 次の merge でも同じ再判定が起きる
- [ ] `status: failed` の場合、`action: promoted` の project が手動 rollback の対象。戻し先は同じ entry の `previousDeploymentId`。**`null` の場合は run 開始時点で domain が未割当だった**ので戻し先が manifest に無い。Deployments 履歴から直前に production を配信していた正常な deployment を選ぶ
- [ ] `action: skipped` / `already-serving` の project はこの run が触っていない。**巻き添えで戻さない**
- [ ] `action: moved-externally` は「この run の promote 後に**別の誰か**が production を動かし、release がそれを尊重して手を引いた」状態。`deploymentId` は他者が置いた deployment。**戻さない。** その deployment が意図したものかを本人に確認する（多くは緊急 hotfix）
- [ ] `action: uncertified` は「この run が promote していないのに target が live」状態。待機中に Vercel の Auto-assign か他者の promote が先に live にし、その後 gate（smoke / audit）が落ちた場合に出る。**production は認証を通っていない build を配信している。** 自動 rollback の対象外なので、run summary のエラーを読んで戻すかどうかを判断する。戻す場合の先は `previousDeploymentId`。**これが `null` の時は run 開始時点から同じ deployment が live だった**（= 戻し先が manifest に無い）ので、Vercel Dashboard の Deployments 履歴から直前の正常な production deployment を選ぶ
- [ ] `action: unassigned` は「production domain にどの deployment も割り当たっていない」状態（= その domain は配信されていない）。**最優先で復旧する。** 割り当て直す先は `previousDeploymentId`（Vercel Dashboard → Deployments → その deployment の "..." → Promote to Production）。`deploymentId` は null なので判断には使えない。**`previousDeploymentId` も `null` の場合は run 開始時点から未割当だった**（= manifest に戻し先が無い）ので、Deployments 履歴から直前に production を配信していた正常な deployment を選ぶ。**この場合 domain は release とは無関係に落ちていた可能性が高い**ので、いつから未割当かを Vercel の activity log で確認する
- [ ] **手で Promote / Instant Rollback したら、その project の Auto-assign Custom Production Domains を無効へ戻す。** Vercel の promote は毎回この設定を有効化する（[vercel/vercel#15095](https://github.com/vercel/vercel/issues/15095)）。release script は自動で戻すが、手動操作の分は戻らない。放置すると**次の main merge が release gate を通らず直接公開される**。Settings → Git で確認する

#### ケースA: CI失敗（lint / typecheck）

- [ ] エラーメッセージを確認
- [ ] ローカルで再現:

```bash
npm run typecheck    # 型エラー
npm run lint         # lintエラー
npm run lint:boundaries  # feature境界違反
```

- [ ] 修正 → push → 自動デプロイ

#### ケースB: ビルドエラー

- [ ] Vercelビルドログでエラー箇所を特定
- [ ] よくある原因:
  - 環境変数の追加忘れ（`src/env.ts` の Zod バリデーション失敗）
  - 依存パッケージのバージョン不整合
  - Next.js App Router の規約違反
- [ ] `scripts/tasks/env/schema.ts` と Vercel 環境変数を照合（`pnpm replica:check`）
- [ ] 修正 → push → 自動デプロイ

#### ケースC: 緊急ロールバック（本番が壊れている場合）

promote 済みの deployment に問題があった場合だけ使う。

- [ ] Vercel Dashboard → Deployments
- [ ] 正常に動作していた直前のデプロイを見つける（release run summary の `previous` deployment id が最も確実）
- [ ] **"..." → "Instant Rollback"（または "Promote to Production"）** で2クリックロールバック
- [ ] CLI / REST API / Redeploy で新しいProduction buildを作らない
- [ ] **壊れている project だけを戻す。** Product / Web の SHA を揃えようとしない（release は影響を受ける project だけを進めるので、SHA が違うのは正常）。無関係な側を戻すと、検証済みの build を理由なく巻き戻すことになる
- [ ] ロールバック後: 本番サイトで動作確認。**両 domain を見る**（`dayopt.app` と `app.dayopt.app`）。web の signup CTA から product へ入れるかは片側だけ戻した時の典型的な壊れ方
- [ ] ロールバック後: **操作した project の Auto-assign Custom Production Domains を無効へ戻す**（Settings → Git）。Instant Rollback / Promote to Production はどちらもこの設定を有効化するため、戻さないと次の main merge が release gate を通らず直接公開される
- [ ] **`Production Release` workflow を Disable したままにする**（初動で止めていない場合はここで止める）。止めないと、次に誰かが無関係な PR を merge した時点で自動 promote が走り、rollback で外したはずのコードが本番へ戻る
- [ ] 落ち着いて原因調査 → 修正（revert でも fix でも良い）→ main へ merge → **workflow を Enable へ戻す** → その merge の run が promote するのを確認する

Vercel の rollback はビルド成果物だけを戻す。**DB migration と変更済み環境変数は戻らない**。migration を含むリリースでは、直前 deployment がそのまま動く後方互換期間（expand/contract）を事前に確保しておく。

通常のProduction公開は `main` merge → `Production Release` workflow（自動起動）の promote だけを使う。
`Instant Rollback` / `Promote to Production` は正常な既存deploymentへ戻す緊急操作で、新規buildの作成経路ではない。

#### ケースD: Force Promote（break-glass）

release gate 自体が壊れていて、かつ Production を今すぐ前進させる必要がある時だけ使う。smoke と Production Config Audit をスキップするため、通常運用では使わない。

```bash
gh workflow run promote.yml --ref main -f force=true -f reason="<なぜ gate を飛ばすか>"
```

対象は main HEAD（`sha` input は 2026-09-03 に廃止。`-f sha=` は 422 で拒否される）。`--ref main` 以外を指定しない —— 他の ref の script が Production 権限で動く（environment の deployment branch policy が拒否するが、二重防御として手順にも残す）。

force は層 3・smoke・Production Config Audit をすべて skip する。**層 3 が赤いだけなら force ではなく、原因を直して merge する**（merge が自動で promote を再試行する）。

- [ ] reason は必須。空だと workflow が停止する
- [ ] 実行後、GitHub issue として使用理由と結果を起票する（2026-08-28、#2475 で domain log/ 廃止に伴い移行）
- [ ] gate の障害そのものを issue 化して、break-glass を常用しない

### 振り返り

- [ ] pre-commitフック（typecheck/lint）がスキップされていなかったか
- [ ] `scripts/tasks/env/schema.ts` に新しい環境変数が追加されているか
- [ ] ビルドエラーの場合: ローカルで `npm run build` を実行してから push するフローに
- [ ] Force Promote を使った場合: gate 側の欠陥が issue 化されているか

## Playbook 3: Stripe Webhook停止（P1）

### 検知

- [ ] Stripe Dashboard → Webhooks → エンドポイントに失敗マーク
- [ ] Sentry: `tags.source:stripe_webhook` のエラー

### 初動

- [ ] Stripe Dashboard → Webhooks → エンドポイント詳細を開く
- [ ] 失敗イベントのHTTPステータスコードを確認:
  - **401** → 署名検証失敗 → **ケースA**
  - **500** → 処理エラー → **ケースB**
  - **Timeout** → `maxDuration=30` 超過 → **ケースB**
  - **503（`Retry-After: 30`）** → Write Fence が意図的に有効化されている可能性がある（上記「Write Fence 有効化」参照）。障害ではなく復元作業中の想定挙動なので、まず fence の状態を確認する

### 復旧

#### ケースA: STRIPE_WEBHOOK_SECRET 不一致

- [ ] Stripe Dashboard → Webhooks → エンドポイント → Signing secret をコピー
- [ ] Vercel Dashboard → Environment Variables → `STRIPE_WEBHOOK_SECRET` を更新
- [ ] 再デプロイ（Vercel Dashboard → Deployments → Redeploy）
- [ ] Stripe Dashboard → 失敗イベントの「Resend」で確認

#### ケースB: 処理エラー（500 / Timeout）

- [ ] Sentry → Issues → `tags.source:stripe_webhook` でフィルタ
- [ ] エラー詳細とスタックトレースを確認
- [ ] `src/app/api/webhooks/stripe/route.ts` のイベントハンドラを確認
- [ ] 処理対象イベント: `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_failed`
- [ ] 修正 → push → 自動デプロイ
- [ ] Stripe Dashboard → 失敗イベントの「Resend」

### 失敗イベントの再送

冪等性ガード実装済み（`stripe_webhook_events` テーブル、23505 unique_violation で重複スキップ）のため、安全に再送可能:

- [ ] Stripe Dashboard → Webhooks → 失敗イベント一覧
- [ ] 各イベントの「Resend」ボタンで再送
- [ ] 正常処理されたことをログで確認

### 振り返り

- [ ] 未処理のまま放置されたユーザーがいないか確認（Supabase → `subscriptions` テーブル）
- [ ] 全失敗イベントの再送が完了したか確認
- [ ] Webhook Secret のローテーション手順を確認

## Playbook 4: Sentryエラー急増（P2）

### 検知

- [ ] Sentryの高優先度Issue通知またはDashboardのerror増加を確認
- [ ] Product / Webのどちらのprojectか、environmentがproductionかを確認

### トリアージ

- [ ] release、first seen、last seen、event数、影響routeを確認
- [ ] stack traceが元のTypeScript行へ解決されているか確認
- [ ] trace IDが有効か確認し、同時刻のVercel function logと照合
- [ ] request body、cookie、authorization、email、user content、URL queryがeventに含まれていないことを確認

### 復旧

#### ケースA: リグレッション（直近デプロイが原因）

- [ ] `git log --oneline -10` で直近の変更を確認
- [ ] エラー発生時刻とデプロイ時刻が一致するか
- [ ] 一致 → Vercel Dashboard でロールバック（Playbook 2 ケースC参照）
- [ ] ロールバック後: Sentryでエラーが止まったか確認

#### ケースB: 外部サービス障害

- [ ] stack、operation、breadcrumbから外部サービス起因か確認
- [ ] 該当サービスのStatus Pageを確認
- [ ] 復旧を待機（メンテナンスモードは不要な場合が多い）
- [ ] 復旧後: Sentryでエラーが止まったか確認

#### ケースC: 未知のエラー

- [ ] Sentryでエラー詳細・スタックトレースを確認
- [ ] 影響ユーザー数を確認（Sentry → Issue → Users Affected）
- [ ] 影響が大きい場合: メンテナンスモード検討
- [ ] 原因調査 → 修正 → デプロイ

### Sentryクォータ保護

大量エラー時にクォータを消費しすぎないよう:

- [ ] accepted / discarded / filtered / rate-limitedの推移を確認
- [ ] spike protectionとinbound filterが有効か確認
- [ ] CSP急増時はdirectiveと正規化済みblocked URIを確認し、endpointの429発生も照合
- [ ] 緊急のsampling変更は対象projectと復旧値をincident logへ記録してから行う

### 振り返り

- [ ] エラーをResolve済みにする
- [ ] アラート閾値の調整が必要か検討
- [ ] リグレッションの場合: typecheck/lintで検知できなかった理由を調査

## Playbook 5: 不正アクセス検知（P0）

### 検知

- [ ] Sentry: `type:csp-violation` の急増
- [ ] Supabase Auth log / Upstash request metricsで認証失敗の連続を確認（Ratelimit Analyticsとraw identifier保存は無効）
- [ ] Supabase Dashboard → Authentication → Logs に不審なアクティビティ

### 初動: まず止める

- [ ] **即時**: メンテナンスモード有効化（`NEXT_PUBLIC_MAINTENANCE_MODE=true`）
- [ ] 影響範囲を把握:
  - [ ] Sentry → 影響ユーザーID一覧
  - [ ] Supabase → Auth Logs → 不審なIPアドレス / ユーザー
- [ ] 不審アカウントの無効化: Supabase Dashboard → Authentication → Users → Ban User

### 復旧

#### ケースA: CSP違反 / XSS疑い

- [ ] Sentry → CSP違反レポートの `blocked-uri` を確認
- [ ] 自サイトのスクリプトか、外部注入か判別
- [ ] 外部注入の場合:
  - [ ] `next.config.ts` のCSPヘッダーを確認・強化
  - [ ] 注入経路を特定（ユーザー入力のサニタイズ漏れ等）
  - [ ] 修正 → デプロイ
- [ ] ブラウザ拡張由来の誤検知の場合: アラート閾値調整のみ

#### ケースB: 認証バイパス

- [ ] Supabase Dashboard → Authentication → Logs
- [ ] 不正なセッション / トークンの有無を確認
- [ ] Supabase → SQL Editor:

```sql
-- 不審なセッションを確認
SELECT * FROM auth.sessions
WHERE created_at > NOW() - INTERVAL '24 hours'
ORDER BY created_at DESC;
```

- [ ] 不審なセッションを無効化
- [ ] RLSポリシーの確認（意図しないデータアクセスがないか）
- [ ] 修正 → デプロイ

#### ケースC: ブルートフォース

- [ ] Supabase Auth Logs → 同一IP / メールアドレスからの大量失敗
- [ ] Supabase Dashboard → Authentication → Rate Limits の確認
- [ ] 必要に応じてレート制限を強化
- [ ] メンテナンスモード解除

### 事後対応

- [ ] 影響ユーザーへの通知（該当する場合）
- [ ] 関連ログを保存（Sentry / Supabase / Vercel）
- [ ] セキュリティパッチの適用
- [ ] パスワードリセットの強制（認証侵害の場合）

## 事後レビュー

### ポストモーテムテンプレート

すべてのP0/P1インシデント後に記録する:

```markdown
## ポストモーテム: [インシデント名]

**日時**: YYYY-MM-DD HH:MM〜HH:MM（JST）
**レベル**: P0 / P1
**影響**: [影響ユーザー数 / 影響機能]

### タイムライン

| 時刻  | イベント                                 |
| ----- | ---------------------------------------- |
| HH:MM | 検知（Sentryアラート / 手動発見）        |
| HH:MM | 初動開始                                 |
| HH:MM | メンテナンスモード有効化（該当する場合） |
| HH:MM | 原因特定                                 |
| HH:MM | 修正デプロイ / ロールバック              |
| HH:MM | 復旧確認                                 |
| HH:MM | メンテナンスモード解除                   |

### 根本原因

[根本原因の説明]

### 再発防止策

- [ ] [アクション1]
- [ ] [アクション2]

### 学び

[このインシデントから得られた教訓]
```

### 月次メンテナンスチェックリスト

毎月1回、以下を確認:

- [ ] Sentry: 未解決Issueの棚卸し（Resolve / Ignore の判断）
- [ ] Sentry: アラート閾値の妥当性確認（誤検知が多すぎないか）
- [ ] Sentry: Rate Limits設定の確認
- [ ] Stripe: Webhookエンドポイントの成功率確認
- [ ] Supabase: Edge Functionsのエラーログ確認
- [ ] Vercel: ビルド時間のトレンド確認（異常な増加がないか）
- [ ] 環境変数: `scripts/tasks/env/schema.ts` と本番の差分確認（`pnpm 1password:check` / `pnpm replica:check`）
- [ ] 依存パッケージ: `npm audit` でセキュリティ脆弱性チェック

## インシデント対応 関連ドキュメント

- **監視・アラート**: [monitoring.md](./monitoring.md)
- **マイグレーションロールバック**: `docs/engineering/infra.md`
- **ヘルスチェック実装**: `src/app/api/health/route.ts`
- **Stripe Webhook実装**: `src/app/api/webhooks/stripe/route.ts`
- **Sentry runtime contract**: [monitoring.md](./monitoring.md)
- **メンテナンスページ**: `src/app/maintenance/route.ts`

---

# 第2部: リリースチェックリスト

このチェックリストは、**リリース作業時に必ず確認すべき項目**をまとめたものです。
リリースの度に、このセクションを開いて、上から順に確認してください。

## このドキュメントの使い方

1. **リリース作業開始前に、このセクションを必ず開く**
2. **上から順番に、各項目を確認する**
3. **全ての項目が✅になったら、次のステップに進む**
4. **問題があれば、必ず修正してからリリースする**

## Phase 0: リリース準備（featureブランチで実施）

### 0.1 バージョン番号の確認

- [ ] **リリースするバージョン番号を決定**
  - PATCH: バグ修正のみ（例: 0.16.0 → 0.16.1）
  - MINOR: 新機能追加（例: 0.16.0 → 0.17.0）
  - MAJOR: 破壊的変更（例: 0.16.0 → 1.0.0）

  ```bash
  # 今回のリリースバージョン（例）
  VERSION="0.17.0"
  ```

- [ ] **既存のリリースタグと重複していないことを確認**

  ```bash
  # 既存のリリースを確認
  gh release list

  # 確認: v${VERSION} が既に存在しないこと
  gh release view v${VERSION} 2>/dev/null && echo "❌ Already exists!" || echo "✅ OK"
  ```

### 0.2 package.json バージョン更新

- [ ] **リリース前の最後のPRにversion bumpを含める**

  ```bash
  npm version ${VERSION} --no-git-tag-version
  # → コミットに含める
  ```

  **ポイント**: タグ打ち前にmainのpackage.jsonが正しい状態になるため、リリース後の後片付けが不要。

### 0.3 コード品質の確認

- [ ] **Lintチェック**

  ```bash
  npm run lint
  ```

- [ ] **型チェック**

  ```bash
  npm run typecheck
  ```

- [ ] **テスト**

  ```bash
  npm run test:run
  ```

- [ ] **ビルド**
  ```bash
  npm run build
  ```

→ **PRをマージしてからPhase 1へ**

## Phase 1: タグ作成・リリース

### 1.1 mainブランチの最新を取得

- [ ] **mainブランチに切り替えて最新を取得**

  ```bash
  git checkout main
  git pull origin main
  ```

### 1.2 Production promote の完了を確認する

main merge が `promote.yml` を自動起動する（`push: main`、2026-09-03）。タグを打つ前に、その run が promote を終えたことを確認する。

- [ ] **merge が起動した `Production Release` が promote を終えている**

  ```bash
  gh run list --workflow=promote.yml --branch main --limit 3

  gh api "repos/Dayopt/dayopt/commits/$(git rev-parse HEAD)/status" \
    --jq '.statuses[] | select(.context == "Production Release") | .state'
  ```

`success` にならないうちはタグを打たない。

### 1.3 Gitタグの作成とプッシュ

promote の成功と Production の観察が終わってから、証跡としてタグを打つ。

- [ ] **Gitタグを作成してプッシュ**

  ```bash
  # タグを作成
  git tag v${VERSION}

  # タグをプッシュ
  git push origin v${VERSION}
  ```

タグ push により `create-release.yml` が自動実行され、GitHub Release を作成する（タグ SHA の `Production Release` status が `success` であることを確認してから作成する。この workflow はデプロイしない）。

- [ ] **GitHub Releaseが自動作成された**

  ```bash
  gh run list --workflow=create-release.yml --limit 1
  gh run watch
  gh release view v${VERSION}
  ```

## Phase 2: リリースノート反映

### 2.1 前回リリース以降の全PRを取得

- [ ] **全PRを取得**

  ```bash
  # 前回リリースのタグを確認
  git tag --sort=-creatordate | head -5

  # 前回リリース以降のPR一覧を取得
  gh pr list --state merged --base main --limit 100 --json number,title,mergedAt \
    | jq -r '.[] | select(.mergedAt > "YYYY-MM-DDT00:00:00Z") | "- [#\(.number)](https://github.com/Dayopt/dayopt/pull/\(.number)) - \(.title)"'
  ```

### 2.2 詳細なリリースノートを作成

- [ ] **このファイルの「第4部: リリースノート執筆規約」の構造とカテゴリ定義を参考にリリースノートを作成**
  - [ ] 前回リリース以降の**全てのPR**が含まれている
  - [ ] 各PRにリンクが付いている
  - [ ] 第4部の5カテゴリ（新機能・改善・バグ修正・破壊的変更・セキュリティ）に整理されている
  - [ ] **Full Changelogリンクが含まれている**
    ```markdown
    **Full Changelog**: https://github.com/Dayopt/dayopt/compare/v{前バージョン}...v{今回バージョン}
    ```
  - [ ] 破壊的変更・データモデル変更を明記
  - [ ] 削除されたコンポーネント/機能をリスト

### 2.3 GitHub Release に反映

- [ ] **リリースノートを GitHub Release に直接反映**

  ```bash
  # 一時ファイルにリリースノートを書き出してから反映
  gh release edit v${VERSION} --notes-file /tmp/release-notes-v${VERSION}.md
  ```

- [ ] **リリースページで確認**

  ```bash
  gh release view v${VERSION} --web
  ```

  - [ ] バージョン番号が正しい
  - [ ] リリースノートが正しく表示されている
  - [ ] Full Changelogリンクが機能している

## Phase 3: リリース後作業

### 3.1 デプロイ確認

- [ ] **本番環境で動作確認**
  - [ ] サイトが正常に表示される
  - [ ] 新機能が動作する
  - [ ] 既存機能が正常に動作する

### 3.2 監視・モニタリング

- [ ] **Sentryでエラー監視**
  - エラーが急増していないことを確認

### 3.3 OSSライセンス情報の更新

- [ ] **ライセンス情報を再生成**
  ```bash
  npm run generate-licenses
  ```
- [ ] **生成物をマーケティングサイト（web）に反映**
  - `public/legal/oss-credits.json` を web リポジトリへコピー

### 3.4 通知・関連Issue

- [ ] **関連Issueにコメント**
  ```bash
  gh issue comment {issue番号} \
    --body "Released in v${VERSION}: https://github.com/Dayopt/dayopt/releases/tag/v${VERSION}"
  ```

## よくある失敗と対策

### 失敗例1: 既存のリリースと重複するバージョンを作成

**対策**:

- ✅ Phase 0.1で既存リリースを確認
- ✅ `gh release view v${VERSION}` でチェック
- ✅ 既存バージョンが見つかった場合、必ず「v0.X.0じゃないですか？」と確認

### 失敗例2: リリースノートに一部のPRしか含まれていない

**対策**:

- ✅ 前回リリース以降の**全てのPR**を取得してから記載
- ✅ `gh pr list --state merged` コマンドで漏れなく取得

### 失敗例3: リリースノートが抽象的

**対策**:

- ✅ 各PRのコミットを取得して具体的な変更内容を記載
- ✅ 「第4部: リリースノートテンプレート」の構造を参考にする

### 失敗例4: version bump忘れ

**対策**:

- ✅ Phase 0.2でリリース前の最後のPRにversion bumpを含める
- ✅ タグ打ち前にmainのpackage.jsonが正しい状態になっていることを確認

---

# 第3部: リリースプロセス詳細

このパートは詳細な説明と背景情報を提供する。実作業では第2部のチェックリストを使用すること。

## 前提条件

### 必要なツール

```bash
# Node.js & npm
node --version  # v24
npm --version

# GitHub CLI
gh --version

op --version

# Git
git --version
```

### 権限

- リポジトリへのWrite権限
- GitHub Releaseの作成権限
- Vercelプロジェクトへのアクセス権

### ブランチ保護設定（推奨）

**GitHub公式推奨**: `main`ブランチへの直接プッシュを禁止し、必ずPRを経由する

```bash
# GitHub Settings → Branches → Branch protection rules
# または GitHub CLI で設定
gh api repos/:owner/:repo/branches/main/protection \
  --method PUT \
  --field required_status_checks[strict]=true \
  --field required_status_checks[contexts][]=lint \
  --field required_status_checks[contexts][]=typecheck \
  --field required_status_checks[contexts][]=unit-tests \
  --field required_status_checks[contexts][]=build \
  --field required_pull_request_reviews[required_approving_review_count]=1 \
  --field enforce_admins=false \
  --field restrictions=null
```

**推奨設定**:

- ✅ Require a pull request before merging
  - Require approvals: 1
- ✅ Require status checks to pass before merging
  - Require branches to be up to date before merging
  - Status checks: `lint`, `typecheck`, `unit-tests`, `build`
- ✅ Do not allow bypassing the above settings
- ❌ Allow force pushes (本番ブランチでは禁止)
- ❌ Allow deletions

## リリース前チェックリスト

### 1. コードの品質確認

```bash
# Lint チェック
npm run lint

# 型チェック
npm run typecheck

# テスト実行
npm run test:run

# ビルド確認
npm run build
```

### 2. ドキュメント確認

- [ ] 新機能のドキュメントが更新されている
- [ ] 破壊的変更がある場合、マイグレーションガイドが用意されている
- [ ] README.md が最新の状態である

### 3. Issue/PR確認

- [ ] マイルストーンに紐づく全てのIssueがクローズされている
- [ ] マイルストーンに紐づく全てのPRがマージされている
- [ ] 未解決の重大なバグがない

### 4. セキュリティ確認

```bash
# 依存関係の脆弱性チェック
npm audit

# ライセンスチェック
npm run license:check
```

## リリース手順

### Phase 0: Release PR作成（feature ブランチ → main）

> Dayopt に常設の `dev` ブランチは無い。リリースは番号付きの feature ブランチ（例: 直近 v0.30.0 は [#1370](https://github.com/Dayopt/dayopt/pull/1370)）を main へ PR する形で行う。version bump はこの Release PR に含める。

#### 0.1 リリースブランチの準備

```bash
# リリース対象の feature ブランチに切り替え（version bump を載せるブランチ）
git checkout <release-branch>
git pull origin <release-branch>

# main に追従（コンフリクトを避ける）
git fetch origin
git rebase origin/main   # または git merge origin/main
```

#### 0.2 version bump を PR に含める

```bash
VERSION="0.X.0"

# package.json のみ更新（タグはこの時点では打たない）
npm version ${VERSION} --no-git-tag-version
git commit -am "chore(release): v${VERSION} へ version bump"
```

タグ打ち前に main の `package.json` が正しい状態になるよう、version bump は必ずこの Release PR に含める（リリース後の後片付けがゼロになる）。

#### 0.3 ブランチの状態確認

```bash
# 未コミットの変更がないこと
git status

# 最新のコミット確認
git log -5 --oneline

# main との差分確認
git log main..HEAD --oneline
```

#### 0.4 Pull Request作成

```bash
# GitHub CLI でPR作成（--head は現在のリリースブランチ）
gh pr create \
  --base main \
  --head "$(git branch --show-current)" \
  --title "Release v${VERSION}" \
  --body "$(cat <<'EOF'
## 📦 Release v${VERSION}

### リリース内容
- 今回リリースの主な変更点

### リリース前チェックリスト
- [ ] npm run lint - 成功
- [ ] npm run typecheck - 成功
- [ ] npm run test:run - 成功
- [ ] npm run build - 成功
- [ ] リリースノート作成済み

### CI/CD
- GitHub Actions が自動実行されます
- Quality Gate 通過後にマージ可能になります

/cc @reviewer
EOF
)"

# または GitHub UI から手動作成
# https://github.com/Dayopt/dayopt/compare/main...<release-branch>
```

#### 0.5 CI/CD パイプライン確認

**自動実行されるチェック（`.github/workflows/ci.yml`）**:

**Phase 1: Quick Checks（並列実行 / 3分以内）**

- 🔍 ESLint & Prettier
- 🔤 TypeScript型チェック
- 🧪 Unit Tests（カバレッジ付き）
- 🌍 i18n Translation Check

**Phase 2: Quality Checks（並列実行 / 5分以内）**

- 🏗️ Build（Next.js本番ビルド）
- ♿ Accessibility（a11yチェック）
- 🔍 Heavy Analysis（License, API, Performance）
- 📚 Docs Consistency

**Phase 3: Quality Gate**

- 🚪 全チェック結果の集約
- 💬 PRへのサマリーコメント自動投稿

```bash
# CI/CD実行状況を確認
gh pr checks

# 詳細ログを確認
gh run view --log

# PRのステータスを確認
gh pr view
```

#### 0.6 レビュー & マージ

**マージ条件**:

- [ ] Quality Gate（全必須チェック）が通過
- [ ] **PR内容の目視確認完了**（承認者不在でも実施必須）
- [ ] コンフリクトなし

**⚠️ 重要: 一人開発での確認プロセス**

承認者がいない場合でも、以下の手順で**必ずPR内容を確認**してからマージすること：

```bash
# 1. CI/CD完了を確認
gh pr checks

# 2. PRの変更内容を確認（Web UIで詳細レビュー）
gh pr view --web

# 3. 変更ファイル一覧を確認
gh pr diff --name-only

# 4. 重要な変更を個別確認（例: 設定ファイル、セキュリティ関連）
gh pr diff -- package.json
gh pr diff -- .github/workflows/
gh pr diff -- src/middleware.ts

# 5. 確認完了後にマージ（Merge commit）
gh pr merge --merge --delete-branch

# または GitHub UI から手動マージ
# https://github.com/Dayopt/dayopt/pulls
```

**確認すべき項目**:

- [ ] 意図しない変更が含まれていないか
- [ ] セキュリティ上問題のある変更がないか
- [ ] 設定ファイルの変更が正しいか
- [ ] ドキュメントの更新が適切か
- [ ] コミットメッセージが適切か

> **マージ方式**: リポジトリ設定で squash / rebase は無効化され **merge commit に統一**されている（`mergeCommitAllowed: true`, `squashMergeAllowed: false`）。`--graph` で分岐・合流が追える履歴を残すため。
>
> **ブランチ削除**: feature ブランチは merge 後に削除する（`deleteBranchOnMerge: true`）。`--delete-branch` を付ける。

### Phase 1: main の取り込み確認

#### 1.1 mainブランチに切り替え

```bash
git checkout main
git pull origin main
```

#### 1.2 状態確認

```bash
# Release PR のマージが反映されていることを確認
git log -5 --oneline

# package.json のバージョンが更新済みであることを確認
node -p "require('./package.json').version"  # → ${VERSION} になっているはず
```

> main マージは domain 未割当の Production build を作り、`Production Release` workflow を自動起動する（`push: main`、2026-09-03）。公開はその workflow の promote が、影響のある層 3 を通した後に行う。タグはデプロイトリガーではなく、promote と観察が終わった後の証跡。

### Phase 2: リリースノート作成

#### 2.1 前回リリース以降の全PRを取得

```bash
# バージョン番号を決定（例: v0.6.0）
VERSION="0.6.0"

# 前回リリースのタグを確認
git tag --sort=-creatordate | head -5

# 前回リリース以降のPR一覧を取得
gh pr list --state merged --base main --limit 100 --json number,title,mergedAt \
  | jq -r '.[] | select(.mergedAt > "YYYY-MM-DDT00:00:00Z") | "- [#\(.number)](https://github.com/Dayopt/dayopt/pull/\(.number)) - \(.title)"'
```

#### 2.2 リリースノートファイル作成

リリースノート本体はリポジトリにコミットせず、GitHub Release に直接反映する（第4部のテンプレートを参照）。

#### 2.3 リリースノート編集

一時ファイルに第4部の構造で編集し、`gh release edit` で反映する。

**⚠️ 重要: 記載内容**

前回リリース以降の**全てのPR**を、第4部で定義する5カテゴリに分類して記載：

- 新機能 - 各項目にPRリンクを付ける
- 改善（パフォーマンス改善を含む） - 各項目にPRリンクを付ける
- バグ修正 - 各項目にPRリンクを付ける
- 破壊的変更（互換性を壊す削除を含む）
- セキュリティ - 各項目にPRリンクを付ける
- Pull Requests一覧 - 全PRをリストアップ

**品質基準:**

- [ ] 前回リリース以降の全てのPRが含まれている
- [ ] 各PRにリンクが付いている
- [ ] カテゴリ別に整理されている
- [ ] Full Changelogリンクが正しい

### Phase 3: タグ作成

version bump は Phase 0 の Release PR で済んでいる（`package.json` は更新済み）。ここでは main 上でタグを打つだけ。`npm version` は使わない（main への直接コミットを避けるため）。

> セムバーの目安（VERSION は Phase 0.2 で決定済み）: PATCH=バグ修正 / MINOR=新機能 / MAJOR=破壊的変更。

#### 3.1 タグ作成

```bash
# main 上で version 記録用タグを打つ
git tag v${VERSION}
```

#### 3.2 タグ内容の確認

```bash
# タグが指すコミットを確認（version bump コミットであること）
git show v${VERSION} --stat | head -20

# タグ一覧
git tag --list | tail -5
```

### Phase 4: タグのプッシュ

#### 4.1 タグをプッシュ

```bash
# main は Release PR のマージ時点で push 済み。ここではタグだけを push する
git push origin v${VERSION}
```

タグ push により GitHub Actions（`.github/workflows/create-release.yml`）が **GitHub Release を自動作成**する（auto-generated notes 付き）。この workflow はデプロイしない。公開は main merge が自動起動した `Production Release` workflow が promote 済みのはずで（Phase 1.2）、create-release はタグ SHA の `Production Release` status が success であることを確認してから Release を作る。

#### 4.2 プッシュ確認

```bash
# リモートのタグを確認
git ls-remote --tags origin

# GitHub上で確認
gh repo view --web
```

### Phase 5: GitHub Release のノート反映

Release 自体は Phase 4 のタグ push で **自動作成済み**（auto-generated notes）。ここでは Phase 2 で用意した詳細ノートに差し替える。

#### 5.1 詳細ノートを反映

```bash
# Phase 2 で作成した詳細リリースノートを一時ファイルに用意し、上書き反映
# 構造は第4部を参照
gh release edit v${VERSION} \
  --notes-file /tmp/release-notes-v${VERSION}.md
```

#### 5.2 Release確認

```bash
# 反映されたReleaseを確認
gh release view v${VERSION} --web
```

### Phase 6: デプロイ確認

#### 6.1 自動デプロイの監視

```bash
# Vercelのデプロイ状況を確認
# https://vercel.com/Dayopt/dayopt

# デプロイログを確認
npm run deploy:stats
```

#### 6.2 本番環境の動作確認

```bash
# ヘルスチェック
npm run deploy:health

# 本番環境にアクセスして動作確認
# https://dayopt.vercel.app
```

**確認項目:**

- [ ] サイトが正常に表示される
- [ ] 新機能が動作する
- [ ] 既存機能が正常に動作する
- [ ] エラーが発生していない
- [ ] パフォーマンスに問題がない

## リリース後の作業

### 1. マイルストーンのクローズ

```bash
# GitHub UI でマイルストーンをクローズ
# https://github.com/Dayopt/dayopt/milestones
```

### 2. 関連Issueの更新

```bash
# リリースされたことをIssueにコメント
gh issue comment <issue_number> \
  --body "Released in v${VERSION}: https://github.com/Dayopt/dayopt/releases/tag/v${VERSION}"
```

### 3. ドキュメントの更新

- [ ] README.md のバージョン番号更新（必要に応じて）

### 4. 通知

- [ ] チームへのリリース通知
- [ ] ユーザーへのアナウンス（必要に応じて）

### 5. モニタリング

```bash
# Sentryでエラー監視
# https://sentry.io/organizations/dayopt/issues/

# アナリティクス確認
npm run analytics:stats
```

## ロールバック手順

### 緊急時のロールバック

#### 1. 重大な問題の確認

- クリティカルなバグ
- セキュリティ上の問題
- データ損失の可能性

#### 2. ロールバック実行

**壊れている project だけを戻す。Product / Web を同じ SHA へ揃えようとしない。** release は変更の影響を受ける project だけを進めるため、両者の live SHA が違うのは正常な定常状態であり、揃える先の deployment がそもそも存在しないこともある。

戻し先は `Production Release` run の **`release-manifest-<attempt>` artifact**（保持 90 日、run attempt ごとに artifact が分かれる。re-run した run では最新の attempt を見る）が一次情報。project ごとに `action`（promoted / rolled-back / skipped / already-serving / moved-externally）と `deploymentId` / `previousDeploymentId` が入っている。**まず manifest の `status` を見る**（`settings-drift` なら production は正しい SHA を配信しており、deployment は戻さない。判断表は Playbook 2 ケース0-B が正本）。`status: failed` の場合、`action: promoted` の project の `previousDeploymentId` が戻し先。`skipped` / `already-serving` はこの release が触っていないので巻き添えで戻さず、`moved-externally` は他者が置いた deployment が live なので**戻さずに本人へ確認する**。artifact が無い古い run では run summary の `previous` deployment id を使う。

- https://vercel.com/dayopt/product/deployments
- https://vercel.com/dayopt/web/deployments

対象 deployment の "..." → **Instant Rollback**（または Promote to Production）。新しい Production build は作らない。

戻るのはビルド成果物だけで、**DB migration と変更済み環境変数は戻らない**。migration を含むリリースでは、戻し先の deployment が現在のスキーマで動くことを先に確認する。

#### 3. GitHub Releaseの対応

```bash
# Releaseをドラフトに変更（削除はしない）
gh release edit v${VERSION} --draft

# 問題を説明するIssueを作成
gh issue create \
  --title "Rollback: v${VERSION} - Critical Issue" \
  --body "Description of the issue..."
```

#### 4. 修正版のリリース

```bash
# 問題を修正用の feature ブランチで対応し、version bump を含めて main へ PR
# （通常のリリースフローと同じ: Phase 0 → 4）
#   npm version patch --no-git-tag-version → commit → PR → merge（merge commit, ブランチ削除）

# main 取り込み後、Production Release の promote 完了を待つ
gh run watch --exit-status

# promote と観察が終わってからタグを打つ（Release は自動作成される）
git checkout main && git pull origin main
git tag v${VERSION_PATCH}
git push origin v${VERSION_PATCH}
```

## トラブルシューティング

### Q: npm version でエラーが出る

```bash
# 未コミットの変更がある場合
git status
git add .
git commit -m "chore: prepare for release"

# または強制実行（非推奨）
npm version patch --force
```

### Q: タグのプッシュに失敗する

```bash
# タグの確認
git tag -l

# タグを削除して再作成（version bump は Release PR 済みなので git tag のみ）
git tag -d v${VERSION}
git tag v${VERSION}
git push origin v${VERSION}
```

### Q: GitHub Releaseの作成に失敗する

```bash
# GitHub CLI の認証確認
gh auth status

# 再ログイン
gh auth login

# 手動で作成
# https://github.com/Dayopt/dayopt/releases/new
```

### Q: デプロイが失敗する

```bash
# Vercelのログを確認
# https://vercel.com/Dayopt/dayopt/deployments

# ローカルでビルド確認
npm run build

# 環境変数の確認
npm run vercel:check
```

## チェックシート

### リリース実施チェックシート

```markdown
## リリース v${VERSION} チェックシート

### リリース前（リリースブランチ）

- [ ] npm run lint - 成功
- [ ] npm run typecheck - 成功
- [ ] npm run test:run - 成功
- [ ] npm run build - 成功
- [ ] version bump を Release PR に含めた（npm version --no-git-tag-version）
- [ ] リリースノート作成済み
- [ ] マイルストーンの全Issue/PRクローズ済み

### Phase 0: Release PR作成 & マージ（feature ブランチ → main）

- [ ] PRテンプレート記入完了
- [ ] CI/CD Quality Gate 通過
  - [ ] lint ✅
  - [ ] typecheck ✅
  - [ ] unit-tests ✅
  - [ ] build ✅
  - [ ] i18n-check ✅
  - [ ] accessibility ✅
  - [ ] heavy-checks ✅
  - [ ] docs-consistency ✅
- [ ] コードレビュー承認済み
- [ ] PRマージ完了（Merge commit / feature ブランチ削除）

### Phase 1-4: タグ作成 & プッシュ（mainブランチ）

- [ ] mainブランチに切り替え
- [ ] PRマージ内容・package.json バージョンを確認
- [ ] タグ作成（git tag v${VERSION}）
- [ ] Tag push完了（Release は自動作成）

### Phase 5-6: GitHub Release & デプロイ

- [ ] GitHub Release作成完了
- [ ] Vercelデプロイ成功
- [ ] 本番環境動作確認OK
- [ ] Sentryエラー監視OK

### リリース後

- [ ] マイルストーンクローズ
- [ ] 関連Issueへコメント
- [ ] チームへ通知完了

### 日時

- 開始: YYYY-MM-DD HH:MM
- 完了: YYYY-MM-DD HH:MM
- 実施者: @username
```

## リリースフロー概要図

```
┌─────────────────────────────────────────────────────────────┐
│ Phase 0: Release PR（feature ブランチ → main）              │
├─────────────────────────────────────────────────────────────┤
│ 1. feature ブランチで version bump（--no-git-tag-version）  │
│ 2. PR作成（feature → main）                                  │
│ 3. CI/CD自動実行（lint, typecheck, test, build...）         │
│ 4. Quality Gate 通過                                         │
│ 5. コードレビュー & 承認                                      │
│ 6. PRマージ（Merge commit + feature ブランチ削除）          │
│    → main マージで Vercel 本番デプロイが自動実行            │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ Phase 1-4: タグ作成（main）                                  │
├─────────────────────────────────────────────────────────────┤
│ 1. main ブランチに切り替え（version bump 反映済み）         │
│ 2. git tag v0.X.X                                            │
│ 3. git push origin v0.X.X                                    │
│    → create-release.yml が GitHub Release を自動作成        │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ Phase 5-6: Release ノート反映 & 確認                         │
├─────────────────────────────────────────────────────────────┤
│ 1. gh release edit で詳細ノートを反映                        │
│ 2. 本番環境動作確認（デプロイは Phase 0 で実行済み）        │
│ 3. Sentryモニタリング                                        │
└─────────────────────────────────────────────────────────────┘
```

## 参考リンク

### 公式ドキュメント

- [Semantic Versioning](https://semver.org/)
- [GitHub Releases](https://docs.github.com/ja/repositories/releasing-projects-on-github/managing-releases-in-a-repository)
- [GitHub Branch Protection](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)
- [Gitflow Workflow](https://www.atlassian.com/git/tutorials/comparing-workflows/gitflow-workflow)
- [Vercel Deployments](https://vercel.com/docs/deployments/overview)

---

# 第3.5部: バージョニング管理ガイド

Dayoptは [Semantic Versioning 2.0.0](https://semver.org/spec/v2.0.0.html) に準拠したバージョン管理を行う。

## バージョン形式

```
X.Y.Z
```

- **X (MAJOR)**: 破壊的変更を含む場合にインクリメント
- **Y (MINOR)**: 後方互換性のある新機能追加時にインクリメント
- **Z (PATCH)**: 後方互換性のあるバグ修正時にインクリメント

## バージョンアップの判断基準

### MAJOR (X) - 破壊的変更

- API の破壊的変更
- データベーススキーマの非互換変更
- 設定ファイル形式の変更
- 依存関係の大幅な変更

**例**: `1.0.0` → `2.0.0`

### MINOR (Y) - 新機能

- 新しい機能の追加
- 既存機能の拡張
- パフォーマンス改善
- 非推奨機能の追加（削除は次のMAJOR）

**例**: `1.0.0` → `1.1.0`

### PATCH (Z) - バグ修正

- バグ修正
- セキュリティパッチ
- ドキュメント修正
- リファクタリング

**例**: `1.0.0` → `1.0.1`

## バージョンアップ手順

version bump は **リリース対象の feature ブランチ上で行い、Release PR に含める**（main へ直接コミットしない）。

```bash
# package.json のみ更新（タグは打たない）。VERSION は上記ルールで決定
npm version ${VERSION} --no-git-tag-version
git commit -am "chore(release): v${VERSION} へ version bump"
```

タグ作成・push・GitHub Release（タグ push で自動作成）を含む完全な手順は第3部を正本とする。本セクションはバージョン番号の決定ルールに専念する。

## リリースフロー（開発フロー）

```
1. 機能開発 (feature/xxx ブランチ)
   ↓
2. feature ブランチで version bump → main へ Release PR
   ↓
3. CI・品質チェック (Quality Gate)
   ↓
4. PR マージ (merge commit / ブランチ削除) → Vercel が Production build → `Production Release` が自動起動し、層 3 green で promote
   ↓
5. main でタグ作成 & push
   ↓
6. GitHub Release 自動作成 → 詳細ノート反映
```

### プレリリース

開発版やベータ版をリリースする場合:

```bash
# アルファ版
npm version prerelease --preid=alpha
# 例: 0.1.0-alpha.0

# ベータ版
npm version prerelease --preid=beta
# 例: 0.1.0-beta.0

# リリース候補
npm version prerelease --preid=rc
# 例: 0.1.0-rc.0
```

## バージョニング計画

### ロードマップ

| バージョン | 目標             | 主な内容          |
| ---------- | ---------------- | ----------------- |
| **v0.0.1** | 初回リリース     | 基本機能実装      |
| **v0.0.x** | バグ修正         | 初期不具合対応    |
| **v0.1.0** | TypeScript厳格化 | strict mode完了   |
| **v0.2.0** | テスト強化       | カバレッジ60%達成 |
| **v0.3.0** | E2Eテスト        | Playwright導入    |
| **v1.0.0** | 正式リリース     | 本番運用開始      |

### v1.0.0 までの条件

- [ ] TypeScript strict mode完全対応
- [ ] テストカバレッジ80%以上
- [ ] E2Eテスト導入
- [ ] パフォーマンス最適化
- [ ] セキュリティ監査完了
- [ ] ドキュメント整備完了
- [ ] 本番環境での安定稼働確認

## ベストプラクティス

### ✅ 推奨

- リリース前に必ず `npm run lint` と `npm run typecheck` を実行
- 破壊的変更は BREAKING CHANGE として明記
- バージョンタグは必ず `v` プレフィックスを付ける（例: `v0.0.1`）

### ❌ 非推奨

- リリース後のバージョン番号の変更
- タグの削除・付け替え

## 参考リンク

- [Semantic Versioning 2.0.0](https://semver.org/spec/v2.0.0.html)
- [Keep a Changelog](https://keepachangelog.com/en/1.0.0/)
- [npm version](https://docs.npmjs.com/cli/v8/commands/npm-version)

---

# 第4部: リリースノート執筆規約

GitHub Release 本文（`gh release edit` で反映）と Web公開用リリースノート（`apps/web/content/releases/{en,ja}/*.mdx`、`docs-writing` skill が担当）が共有する、唯一のカテゴリ定義。Claude・人間のいずれが書く場合もこの規約に従う。カテゴリはここでのみ定義し、他ファイル（`.claude/skills/releasing/SKILL.md`、`.claude/skills/docs-writing/templates/blog-frontmatter.md`）は再定義せずこのセクションを参照する。

## カテゴリ定義（共通・唯一の正）

| カテゴリ (id)      | 見出し       | icon | 振り分け方                                                                         |
| ------------------ | ------------ | ---- | ---------------------------------------------------------------------------------- |
| `new-features`     | 新機能       | 🎉   | 新規機能・追加された使い方                                                         |
| `improvements`     | 改善         | 🔧   | 既存機能の変更。パフォーマンス改善もここに含める                                   |
| `bug-fixes`        | バグ修正     | 🐛   | 不具合の修正                                                                       |
| `breaking-changes` | 破壊的変更   | ⚠️   | 互換性を壊す変更。互換性を壊す削除もここに含める（壊さない非推奨化は改善に含める） |
| `security-updates` | セキュリティ | 🔒   | セキュリティ関連の対応                                                             |

id・アイコン・色は `apps/web/src/features/releases/lib/releases.ts` の `changeTypes` 配列を正とする（Web UIの表示色を決めるコード制約のため、値をここに手動複製しない）。この5分類を超えるカテゴリを追加しない。

該当する分類だけを付ける。1リリースが5分類すべてに触れるとは限らないため、1-2個でも正当（blogの自由記述タグにある「3-6個を目安」はここには適用しない）。空配列だけは禁止で、最低1個は必ず該当する分類を選ぶ。

## 媒体ごとの違い（カテゴリは共通、トーンが違う）

| 観点     | GitHub Release 本文                  | Web MDX（`apps/web/content/releases/`）             |
| -------- | ------------------------------------ | --------------------------------------------------- |
| 読者     | 開発者・技術的なステークホルダー     | エンドユーザー                                      |
| 粒度     | 各項目にPRリンク付きで技術詳細を記載 | 「何ができるようになったか」中心の平易な表現        |
| PRリンク | 必須                                 | 不要                                                |
| 文体の正 | 本セクションの構造・チェックリスト   | `docs-writing` skill の `references/style-guide.md` |

## GitHub Release テンプレート

AIがリリースノートを記載する際の構造テンプレート。リポジトリにリリースノートファイルをコミットする必要はなく、`gh release edit` で GitHub Release ページに直接反映する。PR一覧の取得方法は第2部「2.1 前回リリース以降の全PRを取得」と同じ（`.claude/skills/releasing/scripts/get-merged-prs.sh` でも同等の処理が可能）。

```markdown
# Release vX.Y.Z

**リリース日**: YYYY-MM-DD
**バージョン**: X.Y.Z

## 🎯 概要

このリリースの主な変更点を簡潔に記載（前回リリースからの全変更を網羅）

---

## 📋 変更内容

**⚠️ 重要**: 前回リリース（v{前バージョン}）から今回リリース（v{今回バージョン}）までの**全てのPR**を網羅して記載すること。リリースPR単体の変更だけでなく、期間中にマージされた全PRの内容を反映する。

### 🎉 新機能

- **機能名** ([#PR番号](https://github.com/Dayopt/dayopt/pull/{PR番号}))
  - 詳細説明

### 🔧 改善

- **変更内容** ([#PR番号](https://github.com/Dayopt/dayopt/pull/{PR番号}))
  - 詳細説明（パフォーマンス改善もここに記載）

### 🐛 バグ修正

- **修正内容** ([#PR番号](https://github.com/Dayopt/dayopt/pull/{PR番号}))
  - 詳細説明

### ⚠️ 破壊的変更

- 破壊的変更がある場合、詳細に記載（互換性を壊す形で削除された機能・API・コンポーネントを含む）
- マイグレーション手順も記載

### 🔒 セキュリティ

- **対応内容** ([#PR番号](https://github.com/Dayopt/dayopt/pull/{PR番号}))
  - セキュリティ関連の修正

---

## 🔗 関連リンク

### Pull Requests

**⚠️ 重要**: 前回リリースから今回リリースまでの**全てのPR**をリストアップすること。

- [#PR番号](https://github.com/Dayopt/dayopt/pull/{PR番号}) - {PR説明}
- [#PR番号](https://github.com/Dayopt/dayopt/pull/{PR番号}) - {PR説明}
- ...（前回リリース以降の全PRを記載）

---

**Full Changelog**: https://github.com/Dayopt/dayopt/compare/v{前バージョン}...v{今回バージョン}
```

### リリースノートの品質基準

- [ ] 前回リリース以降の**全てのPR**が含まれている
- [ ] 各PRにリンクが付いている
- [ ] 上記5カテゴリ（新機能・改善・バグ修正・破壊的変更・セキュリティ）に整理されている
- [ ] Full Changelogリンクが正しい
- [ ] バージョン番号が正しい

## Web版リリースノートとの関係

同じ変更内容から `apps/web/content/releases/{en,ja}/*.mdx` を書く場合は `docs-writing` skill（`.claude/skills/docs-writing/templates/blog-frontmatter.md`）に従う。カテゴリは上記の5分類をそのまま使い、PR一覧の収集も本パートと同じ手順を流用する。GitHub Release本文をそのまま転記せず、エンドユーザー向けに平易な言葉へ書き直す（PRリンクは含めない）。

## 過去のリリースノートスナップショット

バージョン別のリリースノートは `docs/operations/log/` に日付プレフィックス付きで保存していたが、2026-08-28（#2475）に domain log/ を全廃したため、過去分は Git 履歴のみに残る。リリースノートの正本は [GitHub Releases](https://github.com/Dayopt/dayopt/releases) と `apps/web/content/blog/{en,ja}/` の `category: 'release'` 記事。
