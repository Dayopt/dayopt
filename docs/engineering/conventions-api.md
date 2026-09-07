---
status: current
last_verified: 2026-08-04
code: apps/product/src/features
---

# API 規約

tRPC + Zod による API バリデーション、service 層の skin-agnostic contract（7 原則 + per-service signature）、統一エラーパターン辞書。「コーディング規約は?」の API 部分（コアの feature/lib 規約は [`conventions.md`](./conventions.md)）。

---

## API バリデーション（Zod + tRPC）

Dayopt における Zod + tRPC による型安全な API バリデーションシステムの解説。

### システム構成

- **tRPC**: エンドツーエンド型安全 API
- **Zod**: ランタイムスキーマバリデーション
- **TanStack Query**: クライアント状態管理・キャッシュ

```
src/
├── server/api/              # tRPC サーバー設定
│   ├── root.ts             # メインルーター
│   ├── trpc.ts             # tRPC設定・ミドルウェア
│   └── routers/            # 各ルーター
├── schemas/api/            # Zod スキーマ定義
│   ├── common.ts           # 共通スキーマ
│   └── tasks.ts            # タスクスキーマ
└── lib/
    └── api/
        └── error-handler.ts # エラーハンドリング
```

### 基本的な使い方

#### 1. API定義（サーバー側）

```typescript
export const tasksRouter = createTRPCRouter({
  create: protectedProcedure
    .input(createTaskInputSchema) // Zod自動バリデーション
    .output(taskOutputSchema) // 出力型保証
    .mutation(async ({ input, ctx }) => {
      const task = await createTask(input);
      return task;
    }),
});
```

#### 2. スキーマ定義

```typescript
// src/schemas/api/tasks.ts
export const createTaskInputSchema = taskBaseSchema
  .omit({ status: true })
  .extend({
    dueDate: z.date().min(new Date(), '期限は現在時刻以降を指定してください').optional(),
  })
  .refine(
    (data) => {
      if (data.parentTaskId && !data.projectId) return false;
      return true;
    },
    {
      message: '親タスクがある場合はプロジェクトも指定してください',
      path: ['projectId'],
    },
  );
```

#### 3. クライアント側使用

```typescript
function TaskForm() {
  const { create } = useTaskOperations();

  const handleSubmit = (data: CreateTaskInput) => {
    create.mutate(data, {
      onSuccess: (task) => {
        /* 成功処理 */
      },
      onError: (error) => {
        /* エラー処理 */
      },
    });
  };
}
```

### スキーマ設計パターン

#### 1. 基本スキーマ

```typescript
export const taskBaseSchema = z.object({
  title: titleSchema,
  description: descriptionSchema,
  priority: prioritySchema,
  status: statusSchema,
  dueDate: futureDateSchema.optional(),
  estimatedHours: z.number().min(0.1).max(1000).optional(),
});
```

#### 2. 入力スキーマ（作成・更新）

```typescript
// 作成用（一部フィールド除外・追加バリデーション）
export const createTaskInputSchema = taskBaseSchema.omit({ status: true }).extend({
  dueDate: z.date().min(new Date()).optional(),
});

// 更新用（全フィールド任意・条件バリデーション）
export const updateTaskInputSchema = taskBaseSchema
  .partial()
  .extend({ id: idSchema })
  .refine((data) => {
    if (data.completed === true) {
      return data.progress === 100 || data.progress === undefined;
    }
    return true;
  });
```

#### 3. 出力スキーマ

```typescript
export const taskOutputSchema = taskBaseSchema.extend({
  id: idSchema,
  completed: z.boolean(),
  ...metadataSchema.shape,
});
```

#### 4. 型の再利用

```typescript
export type Task = z.infer<typeof taskSchema>;
export type CreateTaskInput = z.infer<typeof createTaskInputSchema>;
export type UpdateTaskInput = z.infer<typeof updateTaskInputSchema>;
```

