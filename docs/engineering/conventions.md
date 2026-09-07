---
status: current
last_verified: 2026-08-04
code: apps/product/src
---

# コーディング規約（コア）

Dayopt の feature / lib / shell の責務境界、設計パターン、`domain/` と `server/` の使い分け、`src/lib` の置き場ルール。「コーディング規約は?」の正の一部（API 規約は [`conventions-api.md`](./conventions-api.md)、frontend 規約は [`conventions-frontend.md`](./conventions-frontend.md)）。

---

## Code Organization

`ADR-012 Feature-Sliced Architecture` と `Feature Boundaries`（AGENTS.md / `pr-cross-review` skill）の運用面を補完する。

### 3 つの結論（前提）

cross-layer types owner cleanup シリーズ（#1222〜#1232）で確定した 3 原則:

1. **domain は全 feature 必須ではない** — pure logic が無い feature には domain は無いのが正しい状態
2. **RPC / DB response transformer は domain ではなく server** — shape 密結合の adapter は server サブレイヤーに置く
3. **`src/lib` は便利箱ではなく feature 非依存の基盤** — feature を import しない一方向ルールを死守

### Feature 標準ディレクトリ構造

```
features/{name}/
  index.ts          # barrel（公開 API、明示的 named export のみ）
  components/       # React component（feature 固有 UI）
  hooks/            # React hook（feature 固有）
  stores/           # Zustand store（feature 内 client-side state）
  domain/           # pure logic（DB / React / store / TZ 非依存）
  lib/              # feature 固有の helper（色 const / utility）
  server/           # tRPC router / service / adapter（DB access あり）
  schemas/          # Zod schema（必要時のみ）
  types/            # 型定義（DB row / domain type の re-export 含む）
```

**全部存在する必要はない。必要なサブディレクトリだけ作る** のが原則。

#### 各サブディレクトリの責務

| サブディレクトリ | 置くもの                                                | 置かないもの                                                |
| ---------------- | ------------------------------------------------------- | ----------------------------------------------------------- |
| `components/`    | feature 固有の React component                          | shadcn 系の primitive（→ `lib/components/ui/`）             |
| `hooks/`         | feature 固有の React hook                               | 他 feature でも使う汎用 hook（→ `lib/hooks/`）              |
| `stores/`        | feature 内で完結する client state                       | 複数 feature が参照する UI state（→ `lib/stores/`）         |
| `domain/`        | pure logic（業務 rule、計算、validation）               | DB / RPC / React に依存するもの、shape 密結合の transformer |
| `lib/`           | feature 固有の helper（色 const、enum mapping、helper） | pure business rule（→ `domain/`）                           |
| `server/`        | tRPC router、service、RPC↔tRPC adapter                  | UI / hook / store                                           |
| `schemas/`       | Zod schema                                              | TypeScript 型のみ（→ `types/`）                             |
| `types/`         | DB row / domain type の re-export                       | 実装を伴う logic                                            |

### なぜ全 feature に domain を作らないか

> domain を作ること自体が目的ではない。「テストしたい挙動 / 共有したいルール」がそこにあるかで判断する。

#### domain を作る基準

- pure aggregation / pure transformation / pure validation が **複数箇所で参照される** または **単体テストで凍結すべき挙動を持つ**
- feature の business rule（merge 制約、streak 計算、planned vs actual 判定）が pure logic として表現できる

#### domain を作らない判断（実例）

| Feature    | 理由                                                                              |
| ---------- | --------------------------------------------------------------------------------- |
| `contact`  | serviceへの入力受け渡しが中心で、独立したpure domain ruleが薄い                   |
| `settings` | composition なので business rule は外部 feature が持つ。settings 自体は rule なし |

「pure logic が無い feature には domain が無い」のが正しい状態。無理に domain を切ると逆に追跡コストが増える。

#### domain を作った判断（実例）

| Feature      | domain の中身                                                                                            |
| ------------ | -------------------------------------------------------------------------------------------------------- |
| `timeblock`  | `timeblock-destination` / `estimation-accuracy` / `plan-template-compose` / `activity-estimation-factor` |
| `activities` | `activity-tree-cache`                                                                                    |
| `review`     | `variance` / `timePL/`（薄い構成）                                                                       |

### DAG Layer

