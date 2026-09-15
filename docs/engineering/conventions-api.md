---
status: current
last_verified: 2026-09-16
code: apps/product/src/features
---

# API 規約

tRPC + Zod による API バリデーション、service 層の skin-agnostic contract（7 原則 + per-service signature）、統一エラーパターン辞書。「コーディング規約は?」の API 部分（コアの feature/lib 規約は [`conventions.md`](./conventions.md)）。

---

## API バリデーション（Zod + tRPC）

### どこに何があるか

feature-colocated。`src/server/api/` のような集約ディレクトリは無い。

| 置き場         | 実例                                                                                       |
| -------------- | ------------------------------------------------------------------------------------------ |
| router         | `features/{feature}/server/router.ts`（分割時は `plans-router.ts` のように責務名を付ける） |
| 入出力スキーマ | `features/{feature}/schemas/{feature}.ts`                                                  |
| service        | `features/{feature}/server/{name}-service.ts`。router からは `service-index.ts` 経由で取る |
| router の合成  | `app/api/trpc/_server/app-router.ts`                                                       |
| procedure 定義 | `lib/trpc/procedures.ts`（`protectedProcedure` / `entitledProcedure`）                     |
| エラー変換     | `lib/trpc/errors.ts` の `handleServiceError`                                               |

### 基本形

router は薄く保ち、入力検証を Zod、認可を `protectedProcedure`、実装を service に置く。

```typescript
// features/timeblock/server/plans-router.ts
export const plansRouter = createTRPCRouter({
  list: protectedProcedure
    .meta({ description: 'Plan list for the split time model' })
    .input(planFilterSchema.optional())
    .query(async ({ ctx, input }) => {
      const service = createPlanService(ctx.supabase);
      try {
        // userId は必ず spread の後に置く（filter に userId 名の field が生えても ctx が勝つ）
        return await service.list({ ...input, userId: ctx.userId });
      } catch (error) {
        handleServiceError(error);
      }
    }),
});
```

**`ctx.userId` は spread の後に置く。** MCP の読み取りは service-role client で tRPC を呼ぶため
RLS が効かず、テナント分離はこの 1 行に依存する（`lib/test/integration/mcp-read-tenant-isolation.integration.test.ts`
が全 read 経路で回帰を見る）。

### スキーマ

`.strict()` を付けて未知 field を落とす。日時は offset 付き ISO 8601 で受ける。

```typescript
// features/timeblock/schemas/timeblock.ts
export const planFilterSchema = z
  .object({
    ids: z.array(z.string().uuid()).max(100).optional(),
    activityId: z.string().uuid().optional(),
    startDate: z.string().datetime({ offset: true }).optional(),
    endDate: z.string().datetime({ offset: true }).optional(),
    limit: z.number().min(1).max(100).optional(),
  })
  .strict();
```

MCP tool が同じ procedure を使う場合、tool 側の入力スキーマは
`app/api/mcp/_tools/` に別途あり、契約 snapshot（`contract-snapshot.test.ts`）で固定する。
tool 間で受理集合を揃えること（#2721 D-04）。

### エラー

service は `ServiceError` を投げ、router は `handleServiceError` に渡す。予期しない失敗だけが
Sentry へ行き、client には `serviceCode` だけが返る（詳細は本ファイル §エラーパターン辞書）。

### zod の version

`apps/product` は v3 系、`apps/web` は v4 系に固定。app 間でスキーマを共有しない（`AGENTS.md`）。

### テスト

router / service の単体は対象ファイルの隣に `X.test.ts`（`test` skill）。認可とテナント境界は
`lib/test/integration/` の integration で実 DB に対して確認する。

---

## Service 層 Contracts（skin-agnostic target shape）

作成: 2026-05-12 | 前段: 決定ログ（削除済み、git 履歴参照）

Dayopt の service 層は tRPC 以外の skin（MCP server, Stripe webhook REST handler 等）からも呼ばれる。
target contract が明文化されていないと各 skin が場当たり的に service を呼び、歪みが skin の数だけ増殖する。
本セクションは service 層の "正解の形" を decide し、新しい skin が contract に沿って呼べるようにする。

### なぜ shape を decide するか

Dayopt の service 層は近い将来、tRPC 以外の skin（MCP server を含む）からも呼ばれる。
**target contract が明文化されていないと、各 skin が場当たり的に service を呼び、
歪みが skin の数だけ増殖する**。本セクションは service 層の "正解の形" を decide して、
新しい skin（MCP / REST endpoint / 将来の何か）が contract に沿って呼べるようにする。