### ベストプラクティス

#### エラーメッセージの日本語化

```typescript
z.string().min(1, 'タイトルは必須です').max(200, 'タイトルは200文字以内で入力してください');
```

#### バリデーションの分離

```typescript
export function validateTaskTitle(title: string): boolean {
  return titleSchema.safeParse(title).success;
}
```

#### 楽観的更新

```typescript
const updateTask = trpc.tasks.update.useMutation({
  onMutate: async (updateData) => {
    await utils.tasks.list.cancel();
    const previousTasks = utils.tasks.list.getData();

    utils.tasks.list.setData(previousTasks, (old) => ({
      ...old,
      tasks: old.tasks.map((task) =>
        task.id === updateData.id ? { ...task, ...updateData } : task,
      ),
    }));

    return { previousTasks };
  },
  onError: (error, updateData, context) => {
    if (context?.previousTasks) {
      utils.tasks.list.setData(context.previousTasks, context.previousTasks);
    }
  },
});
```

楽観的更新の詳細パターンは `optimistic-update` skill を参照。

### トラブルシューティング

#### Transform後のスキーマでメソッドが使用できない

```typescript
// ❌ 問題のあるコード
const schema = z
  .string()
  .transform((val) => val.trim())
  .min(1);

// ✅ 正しいコード（メソッドをtransformの前に）
const schema = z
  .string()
  .min(1)
  .transform((val) => val.trim());
```

#### UUIDバリデーションエラー

```typescript
// テストでは有効なUUIDを使用
const testId = '550e8400-e29b-41d4-a716-446655440000';
```

#### 日付バリデーションの不一致

```typescript
// 共通スキーマを使用して一貫性確保
import { futureDateSchema } from '@/schemas/api/common';
```

### テスト戦略

#### スキーマバリデーションテスト

```typescript
describe('タスクスキーマバリデーション', () => {
  it('正常なデータが検証をパスする', () => {
    const validInput: CreateTaskInput = {
      title: '新しいタスク',
      priority: 'medium',
    };
    expect(createTaskInputSchema.safeParse(validInput).success).toBe(true);
  });

  it('無効なデータで検証が失敗する', () => {
    const invalidInput = { title: '' };
    const result = createTaskInputSchema.safeParse(invalidInput);
    expect(result.success).toBe(false);
  });
});
```

#### API統合テスト

```typescript
describe('tRPC API統合テスト', () => {
  it('タスク作成APIが正常に動作する', async () => {
    const caller = tasksRouter.createCaller(mockContext);
    const result = await caller.create({
      title: 'テストタスク',
      priority: 'high',
    });
    expect(result.id).toBeDefined();
  });
});
```

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

##### `deleteAccount(options)` — L89

- input: `DeleteAccountOptions { userId, userEmail, password, confirmText }`
- output: `Promise<{ success: true }>`
- error: `UserServiceError(DELETE_FAILED | DELETE_DATA_FAILED | INVALID_INPUT | INVALID_PASSWORD)`
- side effect: **Stripe API (cancel subscriptions + delete customer)**, **Storage delete (avatars)**, **Supabase auth.admin.deleteUser** (RLS bypass via 内部 `createServiceRoleClient()`), logger
- 注: 原則 4 該当。JSDoc に副作用を明記する。

##### `deleteBlocks(userId)` — L179

- input: `userId: string`
- output: `Promise<{ deletedCount }>`
- error: `UserServiceError(DELETE_DATA_FAILED)`

##### `deleteAllData(userId)` — L200

- input: `userId: string`
- output: `Promise<{ success: true }>`
- error: `UserServiceError(DELETE_DATA_FAILED)`
- side effect: DB write（plans / records → activities / categories → settings の cascade delete）

##### `exportData(options)` — L237

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

##### `getBillingInfo(supabase, userId)` — L64