```
Layer 0 (基盤):       activities
Layer 1 (中核):       timeblock, external-calendar
Layer 2 (体験):       calendar, review
Independent:          auth, contact
Composition:          settings  (= 通常 feature DAG には乗せない)
```

詳細は `Feature Boundaries`（AGENTS.md / `pr-cross-review` skill）を参照。

### Calendar Hub（暫定運用）

`features/calendar` は views / tag-filter / navigation / interaction を内部に同居させた hub feature。launch 前の解体リスクを避けるため、blast radius を hub 内部に閉じる運用。

- barrel は「ページから見た public API」のみを export
- 子 feature 化（`calendar-view` / `calendar-filter` / `calendar-interaction`）は launch 後に検討
- 子featureへの分割は現時点でactiveな取り組みではない。着手時に epic issue 本文へ設計を書く

---

## 設計パターン

### ディレクトリ構造: Feature-based

```
src/
├── app/           # Next.js App Router（ルーティング）
├── features/      # 機能ごとのモジュール
├── components/    # 共通コンポーネント
├── hooks/         # 共通フック
├── lib/           # ユーティリティ
├── platform/      # tRPC・Supabase等の基盤
└── types/         # 型定義
```

#### features/ の構造

```
features/
├── calendar/      # カレンダー機能
│   ├── components/
│   ├── hooks/
│   ├── stores/
│   └── types/
├── timeblock/     # Plan / Record の時間管理
├── activities/    # アクティビティ管理
└── ...
```

**なぜ Feature-based か**: 機能の追加・削除が容易、関連コードが近くにある、大規模アプリでもスケール。

### API層: Router → Service → Supabase

```
┌─────────────┐
│   Router    │ ← 入出力の定義、認証チェック
├─────────────┤
│   Service   │ ← ビジネスロジック
├─────────────┤
│  Supabase   │ ← データアクセス
└─────────────┘
```

API 契約・エラーパターンの詳細は [`conventions-api.md`](./conventions-api.md) を参照。

#### Router（薄い層）

```typescript
// src/features/timeblock/server/records-router.ts
create: protectedProcedure
  .input(createRecordSchema) // Zodでバリデーション
  .mutation(({ ctx, input }) => {
    const service = createRecordService(ctx.supabase);
    return service.create({ userId: ctx.userId, input });
  });
```

**役割**: 入力バリデーション（Zod）、認証・認可チェック、Serviceの呼び出し。

#### Service（ビジネスロジック）

```typescript
// src/features/timeblock/server/record-service.ts
class RecordService {
  async create(options: CreateRecordOptions) {
    this.validateRange(options.input.start_at, options.input.end_at);
    return this.supabase.from(databaseTables.records).insert({
      user_id: options.userId,
      ...options.input,
    });
  }
}
```

**なぜ Service 層を分けるか**: テストしやすい（DB をモックできる）、ロジックの再利用、Router を薄く保てる。

### 状態管理: UI状態 vs サーバー状態

#### UI状態（Zustand）

```typescript
export const useCalendarStore = create(
  devtools(
    persist(
      (set) => ({
        view: 'week',
        setView: (view) => set({ view }),
      }),
      { name: 'calendar-store' },
    ),
  ),
);
```

**使うべき場面**: サイドバーの開閉、選択中のアイテム、フィルター条件、表示設定。

#### サーバー状態（TanStack Query via tRPC）

```typescript
const { data: plans, isLoading } = api.plans.list.useQuery({
  startDate,
  endDate,
});
```

**使うべき場面**: サーバーから取得したデータ、一覧表示、詳細データ。

状態管理の詳細な使い分けは [`conventions-frontend.md`](./conventions-frontend.md) を参照。

### コンポーネント: Presentational + Container

#### Presentational（見た目）

```tsx
function PlanCard({ plan, onEdit, onDelete }) {
  return (
    <Card>
      <h3>{plan.title}</h3>
      <Button onClick={onEdit}>編集</Button>
    </Card>
  );
}
```

#### Container（ロジック）

```tsx
function PlanCardContainer({ planId }) {
  const { data: plan } = api.plans.getById.useQuery({ id: planId });
  const deletePlan = api.planCommands.delete.useMutation();

  return (
    <PlanCard
      plan={plan}
      onDelete={() => deletePlan.mutate({ id: planId, expectedUpdatedAt: plan.updated_at })}
    />
  );
}
```

