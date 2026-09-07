---
status: current
last_verified: 2026-08-27
---

# Dayopt 不変条件カタログ

「**あるべき検査の不在**」を判定するための正本。課金・認証・RLS・OAuth・MCP 境界・時刻に
ついて「何が守られているべきか」だけを持つ。危険クラスの変更をレビューする時に、diff が
何を壊しうるかの照合先として読む。

「不変」は**システムが守るべき約束**の意味で、このファイル自体は機能と一緒に育つ。
**機能を追加・変更してここの前提が変わったら、同じ PR でこのファイルを更新する。**
更新経路は 3 つ:

1. 実装側 — security skill（Dayopt 固有ルール 4）が、前提を作った PR での更新を義務付ける
2. レビュー側 — `risk-reviewer`（`pr-cross-review` スキル経由）が、カタログに無い新しい前提を
   見つけたら追記を提案する。危険クラスの diff を読む立場にいるため、抜けに最初に気づける
3. 月次ガーデニング — 鮮度を見る

なお、このカタログの**削除・緩和**を含む PR は人間が diff で直接確認する
（レビュアーは自分の判定基準の変更を自分では警告できない）。

このファイルは 2026-08-03 まで `scripts/ai-review/invariants.md` にあった。外部モデルの
自動レビュー（ai-review）は撤去したが、カタログ自体はレビュアーに依存しない資産なので
docs へ残している。

## 課金・entitlement

- 外部カレンダー連携は **Pro 限定**。OAuth の開始・callback・cron 同期の**すべての入口**で
  entitlement を検査する（2026-07 に callback の検査漏れが実際に起きたクラス）
- Pro 限定機能の server 入口は `entitledProcedure(key)` を使うか、明示的に entitlement を検査する
- Stripe webhook は署名を検証し、event id で冪等化する
  （`app/api/webhooks/stripe/stripe-webhook-idempotency.ts`）

## 公開 HTTP エンドポイント

- 公開エンドポイント（OAuth callback / webhook / contact）は rate limit を持つ
- `withUpstashRateLimit` のIP rate limitはVercel由来の`X-Real-IP`だけを使い、`X-Forwarded-For`へfallbackしない。欠落・不正値は共有`ip:unknown`でfail closedにする
- rate limitのRedis keyは`ip:` / `email:`のpurpose prefixを付けてHMAC化し、生のIP / emailを保存・記録しない。account bucketを併用する場合はIP-firstで短絡し、IP bucketが拒否したらaccount bucketを消費しない
- cron ルート（`app/api/cron/**`）は `CRON_SECRET` を検証する
- redirect 先はユーザー入力をそのまま使わず、`lib/safe-redirect.ts` の検証を通す

## 認証・MFA

- Session認証のHTTP / RSC tRPC contextは共通resolverでverified user、session token、MFA assuranceを解決する。session token取得失敗でMFA lookupを抑止しない
- 認証済みsessionでMFA lookupがerror / throw、未知・不正遷移、またはassurance欠落なら`protectedProcedure`はfail closedで拒否する。AAL claimなしはSupabase契約どおりAAL1へ正規化する
- proxyのMFA redirectをprocedure backstop追加と引き換えに弱めない

## データ分離（RLS）

- user データを持つ table は RLS 有効。標準形は
  「`Users can view own X`（`auth.uid() = user_id`）」+「service_role full access」。
  この形から外れる policy は、外れる理由が migration に書かれているべき
- `SECURITY DEFINER` 関数は `search_path` を固定し、内部で `auth.uid()` を検証する
- token・暗号化 credential の列を `authenticated` ロールに GRANT しない
- **所有者付きリソースを跨いで参照する行は、単一 ID ではなく `(id, user_id)` の複合 FK で
  束縛する。** トリガーではなく FK で守るので、他人の行を紐づけることが構造的に不可能になる。
  参照先には `UNIQUE (id, user_id)` の anchor が要る（`categories` / `activities` /
  `segments` / `calendar_connections` / `plans` / `records` / `oauth_connections`）。
  単一 FK は「その ID が存在すること」しか証明しない — 過去に Calendar で同型の穴が実発生し
  複合 FK へ修正した（`20260724000416`）