- output: `Promise<BillingInfo { subscriptionStatus, stripeCustomerId, subscriptionId }>`
- error: `BillingServiceError(FETCH_FAILED)`
- side effect: DB read

##### `createCheckoutSession(supabase, userId, email, priceId)` — L130

- output: `Promise<string>` (Checkout session URL)
- error: `BillingServiceError(CREATE_FAILED | UPDATE_FAILED)`
- side effect: **Stripe API**（customers.create + subscriptions.list + checkout.sessions.create）, DB write (`stripe_customer_id` 更新), `getAppUrl()` で base URL 取得

##### `createPortalSession(supabase, userId)` — L171

- output: `Promise<string>` (Portal session URL)
- error: `BillingServiceError(NOT_FOUND | INTERNAL_SERVER_ERROR)`
- side effect: **Stripe API**（billingPortal.sessions.create）

##### `getPaymentMethod(supabase, userId)` — L196

- output: `Promise<PaymentMethod | null>` (null は legitimate absence: 顧客 ID なし / 顧客削除済み / default PM なし)
- error: **Stripe API 失敗は throw（明示的 catch なし、propagate）**
- side effect: **Stripe API**（customers.retrieve + paymentMethods.retrieve）
- 注: 原則 7 準拠。null は absence、throw は failure。

##### `getInvoices(supabase, userId, limit? ★)` — L239

- output: `Promise<InvoiceItem[]>` (空配列は legitimate absence: 顧客 ID なし)
- error: Stripe API 失敗は throw
- side effect: **Stripe API**（invoices.list）
- pagination: `limit` を引数化 ★（current は固定 10）

##### `getBillingOverview(supabase, userId)` — L279

- output: `Promise<BillingOverview { billingInfo, paymentMethod, invoices }>`
- error: `BillingServiceError(FETCH_FAILED)` + Stripe API 失敗は throw
- side effect: DB read + **Stripe API**（getPaymentMethodByCustomerId + getInvoicesByCustomerId を並列）
- 注: 内部で profile を 1 回だけ fetch（N+1 解消済み）。getBillingInfo / getPaymentMethod / getInvoices の subscription_status read 重複ロジックを廃止して overview に集約する余地あり（Delta 参照）

##### `syncSubscriptionStatus(serviceRoleSupabase ★, stripeCustomerId, subscriptionId?, status)` — L375

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

## エラーパターン辞書

Dayopt の統一エラー管理システム。エラーコード体系、自動復旧、ユーザー通知、Sentry連携を提供する。

### エラーコード体系（7カテゴリ）

| カテゴリ       | コード範囲 | 例                                                                    |
| -------------- | ---------- | --------------------------------------------------------------------- |
| **AUTH**       | 1xxx       | `INVALID_TOKEN`(1001), `EXPIRED_TOKEN`(1002), `NO_PERMISSION`(1003)   |
| **VALIDATION** | 2xxx       | `REQUIRED_FIELD`(2001), `INVALID_FORMAT`(2002), `INVALID_EMAIL`(2004) |
| **DB**         | 3xxx       | `CONNECTION_FAILED`(3001), `QUERY_TIMEOUT`(3002), `NOT_FOUND`(3004)   |
| **BIZ**        | 4xxx       | ビジネスロジックエラー                                                |
| **EXTERNAL**   | 5xxx       | 外部サービス連携エラー                                                |
| **SYSTEM**     | 6xxx       | システム・インフラエラー                                              |
| **RATE**       | 7xxx       | レート制限エラー                                                      |

### 基本的な使い方

#### エラーの作成と処理

```typescript
import { createAppError, ERROR_CODES } from '@/config/error-patterns';
import { handleError } from '@/lib/error-handler';

const error = createAppError('ユーザーが見つかりません', ERROR_CODES.NOT_FOUND, {
  source: 'user-service',
  userId: 'user-123',
  context: { searchId: 'invalid-id' },
});

await handleError(error);
```