**なぜ分けるか**: テストしやすい（Presentational は純粋関数）、再利用しやすい、責務が明確。

### エラーハンドリング: TRPCError

```typescript
// Service内でエラーをスロー
if (!plan) {
  throw new TRPCError({
    code: 'NOT_FOUND',
    message: '予定が見つかりません',
  });
}

// Client側でキャッチ
const mutation = api.planCommands.update.useMutation({
  onError: (error) => {
    if (error.data?.code === 'NOT_FOUND') {
      toast.error('予定が見つかりません');
    }
  },
});
```

エラーパターンの詳細は [`conventions-api.md`](./conventions-api.md) を参照。

---

## Domain vs Server

`features/{name}/domain/` と `features/{name}/server/` の境界。「いつ domain に置き、いつ server に置くか」を判断するための規約。

### 結論

- **domain = TZ / DB / React 非依存の pure logic**
- **server = DB orchestration + RPC↔tRPC adapter**
- **RPC / DB shape を domain に持ち込まない**

### 判断基準

#### domain に置く

- DB / Supabase / tRPC / React / Zustand / TZ に **依存しない pure logic**
- 入力 → 出力が決定論的、副作用なし
- unit test で完結する（mock 不要）
- 例: business rule、validation、計算、変換（domain type → domain type）

#### server に置く

- RPC / DB row の snake_case shape に密結合
- snake → camel rename / outer key rename を含む
- `null → undefined` 変換など RPC↔tRPC 契約差分の adapter
- DB error code を持つ Error class に依存（例: `TagServiceError`）

#### どちらにも置かない

- React hook が必要なロジック → `hooks/`
- Zustand store のロジック → `stores/`
- 1-5 LOC の trivial mapper → inline で OK（独立ファイル化の ROI が低い）

### domain と server transformer の違い

| 観点   | domain                    | server transformer                                |
| ------ | ------------------------- | ------------------------------------------------- |
| 入力   | feature の domain type    | RPC row / `unknown`                               |
| 出力   | feature の domain type    | tRPC response shape                               |
| 依存   | 他 domain function のみ   | RPC shape の型を直接握る                          |
| テスト | TZ / 副作用なしで pass    | RPC mock 不要、pure                               |
| 場所   | `features/{name}/domain/` | `features/{name}/server/{procedure}-transform.ts` |

### Naming 規則

確立済みの命名規則:

| プレフィックス | 用途                                           | 例                            |
| -------------- | ---------------------------------------------- | ----------------------------- |
| `aggregate`    | pure aggregation（複数行 → 集計）              | `aggregateTagStats`           |
| `transform`    | pure transform（snake → camel、shape 変換）    | `transformEstimationAccuracy` |
| `unpack`       | RPC field の default 埋め（単一 RPC field 用） | `unpackEntryRate`             |
| `calculate`    | pure 計算（streak、平均、差分など）            | `calculateStreak`             |
| `build`        | 入力から構造化された出力を構築                 | `buildTagDashboard`           |

### 1 procedure 1 file 原則

server transformer は基本的に **1 procedure 1 file**。

```
features/timeblock/server/
  statistics-overview-transform.ts
  statistics-time-by-tag-transform.ts
  statistics-kpi-unpackers.ts          # ← 例外: 4 unpacker を集約
```

**例外**: 同ドメインの subset shape を扱う関連 unpacker は 1 file に集約してよい。

例: `statistics-kpi-unpackers.ts` は 4 つの KPI unpacker (`unpackCumulativeTime` / `unpackPlanRate` / `unpackContextSwitches` / `unpackBlankRate`) を集約。これらは:

- 全て `get_stats_kpi_summary` の subset shape を扱う
- 全て同じ default / rename ロジックを共有
- 個別 KPI procedure と `transformStatsOverviewResponse` の両方から呼ばれる

「同じ shape を返すから」だけで統合しない。**同じ default / rename / 変換ルールを共有しているか** で判断する。

### 共通化の判断（#1232 の教訓）

同一ロジックが 2 箇所以上で重複していたら統合する。

#### 重複の典型例

`get_plan_rate` を直接読む procedure と `get_stats_kpi_summary.planRate` から読む procedure が、**同じ default ロジックを別々に書いていた**:

```ts
// getPlanRate (flat, 個別 RPC)
return {
  totalEntries: result?.totalEntries ?? 0,
  plannedEntries: result?.plannedEntries ?? 0,
  planRate: result?.planRate ?? 0,
};

// transformStatsOverviewResponse (nested, summary RPC)
planRate: {
  totalEntries: result?.planRate?.totalEntries ?? 0,
  plannedEntries: result?.planRate?.plannedEntries ?? 0,
  planRate: result?.planRate?.planRate ?? 0,
}
```

これは `unpackPlanRate(data)` を共通化することで両方から再利用可能になり、片方だけ挙動が乖離するリスクを排除できる。

#### 統合しない判断

「同じ shape を返すから」だけでは統合しない。判断軸:

- ✅ 同じ default 値を共有
- ✅ 同じ rename ロジック
- ✅ 同じ null/undefined 変換
- ❌ shape が偶然一致しているだけ（rule は別物）

### 実例

#### domain の例: `aggregateMonthlyTrend`

```ts
// features/timeblock/domain/monthly-trend.ts
export function aggregateMonthlyTrend(
  rows: MonthlyTrendRow[],
  nowYear: number,
  nowMonth: number,
  monthCount: number,
): MonthTrendSlot[] {
  // 月跨ぎ / leap year / 負数 modulo 補正を含む pure logic
  // ...
}
```

- TZ 形式化は呼び出し元 (server procedure) が行い、`nowYear` / `nowMonth` を引数で受ける
- domain は TZ 非依存に保たれる
- unit test で leap year / 年跨ぎ を網羅できる

#### server transformer の例: `transformStatsOverviewResponse`

```ts
// features/timeblock/server/statistics-overview-transform.ts
export function transformStatsOverviewResponse(data: unknown): StatsOverviewResult {
  const result = data as Partial<StatsKpiSummaryRpcResult> | null | undefined;
  return {
    cumulativeTime: unpackCumulativeTime(result?.cumulativeTime),
    planRate: unpackPlanRate(result?.planRate),
    contextSwitches: unpackContextSwitches(result?.contextSwitches),
    blankRate: unpackBlankRate(result?.blankRate),
  };
}
```

- RPC `get_stats_kpi_summary` の response shape (camelCase + `planRate` 構造) に密結合
- default 埋めは RPC↔tRPC adapter の役割
- domain には置けない（RPC shape を握っている）

---

## `src/lib` Policy

`apps/product/src/lib/` の役割と「何を置き / 何を置かないか」のルール。

### 結論

- `src/lib` は **feature 横断の再利用コードと shell-level state** のみ
- `src/lib → features/*` の import は **禁止**（一方向ルール）
- `src/lib` は便利箱ではない。feature 非依存の基盤として扱う

### 置いてよいもの

| カテゴリ                          | 例                                                                                       |
| --------------------------------- | ---------------------------------------------------------------------------------------- |
| **feature 非依存の pure utility** | `logger` / `safe-redirect` / `date-utils` / `breakpoints` / `cn`                         |
| **infrastructure adapter**        | `supabase/` / `trpc/` / `sentry/` / `rate-limit/` / `i18n/` / `stripe/`                  |
| **cross-cutting UI state**        | `lib/stores/useShellStore` / `useCalendarNavigationStore`                                |
| **shared UI primitive**           | `lib/components/ui/`（shadcn-style primitive）                                           |
| **横断的な型**                    | `lib/types/settings.ts`（複数 feature 参照、明確な残存理由あり）                         |
| **shell-level orchestration**     | `lib/auth/domain/`（middleware / tRPC / proxy で共有される access policy）               |
| **Supabase/DB 境界**              | `lib/database/`（generated types / `databaseTables` / Row helper。product 専用 DB 境界） |

### 置かないもの

| カテゴリ                  | 正しい配置先                  |
| ------------------------- | ----------------------------- |
| feature 固有の logic / 型 | `features/{name}/`            |
| feature 固有の component  | `features/{name}/components/` |

### 一方向ルール（ESLint `error` で強制）

```
src/lib/*  ✕→  @/features/*
features/*  ✓→  src/lib/*
```

`src/lib` から `@/features/*` を import するのは **禁止**。逆依存が発生するため。

例外（ESLint で許可されているもの）:

- `src/lib/trpc/root.ts` — Server Composition Layer（router aggregator）
- `src/lib/hooks/useTheme.ts` — `app/_providers/theme-provider` からの re-export
- `src/lib/components/dnd/**` — DnD (stories only)
- `src/lib/**/*.stories.*` — Storybook files
- `src/lib/test/**` — Integration / E2E tests