- **PostgREST が公開する schema（`supabase/config.toml` の `[api] schemas`、現状 `public` と
  `graphql_public`）の view は `security_invoker = true`・`_v<N>` 命名・`anon` 到達不可。**
  同 schema の `SECURITY DEFINER` 関数は `anon` / `PUBLIC` から EXECUTE できない。
  公開面が複数あるのに 1 つしか検査しない状態は、境界が無いより危険なので両方を見る。
  新規 view は Supabase の default ACL で `anon` に権限が付くため、明示的な `REVOKE` が要る
  （付けないとこの guard が落ちる）。
  GRANT と RLS は別々に判定され、view は既定で RLS を迂回しうるため、GRANT を絞るだけでは
  足りない。`_v<N>` 命名は旧 version と新 version を並存させて可逆に cutover するための前提。
  強制は `private.assert_public_contract_exposure_v1()`（migration 適用時）と
  `pnpm rls:snapshot:check`（CI での継続 drift 検出）の 2 層
- **`user_id` を持つ `public` table は、account-preserving purge
  （`delete_all_user_data_command_v3`）が直接消すか、そこから `ON DELETE CASCADE` で
  到達できるか、理由付きの allowlist に載っているかのいずれかでなければならない。**
  purge は消す対象を関数本文に列挙する方式なので、新規テーブルの追加漏れが静かに起きる
  （#2162 と #2444 で 2 回実発生）。**削除の正本は製品経路が到達する関数**（現在は
  `account-deletion.ts` → `v5` → `v4`。`v3` はレガシーで生きた呼び出し元が無い）。
  強制は `user-data-purge-enumeration.integration.test.ts` で、**関数名をハードコードせず
  製品コードの RPC 定数から呼び出しチェーンを辿る** — 名前を固定すると、製品が別 version を
  呼ぶようになった時に死んだ関数を検査し続ける（2026-08-27 に実発生）

## OAuth・暗号

- 外部 OAuth では `openid` scope を要求し、ユーザーの同定は id_token 側で行う
  （メールアドレスの一致で同定しない）
- token 暗号化の鍵は起動時に長さを検証する（32 bytes 以上）
- 外部カレンダーの再接続は、callback で検証した Google `sub` が保存済み
  `provider_account_id` と一致する既存の `reauth_required` 行だけを条件付き更新する。
  generic upsert で削除済み接続を復活させず、切断との競合では切断を勝たせる
- iCal feed token は URL を知るだけで購読できる bearer-style credential として扱い、client query を
  永続 cache へ保存しない。Settings を開く時と focus 復帰時は再取得し、取得中の cached URL は操作させない
- `external-connection-maintenance` cron は calendar revoke outbox に **`MIN_BATCH_BUDGET_MS`
  以上の残り時間**を必ず渡す。outbox はこれを割ると 1 件も claim せずに break するため、retention の
  取り分を増やしすぎると provider への revoke request が永久に送られない（DB からは接続が消えている
  のに provider 側の token は生きたまま残る）。時間予算は `route.ts`（`TIME_BUDGET_MS` / `maxDuration`）
  / `maintenance-dispatcher.ts`（`RETENTION_BUDGET_MS`）/ `revoke-outbox.ts`（`MIN_BATCH_BUDGET_MS`）の
  3 module に分かれているので、**どれか 1 つを動かす時は残り 2 つとの不等式を確認する**
  （dispatcher の `Math.max` と `maintenance-dispatcher.test.ts` / `route.test.ts` が機械で守る）

## Export

- CSV に出す外部入力由来の文字列は、先頭が `=` / `+` / `-` / `@` / tab / carriage return
  の場合に文字列として neutralize してから CSV field escaping を行う

## MCP の DB 書き込み境界

- MCP mutation の global gate は DB 上で既定 `OFF`、`enabled_client_ids` は既定 `[]`。
  両方が許可した client だけがwrite grant/applyを通る。各gateはrevision付きの
  service-role-only RPC以外から変更しない
- Candidate 1では `global OFF AND client list empty` をProductionの停止条件とする。
  旧UI direct UPDATE、tag mergeのlock順、legacy confirm-dayとdirect Recordのraceは、
  Stage 2のapp command移行と競合testが終わるまでMCP writeから到達不能にする
- MCP apply RPC は `service_role` だけが実行できる。各 apply transaction 内で user、
  connection、access token、DB-owned environment/resource、scope、期限、
  connection/token の失効状態を共通writer fence内で再検証する
