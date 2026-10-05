---
status: current
last_verified: 2026-09-16
code: apps/product/src/features
---

# API 規約

tRPC + Zod による API バリデーション、service 層の skin-agnostic contract（7 原則 + 実装への参照）、統一エラーパターン辞書。「コーディング規約は?」の API 部分（コアの feature/lib 規約は [`conventions.md`](./conventions.md)）。

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

| #   | 原則                                                                                                                                          | Why                                                                                                  |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 1   | **viewer context は引数で渡す** — `userId` を string 引数で受け取る。framework ctx を service に渡さない                                      | skin が違っても viewer は同じ概念。framework ctx に依存すると skin 毎に shim が要る                  |
| 2   | **framework object を import / touch しない** — `Request`, `NextRequest`, `NextResponse`, tRPC `Context` を service が知らない                | 上記の必然。一度でも触ると skin 切替時に依存が漏れる                                                 |
| 3   | **error は domain typed (`ServiceError` 系列) で throw** — framework error (`TRPCError`, `NextResponse`) は router 層で wrap                  | skin が error の表現を decide する責務を持つ。service は「何が起きたか」だけを表現                   |
| 4   | **side effect は signature と doc に明示** — DB read/write 以外の I/O（Stripe API, GitHub API 等）は JSDoc に列挙                             | 副作用が暗黙だと skin 設計（retry / idempotency / rate limit）が組めない                             |
| 5   | **時刻 / 地域依存は引数で受ける** — timezone は計算の入力として渡す。受けなければ service が DB から fetch                                    | skin が timezone を知っている場合（MCP の OAuth claim 等）渡したい。skin agnostic な fallback も維持 |
| 6   | **pagination は contract で表明** — 結果が "N 件以上ありうる" method は limit / cursor / offset を持つ。"全件取得" を仕様とする method は明記 | skin がメモリ / レスポンスサイズの制約を予測できる                                                   |
| 7   | **legitimate absence と failure を区別** — 「データが無い」は null / 空配列で返してよい。「外部 API 失敗 / DB エラー」は throw する           | skin の error UI と "no data" UI を別の経路で扱える                                                  |

#### 取らないと decide したもの

- **locale**: service 引数として受けない。server 層は i18n せず raw を返す（`CLAUDE.md` / `code-style.md` と整合）。skin 側 / UI 側で format する。
- **構造統一**: class+factory / factory→object / standalone function の混在は shape の本質ではない。`factory function を export し、call site が呼びやすければよい` とだけ規定する。ContactService が standalone function でも、UserService が factory→object でもよい。

### 現行 service の契約を読む

method 名、引数、返り値、error、副作用、公開 / internal の区別は実装を正本とする。呼び出す前に export / 型 / JSDoc と caller を読む。ここには signature や実装の行番号を複製しない。

| 領域                     | 実装の正本                                                                                                                                                                                                                 | 意味の正本                                                                                |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Plan / Record の読み取り | [plan-service.ts](../../apps/product/src/features/timeblock/server/plan-service.ts)、[record-service.ts](../../apps/product/src/features/timeblock/server/record-service.ts)                                               | [Plan / Record 仕様](../product/specs/plan-record.md)                                     |
| Plan / Record の書き込み | [timeblock-command-service.ts](../../apps/product/src/features/timeblock/server/timeblock-command-service.ts)、[timeblock-command-client.ts](../../apps/product/src/features/timeblock/server/timeblock-command-client.ts) | [保存モデル](../product/specs/plan-record.md#保存モデル)、[時間不変条件](./invariants.md) |
| アカウント               | [user-service.ts](../../apps/product/src/features/auth/server/user-service.ts)                                                                                                                                             | [認証仕様](../product/specs/auth.md)                                                      |
| 問い合わせ               | [contact-service.ts](../../apps/product/src/features/contact/server/contact-service.ts)                                                                                                                                    | [問い合わせメール運用](../operations/contact-email.md)                                    |
| 課金                     | [billing-service.ts](../../apps/product/src/features/settings/server/billing-service.ts)                                                                                                                                   | [課金仕様](../product/specs/billing.md)                                                   |

Plan / Record の独立保存と明示的な Record 作成は仕様で判断する。旧 skip 操作や保存上の 1:N 対応を service の契約として復活させない。公開 router / procedure と service の探索には [Architecture Inventory](./data/architecture-inventory.md) を使う。

### Target 設計の検討観点

以下は service の設計で守りたい意味と改善候補であり、現在の実装が未対応だという判定ではない。着手時に上の正本と caller を照合し、既に解消済みなら変更しない。個別の実装方針・採否・検証は Issue / PR に残す。

- **pagination を表明する（原則 6）**: 請求書など件数が増えうる結果は、取得範囲・上限を contract で明示する。呼び出し側で範囲の指定が必要なら引数化を検討し、既存 caller の互換性を確かめる。internal helper を独立した公開 API とみなさない。
- **RLS bypass を明示する（原則 4）**: service-role client が必要な処理は、引数名と JSDoc からその境界を読めるようにする。型 branding の一律導入は要求しない。
- **読み取りの重複を減らす**: 課金情報の取得で同じ profile を繰り返し読む必要があれば internal helper への集約を検討する。shape 違反とは区別し、変更の価値を判断する。
- **副作用を JSDoc に明示する（原則 4）**: Stripe / Resend / Storage / Auth admin などの外部 I/O と RLS bypass を列挙する。null / 空配列で表す legitimate absence と外部 API / DB failure を区別する（原則 7）。
- **router / service の分離を保つ**: 統計などの責務分離は個別に判断する。構造課題だけを理由に service の形を一律に置き換えない。

### 構造の不揃いについての判断

class+factory / factory→object / standalone function の混在は **shape の本質ではない** ため統一しない（YAGNI）。

- ContactService が standalone function でもよい
- UserService が factory→object でもよい
- 他 service を class 化に揃えるための refactor は対象外

規定は「factory function（or 等価な構成）を export し、call site が呼びやすい signature を持つ」だけ。

### 未決定で残す事項

shape の話ではなく後続 plan で扱う:

- `entitledProcedure` middleware の `ctx.subscriptionStatus` を service が読むべきか → 必要性と境界を caller / service の実装で確認する
- method 単位の 1:1 結合度の細部 → 必要が出たときに測る
- `statistics.ts` 系（`statistics-service.ts` / `statistics-kpi-service.ts` 等）の service 層分離 → 構造課題、shape とは別

### 参照する既存定義（再定義しない）

型と error 定義は上記 service の import 元から辿る。共通 error の正本は [errors.ts](../../apps/product/src/lib/trpc/errors.ts)、Timeblock の読み取り型は [timeblock-types.ts](../../apps/product/src/features/timeblock/server/timeblock-types.ts)。書き込みの型は command の実装から確認する。

### このセクションの使い方

1. **新しい skin（MCP / REST endpoint）を実装する時**: 実装の export / 型 / JSDoc を読み、7 原則に沿って呼び出す。
2. **既存 method の signature 変更を検討する時**: 意味の仕様、7 原則、caller の互換性を確認する。
3. **改善候補へ着手する時**: 現行実装との差を確かめ、個別 Issue / PR に最小の変更と検証を残す。
4. **service の追加 / 削除時**: 実装と意味の正本を更新し、必要ならこの参照入口も更新する。signature の写しを追加しない。

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