#### React Hookでの使用

```typescript
import { useErrorHandler } from '@/hooks/use-error-handler';

function UserProfile() {
  const { handleWithRecovery, errorState, clearError } = useErrorHandler();

  const loadUser = async () => {
    const result = await handleWithRecovery(
      () => fetch('/api/user/123').then((res) => res.json()),
      ERROR_CODES.API_UNAVAILABLE,
      { context: { component: 'UserProfile' } },
    );

    if (result.success) {
      setUser(result.data);
    }
  };

  return (
    <div>
      {errorState.hasError && (
        <ErrorNotification error={errorState.error} onDismiss={clearError} />
      )}
      <button onClick={loadUser}>ユーザーを読み込み</button>
    </div>
  );
}
```

### 自動復旧戦略

#### カテゴリ別リトライ設定

| カテゴリ | リトライ    | 戦略                       |
| -------- | ----------- | -------------------------- |
| AUTH     | 無効        | 認証エラーはリトライしない |
| DB       | 有効（3回） | 指数バックオフ + ジッター  |
| EXTERNAL | 有効（3回） | 指数バックオフ             |
| RATE     | 有効        | Retry-After ヘッダーに従う |

#### サーキットブレーカー

```typescript
{
  enabled: true,
  failureThreshold: 5,      // 5回失敗でOPEN
  recoveryTimeout: 30000,   // 30秒後に HALF_OPEN
  successThreshold: 3       // 3回成功で CLOSED
}
```

### ベストプラクティス

#### エラーコードの選択

```typescript
// ✅ 具体的なエラーコード
throw createAppError('Email format is invalid', ERROR_CODES.INVALID_EMAIL);

// ❌ 汎用的すぎるエラーコード
throw createAppError('Email format is invalid', ERROR_CODES.INVALID_FORMAT);
```

#### コンテキスト情報

```typescript
// ✅ 有用なコンテキスト（デバッグに必要な情報のみ）
const error = createAppError('User not found', ERROR_CODES.NOT_FOUND, {
  source: 'user-service',
  userId: requestedUserId,
  context: { searchCriteria: 'email' },
});

// ❌ 機密情報を含めない
const error = createAppError('Login failed', ERROR_CODES.INVALID_CREDENTIALS, {
  context: { password: 'user-password' }, // ❌ 絶対禁止
});
```

#### ユーザー向けメッセージ

```typescript
// ユーザー向けメッセージはエラーパターンから自動選択される
const error = createAppError(
  'Database connection timeout', // 技術的詳細（ログ用）
  ERROR_CODES.QUERY_TIMEOUT,
);
// → ユーザーには「処理がタイムアウトしました」と表示される
```

### Sentry連携

Sentry Issue は予期しない障害だけに限定する。validation、認証失敗、404、conflict、
rate limit などの想定内レスポンスは送信しない。tRPC / Next.js の中央adapterが扱う障害は
そこで一度だけcaptureし、個別のserviceから重ねて送らない。

中央adapterの外にあるError Boundaryなどでは、元の`Error`とstackを保持したまま
`captureUnexpectedError`を使う。付与できるのはfeature、operation、route、request IDなどの
技術コンテキストだけで、本文、email、検索語、認証情報、任意のmetadataは渡さない。
一般エラーに手動fingerprintは設定せず、Sentry標準のgroupingを使う。

```typescript
import { captureUnexpectedError } from '@/lib/sentry';

captureUnexpectedError(error, {
  feature: 'calendar',
  operation: 'load_entries',
  route: '/api/calendar',
});
```

### マイグレーション（従来 → エラーパターン）

```typescript
// ❌ Before: 手動エラー処理
try {
  const user = await fetchUser(id);
} catch (error) {
  console.error('Error fetching user:', error);
  toast.error('ユーザーの取得に失敗しました');
}

// ✅ After: エラーパターン辞書
try {
  const user = await fetchUser(id);
} catch (error) {
  await handleError(error, ERROR_CODES.API_UNAVAILABLE, {
    source: 'user-fetch',
    context: { userId: id },
  });
}
```