- OAuth authorityのresourceは変更不可のDB environment identityへFKで結ぶ。PR Previewは
  空または未使用の既知auth seed fixtureだけのDBでexact Vercel URLとSupabase project
  ref/JWT refをservice-role RPCから一度だけ設定する。UUID/email/password/provider
  identityを固定し、未知user、session、MFA、Auth OAuth state、既存OAuth authorityが
  あれば拒否する。Persistent Staging identityは作らない
- `oauth_connections` / `oauth_authorization_codes` / `oauth_tokens` のstored scopeは、
  write / delete scopeを持つ行が必ず `read:entries` を含む。Candidate 4が `NOT VALID` で
  配置し、Candidate 5がread-only preflightの後にvalidatedへ進めた。grant RPC側の
  同等チェックとvalidated CHECK制約の二層でfail closedにする
- Plan / Record writerはtransaction内で一人のuserとlock modeへbindする。direct DMLと
  typed commandを同じ境界へ入れ、sharedからexclusiveへのlock upgradeを即時拒否する。
  user revisionはcommitしたtransactionごとに最大1回進み、rollbackでは進まない
- mutation 本体とimmutable receiptは同じtransactionで確定し、失敗時はどちらも残さない。
  receiptはDB-authored user-data generationに結び、削除世代を越えたreplayを拒否する
- Plan / Record の同一lane重複は、通常UIのdirect DMLとMCP applyの両方に効く
  PostgreSQL exclusion constraintを最終authorityとする
- connection revokeは、connection本体と同一`connection_id`の全tokenを同一transactionで
  失効させる。revoke後は`rotate_oauth_refresh_token_v2`経由でtoken familyが復活しない
  （rotationはconnectionの失効を検査して`invalid_grant`を返す）。revokeの権限判定は
  `revoke_oauth_connection`内の`auth.uid()`一致が正本で、他人・不在のconnectionはどちらも
  `false`を返して区別しない（列挙で存在確認をさせない）。app層のuser scopingは二重化であり、
  正本の代替にしない
  - **row-levelの終端状態は保証していない。** legacyの直接発行経路
    `issue_oauth_token_pair(..., p_parent_refresh_id)`（`service_role`のみ）は
    connectionをロックせず`revoked_at`も再検査しないため、revokeのUPDATE確定後に
    同じ`connection_id`へ`revoked_at IS NULL`のtoken行が増えうる。アクセスは
    connection側の失効検査で拒否されるので上の保証は崩れないが、「revoked connectionに
    未revoke tokenが存在しない」を前提にした監査・cleanupを書いてはいけない。この経路は
    候補8のdrain対象で、撤去後にこの但し書きも消す
- client停止は「durable gate除外 + 対象connectionを個別revoke」の2手を運用契約とする。
  恒久失効を1 transactionで行うDB commandは持たない
  （issue #1754 のコメント欄 step-6-execution-checklist.md 相当 §3 の決定、2026-08-10。docs/projects 全廃に伴い #2473 で移設）
  - **gate除外が止めるのは新規のwrite grantだけ。** `create_oauth_authorization_grant_v2`は
    write scopeを要求された時にだけ`enabled_client_ids`を検査するため、gate除外後も
    read-onlyのconnection / authorization code / tokenは新規発行できる。侵害clientへの
    読み取りアクセスまで止めるには、この2手では足りない（別途clientをOAuth client登録から
    外すか、全発行を止める手順が要る）