### Skin-agnostic 7 原則

| #   | 原則                                                                                                                                          | Why                                                                                                  | 現状                                                         |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| 1   | **viewer context は引数で渡す** — `userId` を string 引数で受け取る。framework ctx を service に渡さない                                      | skin が違っても viewer は同じ概念。framework ctx に依存すると skin 毎に shim が要る                  | 全 method 準拠 ✓                                             |
| 2   | **framework object を import / touch しない** — `Request`, `NextRequest`, `NextResponse`, tRPC `Context` を service が知らない                | 上記の必然。一度でも触ると skin 切替時に依存が漏れる                                                 | 全 service 準拠 ✓                                            |
| 3   | **error は domain typed (`ServiceError` 系列) で throw** — framework error (`TRPCError`, `NextResponse`) は router 層で wrap                  | skin が error の表現を decide する責務を持つ。service は「何が起きたか」だけを表現                   | 全 service 準拠 ✓                                            |
| 4   | **side effect は signature と doc に明示** — DB read/write 以外の I/O（Stripe API, GitHub API 等）は JSDoc に列挙                             | 副作用が暗黙だと skin 設計（retry / idempotency / rate limit）が組めない                             | doc 化未徹底（実装は準拠）                                   |
| 5   | **時刻 / 地域依存は引数で受ける** — timezone は計算の入力として渡す。受けなければ service が DB から fetch                                    | skin が timezone を知っている場合（MCP の OAuth claim 等）渡したい。skin agnostic な fallback も維持 | write 系のみ部分準拠、read 系は service が DB fetch          |
| 6   | **pagination は contract で表明** — 結果が "N 件以上ありうる" method は limit / cursor / offset を持つ。"全件取得" を仕様とする method は明記 | skin がメモリ / レスポンスサイズの制約を予測できる                                                   | 不揃い（後述 delta）                                         |
| 7   | **legitimate absence と failure を区別** — 「データが無い」は null / 空配列で返してよい。「外部 API 失敗 / DB エラー」は throw する           | skin の error UI と "no data" UI を別の経路で扱える                                                  | Timeblock service と BillingService は準拠。明文化を継続する |

#### 取らないと decide したもの

- **locale**: service 引数として受けない。server 層は i18n せず raw を返す（`CLAUDE.md` / `code-style.md` と整合）。skin 側 / UI 側で format する。
- **構造統一**: class+factory / factory→object / standalone function の混在は shape の本質ではない。`factory function を export し、call site が呼びやすければよい` とだけ規定する。ContactService が standalone function でも、UserService が factory→object でもよい。

### Per-service target signature

各 method の target shape を明記する。current が target と異なる箇所は **★** で印を付け、Delta セクションで対応 action を書く。

#### PlanService / RecordService

- files: `src/features/timeblock/server/plan-service.ts` / `record-service.ts`
- 構造: `class PlanService` / `class RecordService` + 同名 factory
- error: 共通の `TimeblockServiceError extends ServiceError`
- skins: tRPC の `plans` / `records` router。公開契約も同じ namespace を正本にする

##### 共通 CRUD

- `list(options)`: `userId` と任意の tag / search / overlap range / sort / limit / offset を受け、active row の配列を返す。DB failure は `FETCH_FAILED`、空配列は legitimate absence
- `getById(options)`: `userId` + entity id で active row を取得し、無ければ `NOT_FOUND`
- `create(options)`: `userId` + `input` + 同一レーン overlap guard を受ける。Record は `end_at <= now` を要求する（`DT005`）。Plan は時間の制約なし
- `update(options)`: optimistic lock と同一レーン overlap guard を適用する。Plan の時間 field は過去・未来問わず変更可、Record は `end_at` を未来へ動かす更新のみ拒否する（`DT005`）
- `delete` / `restore`: Record 名・Plan 名の RPC を介した soft delete / restore

##### Plan 固有操作

- `skip` / `unskip`: Plan の未実行状態を更新する（過去・未来を問わない）。active Record がある Plan は skip しない
- `record`: 過去 Plan から `source = 'from_plan'` の Record を1件作る
- `confirmDay`: `confirm_day_plans_to_records` で指定 range の未記録 Plan を一括確定する

全 method は `userId` を明示入力に持ち、service 内でも row filter / RPC parameter に渡す。Plan と Record の1:N、時間重複、Record の未来終了禁止は service と DB constraint の両方で守る。