### エラーハンドリングフロー

#### フロントエンドエラー

```
エラー発生
  ↓
ErrorBoundary/FeatureErrorBoundary がキャッチ
  ↓
error-analysis.ts で分析
  ↓
error-patterns.ts からパターン取得
  ↓
ユーザーフレンドリーなメッセージ表示
  ↓
自動復旧可能？ → Yes: リトライ実行
                → No: フォールバック表示
```

#### API/サーバーエラー

```
エラー発生
  ↓
api/error-handler.ts でキャッチ
  ↓
エラーコード判定 (errorCodes.ts)
  ↓
適切なHTTPステータスコード返却
  ↓
クライアントでエラーパターン辞書から処理
```

#### グローバルエラー

```
未処理のエラー発生
  ↓
GlobalErrorBoundary がキャッチ
  ↓
Sentry統合 (sentry/integration.ts)
  ↓
自動復旧システム起動
  ↓
リトライ → 成功: アプリ続行
        → 失敗: エラー画面表示
```

### ディレクトリ構造

#### エラーパターン辞書

```
src/config/
├── error-patterns.ts          # メイン辞書（ErrorPattern, ERROR_PATTERNS, AppError）
└── error-patterns/            # 高機能版（将来の拡張用）
    ├── index.ts               # ErrorPatternDictionary
    ├── categories.ts          # 7カテゴリ定義
    ├── messages.ts            # ユーザー向けメッセージ
    └── recovery-strategies.ts # リトライ・サーキットブレーカー
```

#### エラーバウンダリー

```
src/components/
├── error-boundary.tsx              # ErrorBoundary, FeatureErrorBoundary
└── common/
    ├── GlobalErrorBoundary.tsx     # 全画面保護 + 自動復旧
    └── ErrorFallbacks.tsx          # Network/DB/API/UI/Auth別フォールバック
```

#### エラーページ

```
src/app/
├── not-found.tsx              # 404エラー
├── error.tsx                  # 500エラー
└── error/
    ├── 401/page.tsx           # 認証エラー
    ├── 403/page.tsx           # 権限エラー
    ├── 500/page.tsx           # サーバーエラー
    └── maintenance/page.tsx   # メンテナンス
```

### 新しいエラーパターンの追加

#### 1. エラーコード追加

```typescript
// src/constants/errorCodes.ts
export const ERROR_CODES = {
  // 既存のコード...
  NEW_ERROR: 4100, // 4000番台 = BIZカテゴリ
};
```

#### 2. パターン追加

```typescript
// src/config/error-patterns.ts
export const ERROR_PATTERNS: Record<number, ErrorPattern> = {
  [ERROR_CODES.NEW_ERROR]: {
    technical: '技術者向けメッセージ',
    userFriendly: 'ユーザー向けメッセージ',
    short: '短縮メッセージ',
    description: '詳細説明',
    recommendedActions: ['アクション1', 'アクション2'],
    autoRecoverable: false,
    urgency: 'medium',
    emoji: '⚠️',
  },
};
```

### DO / DON'T

#### DO

- エラーは必ずエラーパターン辞書に登録する
- カテゴリに応じた適切なエラーコードを使用する
- ユーザーフレンドリーなメッセージを提供する
- 自動復旧可能なエラーは積極的にリトライする

#### DON'T

- 汎用的な `try-catch` を乱用しない
- エラーメッセージに技術的な詳細を含めない
- エラーを握りつぶさない（必ずログ出力またはSentry送信）
- 同じエラーパターンを複数の場所で重複定義しない

エラーバウンダリーの詳細な自動復旧フローは [`conventions-frontend.md`](./conventions-frontend.md) の ErrorBoundary セクションを参照。