- OAuth retentionのbounded cleanup RPC（`cleanup_oauth_authorization_codes_v1` /
  `cleanup_oauth_access_tokens_v1` / `cleanup_oauth_refresh_tokens_v1` /
  `cleanup_oauth_connections_v1`）の削除predicateは、
  `get_external_authority_maintenance_status_v1()` の同名due flagの判定式と一字一句
  一致させる（`20260810070002_add_oauth_retention_cleanup_rpcs.sql`）。ずれると
  「cleanup後もdueが残る」無限ループになるため、predicateを変更する時は必ず両方を
  同じPRで直す
  - `cleanup_oauth_connections_v1` の削除対象は revoke済みconnectionだけでなく、
    **未revokeのまま`reauth_required_at`が90日超過したconnectionも含む**。つまり
    Settingsのconnection一覧（`revoked_at IS NULL`）に見えている行を消しうる。これは
    status RPCの`connections_due`契約どおりの挙動であり、retention期間の変更はこの
    predicateを直す別issueのscope
  - 例外は`cleanup_oauth_connections_v1`の**子行ガード**だけ。時刻の述語は逐語一致のまま、
    残存する`oauth_tokens` / `oauth_authorization_codes`を持つ親を候補から外す
    （`20260810085241_bound_oauth_connection_cleanup_cascade.sql`）。`p_limit`は親の件数しか
    縛らず、`ON DELETE CASCADE`の子行削除は無制限に走るため、太った親1個でRPC timeoutを超えて
    transactionごとrollbackしうる。**収束は保証される**: tokenの`expires_at`は発行時に
    `connection.reauth_required_at`でクランプされる（`20260729062430`）ので、親が90日超過で
    dueになる時点で子は自身の期限をとうに過ぎており、先行stepが排出し終えた次の実行で親も消える。
    排出が終わるまでdue flagは残るのでfail closedの報告は維持される
  - connection削除は`oauth_tokens` / `oauth_authorization_codes`の複合FK
    （`ON DELETE CASCADE`）で残存token/codeを巻き込み、
    `mcp_mutation_receipts.origin_connection_id`（`ON DELETE SET NULL`）をdetachする。
    このdetachは`private.enforce_mcp_mutation_receipt_lifecycle_v1()`が明示的に
    許可している遷移（`origin_connection_id`のNULL化のみ）で、それ以外のreceipt
    列変更は引き続き拒否される
- `public.plans` / `public.records` へのdirect DMLは `service_role` だけが持つ。
  `authenticated` は `SELECT` のみで、`TRUNCATE` を含む書き込み系privilegeを一切
  持たない（Candidate 6）。INSERT/UPDATE/DELETE policyはgrant層で到達不能になり、
  effective境界の正本は `private.timeblock_effective_write_privileges_v1`。
  旧3 RPC (`soft_delete_plan` / `soft_delete_record` /
  `confirm_day_plans_to_records`) だけは旧bundleのdrainまで `authenticated` に残す
- timeblock commandの `p_user_id` は必ず `ctx.userId` 由来で、client inputから
  渡ってはならない。RLSが第2の防波堤として効かなくなったため、これが唯一のowner
  境界になる。守りは 2 つとも機械側にある（#2627）: (1) command routerのinput schemaが
  `.strict()` なので `userId` を含む入力は `BAD_REQUEST` で弾かれる（silent stripでは
  なくexplicit reject）、(2) routerはserviceへ渡すfieldを1つずつ書き出し、`...input`
  のspreadを使わない。serviceは受け取った `userId` を検証せずそのまま `p_user_id` に
  するので、境界を持っているのはrouterのこの2点だけ
- **Undo は元操作より強い権限や広い user scope を得ない**（`apply_undo_receipt_v1`、
  #2434）。`undo_receipts.origin_connection_id` は `oauth_connections` への複合FKが
  `ON DELETE SET NULL` を持つため、connectionの物理削除（retention cleanup経由）で
  NULLへ落ちうる。これを「UI由来（scope制約なし）」と誤認しないよう、
  `had_origin_connection BOOLEAN`（作成時に固定、以後不変）を別に持ち、
  `had_origin_connection = true AND origin_connection_id IS NULL` を revoke相当として
  扱う。権限判定は「apply時点のoauth_connections.scopes」∩
  「`origin_scopes_snapshot`（receipt作成時点のscopesの固定コピー）」の交差に
  resource_type × effect_kindから導くrequired_scopeが含まれるかで決める。
  revoked_at / reauth_required_atの再検査はconnection行をFOR UPDATEでロックしてから
  行い、権限判定と同時進行のrevokeのTOCTOUを防ぐ
- **CASはfield mask内のフィールドに限定される**（`apply_undo_receipt_v1`）。
  `undo_receipt_field_changes`の各field_nameについて「現在値 == after_value（元操作が
  書いた値）」を確認し、1つでも不一致ならreceipt全体をall-or-nothingで失敗させる。
  mask外のフィールドへの正当な変更はUndoを妨げない。effectに行単位の版列
  （`resource_version_before`相当）は持たせない — CAS anchorは`after_value`が兼ねる
  （#2443、詳細は
  issue #2394 のコメント欄 step-3-undo-receipt-rpc.md 相当（docs/projects 全廃に伴い #2473 で移設）