#### UserService

- file: `src/features/auth/server/user-service.ts`
- 構造: `createUserService(supabase)` factory が object を返す
- error: `UserServiceError extends ServiceError`
- skins: tRPC のみ

##### `deleteAccount(options)`

- input: `DeleteAccountOptions { userId, userEmail, password, confirmText }`
- output: `Promise<{ success: true }>`
- error: `UserServiceError(DELETE_FAILED | DELETE_DATA_FAILED | INVALID_INPUT | INVALID_PASSWORD)`
- side effect: **Stripe API (cancel subscriptions + delete customer)**, **Storage delete (avatars)**, **Supabase auth.admin.deleteUser** (RLS bypass via 内部 `createServiceRoleClient()`), logger
- 注: 原則 4 該当。JSDoc に副作用を明記する。

##### `deleteBlocks(userId)`

- input: `userId: string`
- output: `Promise<{ deletedCount }>`
- error: `UserServiceError(DELETE_DATA_FAILED)`

##### `deleteAllData(userId)`

- input: `userId: string`
- output: `Promise<{ success: true }>`
- error: `UserServiceError(DELETE_DATA_FAILED)`
- side effect: DB write（plans / records → activities / categories → settings の cascade delete）

##### `exportData(options)`

- input: `ExportDataOptions { userId }`
- output: `Promise<ExportDataResult { exportedAt, userId, data: { profile, plans, records, categories, activities, userSettings } }>`
- error: `UserServiceError(EXPORT_FAILED)`
- side effect: DB read（5 テーブル並列 fetch）

#### ContactService

- file: `src/features/contact/server/contact-service.ts`
- 構造: standalone function（class / factory なし）
- error: `ServiceError`（base、subclass なし）
- skins: tRPC のみ

##### `sendContactEmail(params)` / `deliverContactFeedback(params)`

- input: `ContactEmailParams { userEmail, userName, input: ContactFormInput }`
- output: `sendContactEmail`は`Promise<void>`、adapterは`Promise<{ delivered: true }>`
- error: `ServiceError(CONTACT_DELIVERY_FAILED)`またはtimeoutの`Error`
- side effect: **Resend Email API**（固定To / From / 件名、Reply-To、source tag、idempotency key）, Production envのResend設定読取
- 注: 原則 4 該当。JSDoc に副作用を明記する。

#### BillingService

- file: `src/features/settings/server/billing-service.ts`
- 構造: standalone functions（Supabase / Stripe を引数で受ける）
- error: `BillingServiceError extends ServiceError`
- skins: tRPC (`billing-router.ts`) + REST (`src/app/api/webhooks/stripe/route.ts`)

##### `getBillingInfo(supabase, userId)`

- output: `Promise<BillingInfo { subscriptionStatus, stripeCustomerId, subscriptionId }>`
- error: `BillingServiceError(FETCH_FAILED)`
- side effect: DB read

##### `createCheckoutSession(supabase, userId, email, priceId)`

- output: `Promise<string>` (Checkout session URL)
- error: `BillingServiceError(CREATE_FAILED | UPDATE_FAILED)`
- side effect: **Stripe API**（customers.create + subscriptions.list + checkout.sessions.create）, DB write (`stripe_customer_id` 更新), `getAppUrl()` で base URL 取得

##### `createPortalSession(supabase, userId)`

- output: `Promise<string>` (Portal session URL)
- error: `BillingServiceError(NOT_FOUND | INTERNAL_SERVER_ERROR)`
- side effect: **Stripe API**（billingPortal.sessions.create）

##### `getPaymentMethod(supabase, userId)`

- output: `Promise<PaymentMethod | null>` (null は legitimate absence: 顧客 ID なし / 顧客削除済み / default PM なし)
- error: **Stripe API 失敗は throw（明示的 catch なし、propagate）**
- side effect: **Stripe API**（customers.retrieve + paymentMethods.retrieve）
- 注: 原則 7 準拠。null は absence、throw は failure。

##### `getInvoices(supabase, userId, limit? ★)`

- output: `Promise<InvoiceItem[]>` (空配列は legitimate absence: 顧客 ID なし)
- error: Stripe API 失敗は throw
- side effect: **Stripe API**（invoices.list）
- pagination: `limit` を引数化 ★（current は固定 10）

##### `getBillingOverview(supabase, userId)`