### 例外運用の実例

#### `lib/types/settings.ts`

`SettingsCategory` 型が以下の **3 箇所** から参照される:

- `lib/stores/useShellStore.ts` — SheetType union の一部
- `lib/components/shell/sidebar/UserMenu.tsx` — 引数型
- `features/settings/types/index.ts` — settings 自身が re-export

なぜ `lib/` に残すか:

- `useShellStore` / `UserMenu` は **lib 層**（feature 非依存の shell UI）
- ここから `features/settings` を import すると lib → features の逆依存になる
- **本体は lib に置き、settings は re-export で扱う** ことで逆依存を回避

これは settings 固有のテクニックではなく、**lib 層と feature 層が同じ型を共有する場合の参照パターン**として残す。

#### `lib/auth/domain/`

`lib/auth/domain/` には access policy / identity / permissions / roles が置かれる。

- これは **`features/auth/domain` ではなく、アプリ全体の認証・認可 policy domain**
- 利用者:
  - `middleware (proxy.ts)` — リクエストごとの access check
  - `tRPC procedures.ts` — endpoint ごとの access check
  - 各 endpoint
- `features/auth/domain/index.ts` は `lib/auth/domain` を re-export（feature 側からも同じ API で見える）

`features/auth` と `lib/auth/domain` は責務が異なる:

| 場所                  | 責務                                                                 | 利用者                       |
| --------------------- | -------------------------------------------------------------------- | ---------------------------- |
| `features/auth`       | ログイン UI / Auth store / 認証体験                                  | UI ページ・コンポーネント    |
| `src/lib/auth/domain` | アプリ全体の認証・認可 policy（access-policy / permissions / roles） | middleware / tRPC / endpoint |

「auth feature の domain」ではなく「**アプリ全体で共有される access policy**」として lib に置くことで、proxy と tRPC が同じ policy を参照できる。

### Composition Feature

通常 feature とは別カテゴリの **composition feature** が 2 つある:

#### `features/settings`

- ESLint feature DAG から **除外**
- 他 feature の store / barrel を組み合わせて「設定」UI を合成
- 自身の domain は持たない
- deep import 優先順: **`@/lib/stores/*` > feature barrel > deep import**
- 詳細: `features/settings/index.ts` 冒頭コメント / AGENTS.md / `pr-cross-review` skill

#### `features/auth`（部分的）

- UI 部分は `features/auth`
- policy 部分は `src/lib/auth/domain`（上述）
- 2 つの責務を意図的に分離している

---

## Common Pitfalls

開発時によくある間違いと、正しいパターンの一覧。AI（Claude Code）が同じミスを繰り返さないための参照。

### 1. 旧用語の使用

ADR-025 で `entries` 単一モデルは `plans`（予定）/ `records`（記録）に分割済み。DB、tRPC、型、コード上のドメイン名は Plan / Record を正とする。

```tsx
// ❌ 旧用語
api.entry.create(...)
from('entries')
EntryService

// ✅ 現在
api.planCommands.create(...) / api.recordCommands.create(...)
from('plans') / from('records')
PlanService / RecordService
```

コードベースやドキュメントで `entry` / `entries` を見かけたら、文脈に応じて `plan` / `record` に読み替える。

### 2. Plan / Record の時刻ルール

強制点は2本だけ（`end_at > start_at`、Record は未来に終われない）。過去 Plan は読み取り専用ではなく、過去・未来で操作を出し分ける特別扱いはこれ以外にない（2026-09-04、「未来 Plan」向け特例4種を撤去）。

```tsx
// ✅ 過去Planの時間も自由に変更できる
updatePlan({ id, startAt: newTime }); // Planのままで、Recordへは変換されない

// ✅ 過去Planの内容を訂正
updatePlan({ id, note, activityId });

// ❌ Recordの終了を未来へ動かす
updateRecord({ id, endAt: futureTime }); // DB trigger `DT005` がエラーにする

// ✅ Recordの時間・内容を訂正（終了は現在以前のまま）
updateRecord({ id, startAt, endAt, note });
```

強制点は DB trigger（`DT003` / `DT005`）。アプリ層はその写しで、UI だけを直しても規則は変わらない。