- **`undo_receipts.recorded_effect_count`は記録トランザクション内でDB側が`COUNT(*)`して
  確定し、アプリ入力を信頼しない。** apply時・list時の両方でこの値と現在のeffect数を
  再照合し、不一致なら拒否 / 一覧から除外する。`undo_receipt_effects` →
  `plans`/`records`の複合FKは`ON DELETE CASCADE`のため、resourceの物理削除（単発の
  legacy経路・将来のhard-delete command）でeffectだけが欠けるreceiptが生じうる。
  この検査がsilent no-op / 部分適用を防ぐ唯一の機構
- **account-preserving purgeは`undo_receipts`（親）ではなく`undo_receipt_effects`を
  直接DELETEする**（#2434、`delete_all_user_data_command_v4`）。PIIは
  `undo_receipt_field_changes.before_value`/`after_value`にのみ存在し、effectsの
  DELETEがCASCADEでこれを除去する。`undo_receipts`親行（PIIを持たない）は
  tombstoneとして残り、`UNIQUE(user_id, operation_id)`が遅延再送への冪等ガードを兼ねる

## 時刻

- 保存は UTC。表示と日境界の判定はユーザーの timezone で行う
- 時刻の規則は 2 本だけで、これ以外に過去・未来で操作を出し分けない（2026-09-04 に
  「未来 Plan」の特別扱い 4 種を撤去）。強制点は **DB trigger / SQL 関数** であり、
  アプリ層はその写しにすぎない:
  - `end_at > start_at`（Plan / Record 共通、`DT003` / `INVALID_TIME_RANGE`）
  - **Record は未来に終われない**（`end_at <= now`、`validate_record_temporal_write_v1`、
    `DT005` / `RECORD_IN_FUTURE`）
- Plan は時間軸のどこにでも置ける。過去 Plan もドラッグ移動・リサイズ・時間編集ができ、
  編集しても Plan のままで Record にはならない。過去スロットへ新規に引いたブロックは
  Record になる（宛先は `end_at` だけで決まる）

### 規則の写しと、その分類

規則を変える PR は **この表の (a) と (b) を全部直すまでが 1 変更**。DB / service だけ
緩めて写しが残ると「操作はできるのに保存されない」症状になり、旧規則を assert している
テストが緑のまま隠す（#2598 の後に #2622 が必要になった件）。撤去 PR ではこの表を
grep 対象にする。

| 分類          | 場所                                                                                    | 役割                                       | 消してよいか                                  |
| ------------- | --------------------------------------------------------------------------------------- | ------------------------------------------ | --------------------------------------------- |
| (a) 契約変換  | `features/timeblock/server/timeblock-command-client.ts` の `EXPECTED_COMMAND_ERRORS`    | DT コード → `TimeblockServiceError` code   | 不可（UI が code で分岐する）                 |
| (a) 契約変換  | `features/timeblock/server/mcp-mutation-client.ts` の `EXPECTED_ERROR_CODES`            | DT コード → `McpMutationErrorCode`         | 不可（MCP の公開契約）                        |
| (a) 契約変換  | `features/timeblock/server/timeblock-context-contract.ts` の `TIMEBLOCK_CONTEXT_RULES`  | MCP `constraints.get` が返す規則の宣言     | 不可（公開契約）                              |
| (b) UX 先回り | `features/timeblock/schemas/timeblock.ts` の `timeRangeRefine`                          | 往復前に `end > start` を弾く              | 可（server が同じ規則で拒否する）             |
| (b) UX 先回り | `features/timeblock/domain/timeblock-destination.ts`                                    | `end_at` から Plan / Record の宛先を決める | 不可（規則の写しではなく宛先の決定そのもの）  |
| (b) UX 先回り | `features/calendar/lib/overlap.ts` + `lib/time/time-conflict.ts`                        | 重なりの事前表示                           | 可（overlap は DB 側 `TIME_OVERLAP` が正）    |
| (b) UX 先回り | `features/calendar/hooks/operations/useTimeblockOperations.ts` の record 未来移動ガード | ドラッグ中に `timeLocked` を出す           | 可（server 拒否でも同じ toast が出る。#2628） |

server が拒否した時に UI が汎用の `saveFailed` へ退化しないよう、`INVALID_TIME_RANGE` /
`RECORD_IN_FUTURE` は `lib/trpc/client-safe-service-code.ts` の allowlist に載せ、
`useTimeblockWriteMutations.ts` の `reportError` が規則ごとの文言へ写像する。allowlist から
外すと (b) が「消せない写し」に戻る