- output: `Promise<BillingOverview { billingInfo, paymentMethod, invoices }>`
- error: `BillingServiceError(FETCH_FAILED)` + Stripe API 失敗は throw
- side effect: DB read + **Stripe API**（getPaymentMethodByCustomerId + getInvoicesByCustomerId を並列）
- 注: 内部で profile を 1 回だけ fetch（N+1 解消済み）。getBillingInfo / getPaymentMethod / getInvoices の subscription_status read 重複ロジックを廃止して overview に集約する余地あり（Delta 参照）

##### `syncSubscriptionStatus(serviceRoleSupabase ★, stripeCustomerId, subscriptionId?, status)`

- output: `Promise<void>`
- error: `BillingServiceError(UPDATE_FAILED)`
- side effect: DB write（`profiles` UPDATE by `stripe_customer_id`）
- 注: **RLS bypass 必須**。引数名を `supabase` → `serviceRoleSupabase` に rename して JSDoc で必須を強調する ★（型 branding はしない）

`getPaymentMethod` / `getInvoices` の null / 空配列は **legitimate absence**（顧客 ID なし等）。Stripe API 失敗は throw（原則 7 準拠）。

### Current → Target Delta

7 原則のうち current が満たしていない箇所。**file:line で裏取れる事実のみ列挙**。各 delta は後続の個別 plan で対応する。本セクションは scope を decide するだけ。

#### Delta 1: `BillingService.getInvoices` の pagination 表明

- 原則 6 違反: `billing-service.ts:239` で `limit=10` ハードコード（`billing-service.ts:252`）。
- Target: `getInvoices(supabase, userId, limit?: number = 10)` に signature 変更。
- 影響: 既存 caller は引数省略でそのまま動く。breaking change なし。

#### Delta 2: `syncSubscriptionStatus` の RLS bypass 表明

- 原則 4 半違反: `billing-service.ts:375` の現 signature は `supabase: SupabaseClient<Database>`。コメント (`billing-service.ts:373`) で「createServiceRoleClient() 経由を使用すること（RLSバイパス）」と指示。
- Target: 引数名を `serviceRoleSupabase: SupabaseClient<Database>` に rename + JSDoc で「**MUST be created via `createServiceRoleClient()` to bypass RLS**」と強調。
- 影響: 引数名変更のみ、type は同じ。呼び出し側の named arg 使用箇所のみ修正（`src/app/api/webhooks/stripe/route.ts:249, 306, 361` を check）。

#### Delta 3: `BillingService.getBillingOverview` 内の subscription_status read 重複

- 原則違反ではない（構造課題）。`billing-service.ts:79, 81` と `:294, 296` で同パターンの subscription_status / subscription_id read が二重実装。
- Target: 重複を internal helper に統合。
- 影響: 純粋に internal refactor。skin agnostic とは独立だが記録として残す。
- 注: 本 delta は **shape 違反ではなく内部実装の重複**。後続 plan で扱うかどうかは ROI で判断。

#### Delta 4: 副作用の JSDoc 明示（全 service 横断）

- 原則 4 違反: side effect を持つmethod（特にStripe / email APIを呼ぶもの）のJSDocに副作用列挙が不徹底。
- 対象（"★" を付けていないが原則 4 該当）:
  - `UserService.deleteAccount` — Stripe + Storage + Auth admin + RLS bypass
  - `ContactService.sendContactEmail` — Resend Email API + env vars
  - `BillingService.createCheckoutSession` / `createPortalSession` — Stripe API
  - `BillingService.getPaymentMethod` / `getInvoices` / `getBillingOverview` — Stripe API
- Target: 各 method の JSDoc 冒頭に `@sideEffect` 形式（or 自然文）で外部 I/O を列挙。
- 影響: JSDoc 追加のみ、コード挙動変化なし。

#### Delta 5: shape 違反ではない既知の構造課題（記録のみ）

本 delta セクションの対象外。後続 plan で別途扱う:

- `statistics-*.ts` など、router / service の責務分離が未完了な箇所は個別 issue で扱う

### 構造の不揃いについての判断

class+factory / factory→object / standalone function の混在は **shape の本質ではない** ため統一しない（YAGNI）。

- ContactService が standalone function でもよい
- UserService が factory→object でもよい
- 他 service を class 化に揃えるための refactor は対象外

規定は「factory function（or 等価な構成）を export し、call site が呼びやすい signature を持つ」だけ。

### 未決定で残す事項

shape の話ではなく後続 plan で扱う:

- `entitledProcedure` middleware の `ctx.subscriptionStatus` を service が読むべきか → 現状読まないので問題なし（badges 削除済み）
- method 単位の 1:1 結合度の細部 → 必要が出たときに測る
- `statistics.ts` 系（`statistics-service.ts` / `statistics-kpi-service.ts` 等）の service 層分離 → 構造課題、shape とは別

### 参照する既存定義（再定義しない）

- `src/lib/trpc/errors.ts:16-119` — `ServiceError` 階層と code enum
- `src/features/timeblock/server/timeblock-types.ts` — `ListPlansOptions`, `CreatePlanOptions`, `UpdatePlanOptions`, `DeletePlanOptions`, `GetPlanByIdOptions`, `RecordPlanOptions`, `ConfirmDayPlansOptions` と、Record 側の同型（`ListRecordsOptions` 他）。`server/types.ts` は `ServiceSupabaseClient` だけを持つ
- `src/features/auth/server/user-service.ts` — `DeleteAccountOptions`, `DeleteAccountResult`, `ExportDataOptions`, `ExportDataResult`
- `src/features/settings/server/billing-service.ts:18-` — `BillingInfo`, `PaymentMethod`, `InvoiceItem`, `BillingOverview`, `SubscriptionStatus`
- `src/features/contact/server/contact-service.ts` — `CreateIssueParams`, `CreateIssueResult`, `ContactFormInput`

### このセクションの使い方

1. **新しい skin（MCP / REST endpoint）を実装する時**: Per-service signature を contract として呼び出す。7 原則に違反する形で service を呼ばない。
2. **既存 method の signature 変更を検討する時**: 7 原則に整合するか check してから変更する。
3. **Delta を解消する時**: 各 delta を独立した plan として切る（本セクションは scope decision まで）。
4. **service の追加 / 削除時**: Per-service signature に entry を追加 / 削除する。同時に 7 原則準拠を確認する。

---

## エラー処理

**2026-09-16 にこの節を書き直した。** それまでは `@/config/error-patterns` の 7 カテゴリ辞書、`createAppError` / `ERROR_CODES`、`error-analysis.ts`、`GlobalErrorBoundary` / `ErrorFallbacks`、`app/error/{401,403,500}/` を前提に 200 行あったが、**どれも実装されていない**（`rg` で 0 件）。読んだ人が存在しない API を書こうとするため撤去した。

### 実在するもの

| 役割                         | 実体                                                                                                              |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| service 層のエラー           | `ServiceError`（`src/lib/trpc/errors.ts`）とその feature 別の派生                                                 |
| service コード → tRPC コード | `ERROR_CODE_MAP`（`src/lib/trpc/error-code-map.ts`）                                                              |
| client へ出してよいコード    | `src/lib/trpc/client-safe-service-code.ts` の allowlist                                                           |
| UI の捕捉                    | `src/components/ui/feedback/error-boundary.tsx`、App Router の `error.tsx` / `global-error.tsx` / `not-found.tsx` |
| 監視への送信                 | `src/lib/sentry/`（`integration.ts` ほか）                                                                        |

DB 側のエラーコード（`DT001`〜）の一覧と app 側の参照箇所は [`data/system-surface.md`](./data/system-surface.md) の生成表を見る。

### 書き方

正規化・Sentry 送信・ユーザー通知・自動復旧の組み合わせ方は [`error-handling` skill](../../.agents/skills/error-handling/SKILL.md) が正本。ここでは重複させない。

- service は `ServiceError`（またはその派生）を throw し、router は `handleServiceError` に渡す
- 新しい service コードを足したら `ERROR_CODE_MAP` に対応を足す。載せ忘れると `INTERNAL_SERVER_ERROR` に落ちる
- UI が code で分岐する必要があるものは client-safe allowlist に載せる。載せないと汎用文言へ退化する

### DO / DON'T

- service が投げるコードは呼び出し側が分岐に使える名前にする（`FETCH_FAILED` のような汎用名は最後の手段）
- 新しいコードは `ERROR_CODE_MAP` に必ず対応を足す（載せ忘れは `INTERNAL_SERVER_ERROR` に落ちる）
- エラーを握りつぶさない。ログか Sentry のどちらかには必ず出す
- ユーザー向け文言に技術的な詳細を載せない。文言は i18n 側に置く
- 同じ判定を service と UI の両方に書かない（写しの扱いは [invariants.md](./invariants.md) §時刻 の分類に倣う）

UI 側の ErrorBoundary の置き方は [`conventions-frontend.md`](./conventions-frontend.md) を参照。