### 3. 直接カラーの使用

Tailwind の直接カラークラスは禁止。セマンティックトークンのみ使用。

```tsx
// ❌ 直接カラー
<div className="text-red-500 bg-blue-100 border-gray-300" />

// ✅ セマンティックトークン
<div className="text-destructive bg-muted border-border" />
```

使用可能なトークンは Colors Story（Storybook: `Shared/Foundations/Colors`）で確認。

### 4. Feature 間の直接 import

Feature 同士は直接 import できない。Composition Layer（`src/app/` のページ）で合成する。

```tsx
// ❌ Calendar から Timeblock を直接 import
import { DateTimeSection } from '@/features/timeblock/components/inspector/fields/DateTimeSection';

// ❌ deep import
import { useTimeblockInspectorStore } from '@/features/timeblock/stores/useTimeblockInspectorStore';

// ✅ barrel export 経由
import { DateTimeSection } from '@/features/timeblock';

// ✅ ページ層（Composition Layer）で合成
// src/app/[locale]/(app)/calendar/page.tsx
import { CalendarController } from '@/features/calendar';
import { ConfirmDayButton } from '@/features/timeblock';
```

**検出**: `npm run lint:boundaries` で違反を検出。

### 5. 禁止されたパターン

| ❌ 禁止                        | ✅ 代替                          | 理由                        |
| ------------------------------ | -------------------------------- | --------------------------- |
| `any` / `unknown` / `Function` | 具体的な型、`as never`           | 型安全性                    |
| `console.log`                  | `@/lib/logger`                   | 本番ログ制御                |
| `useEffect` で fetch           | tRPC + TanStack Query            | キャッシュ・エラー処理      |
| `style` 属性                   | Tailwind クラス                  | 一貫性                      |
| `export default`               | named export                     | App Router 特殊ファイル除く |
| `React.FC`                     | `export function Component() {}` | 簡潔さ                      |

### 6. Storybook 関連

#### Storybook にないパターンを使う

Storybook は Single Source of Truth。記載されていないパターンは使わない。

```tsx
// ❌ Storybook に size="xl" の Story がない
<Button size="xl">Click</Button>

// ✅ Story に記載されているパターンのみ使用
<Button size="lg">Click</Button>
```

新パターンが必要 → 先に Story を追加してからコードで使用。

#### Canvas にテキストを入れる

```tsx
// ❌ Canvas Story に見出しやテキスト
export const Default: Story = {
  render: () => (
    <div>
      <h1>ヘッダー</h1> {/* ← 禁止 */}
      <MyComponent />
    </div>
  ),
};

// ✅ コンポーネントのみ（テキストは Docs MDX へ）
export const Default: Story = {
  render: () => <MyComponent />,
};
```

例外: Foundations と Patterns は Canvas 内テキスト OK。

詳細は [`storybook.md`](./storybook.md) を参照。

### 7. Supabase / DB 関連

#### Docker でのデプロイ

この環境に Docker はない。Edge Functions のデプロイには `--use-api` フラグが必須。

```bash
# ❌
supabase functions deploy

# ✅
supabase functions deploy --use-api
```

#### db push の --project-ref

通常の migration 適用は Supabase GitHub integration が担当する。手動 `supabase db push` は emergency only。

実行する場合も `supabase db push` は `--project-ref` を受け付けない。リンク済みプロジェクトに対して実行されるため、事前に `supabase link --project-ref ...` の対象を確認する。

詳細は [`infra.md`](./infra.md) のマイグレーション手順を参照。

### 8. コミットメッセージ

```bash
# ❌ 英語
git commit -m "fix: button color"

# ✅ 日本語 + Conventional Commits
git commit -m "fix(ui): ボタンのカラーをセマンティックトークンに修正"
```

### 関連ドキュメント

| ドキュメント                                                      | 内容                           |
| ----------------------------------------------------------------- | ------------------------------ |
| [Repository root](../../README.md)                                | workspace と主要コマンドの入口 |
| [Domain Glossary](../product/glossary.md)                         | ドメイン用語定義               |
| [`conventions-api.md`](./conventions-api.md) のエラーパターン辞書 | エラーコード体系               |

---

## 参考

- `Feature Boundaries`（AGENTS.md / `pr-cross-review` skill）
- ADR-012 Feature-Sliced Architecture（削除済み、git 履歴参照）
