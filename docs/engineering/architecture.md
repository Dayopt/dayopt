---
status: current
last_verified: 2026-08-20
code: apps/product/src
---

# アーキテクチャ全体像

Dayopt のシステム構成、データフロー、DB スキーマ、技術選定理由、monorepo の package 境界をまとめる。「全体構成の現在地は?」の正。

---

## 技術スタック

ここでは役割と採用理由だけを扱う。正確なversionはrootと各workspaceの`package.json`、DB runtimeはSupabase Dashboardを正とする。

### フロントエンド

- **Next.js App Router** — React フレームワーク。ファイルベースルーティング、Server Components / Client Components、`next/image` による画像最適化
- **React** — UI ライブラリ。業界標準、Server Components サポート
- **TypeScript** — 型安全性、IDE 補完、バグ防止
- **Tailwind CSS + shadcn/ui** — ユーティリティファーストのスタイリングと、Radix UI ベースのカスタマイズ可能な UI コンポーネント
- **Zustand** — クライアント状態管理。Redux よりボイラープレートが少なく学習コストが低い
- **TanStack Query** — サーバー状態のキャッシング・自動リフェッチ・楽観的更新

### バックエンド

- **Supabase (PostgreSQL)** — 認証・DB・リアルタイムを一体で提供する BaaS。PostgreSQL（SQL が使える）、RLS によるセキュリティ、オープンソースである点が採用理由
- **tRPC** — クライアント⇔サーバー間の E2E 型安全な API 通信。スキーマ自動生成不要、型の不整合はコンパイルエラーになる
- **Zod** — バリデーション。型推論と tRPC 統合

### ホスティング・デプロイ

- **Vercel** — Next.js との最適な統合、自動デプロイ、エッジ配信
- **GitHub 連携** — CI/CD

### 技術選定の理由まとめ

| 技術           | 採用理由                             |
| -------------- | ------------------------------------ |
| Next.js        | React の公式推奨、Vercel との親和性  |
| React          | 業界標準、Server Components サポート |
| TypeScript     | 型安全性、IDE 補完、バグ防止         |
| tRPC           | E2E 型安全、コード量削減             |
| Zustand        | シンプル、Redux 不要                 |
| TanStack Query | キャッシング、リフェッチ             |
| Supabase       | 認証、DB、リアルタイム一体型         |
| Tailwind CSS   | ユーティリティファースト             |
| shadcn/ui      | カスタマイズ可能、Radix UI ベース    |
| Zod            | 型推論、tRPC と統合                  |

Zustand と TanStack Query の使い分け:

- **TanStack Query**: サーバーから取得したデータ
- **Zustand**: UI の状態（サイドバー、選択状態など）

---

## データフロー

Dayopt におけるデータの流れ。ユーザー操作から DB までの全レイヤーを図解する。

### 全体像

```mermaid
graph TD
User["👤 ユーザー操作"]

    subgraph Client["🖥️ クライアント"]
        RC["React Component"]
        ZS["Zustand Store<br/>(UI状態)"]
        TQ["TanStack Query<br/>(キャッシュ)"]
        TRPC_C["tRPC Client<br/>(httpBatchLink)"]
    end

    subgraph Server["⚙️ サーバー"]
        API["/api/trpc/[trpc]"]
        MW["Middleware<br/>(認証・Rate Limit)"]
        TRPC_R["tRPC Router<br/>(protectedProcedure)"]
        SVC["Service Layer<br/>(ビジネスロジック)"]
    end

    subgraph DB["🗄️ データベース"]
        SB["Supabase Client"]
        PG["PostgreSQL + RLS"]
    end

    User --> RC
    RC <--> ZS
    RC --> TRPC_C
    TRPC_C --> TQ
    TRPC_C -->|"POST (batch)"| API
    API --> MW
    MW --> TRPC_R
    TRPC_R --> SVC
    SVC --> SB
    SB --> PG
    TQ -.->|"refetchOnWindowFocus"| RC
```

### 認証フロー

```mermaid
graph LR
subgraph AuthModes["認証モード（自動判定）"]
S["Session<br/>(Cookie)"]
O["OAuth 2.1<br/>(Bearer Token)"]
SR["Service-Role<br/>(API Key)"]
end

    subgraph Middleware
        CTX["createFetchTRPCContext"]
        RL["Rate Limit<br/>(100 req/min)"]
    end

    S --> CTX
    O --> CTX
    SR --> CTX
    CTX -->|"userId 抽出"| RL
    RL --> Router["tRPC Router"]
```

### Provider 階層

```mermaid
graph TD
    P["Providers (root)"]
    P --> QC["QueryClientProvider"]
    P --> TC["api.Provider (tRPC)"]
    P --> AS["AuthStoreInitializer"]
    P --> TP["ThemeProvider"]
    P --> SW["ServiceWorkerProvider (lazy)"]
    P --> GT["GlobalTagMergeModal (lazy)"]
```

### キャッシュ戦略

```mermaid
graph LR
subgraph Cache["TanStack Query キャッシュ"]
E["plans / records / calendars<br/>stale: 5min, gc: 10min"]
AC["activities / categories<br/>stale: 5min, gc: 10min"]
US["userSettings<br/>stale: 1h, gc: 2h"]
end

    WF["refetchOnWindowFocus"] -.->|"stale時 再取得"| E
    WF -.->|"stale時 再取得"| AC
```

### Feature 間の依存（Composition Layer）

```mermaid
graph TD
subgraph Features
ACT["activities (Layer 0)"]
TB["timeblock (Layer 1)"]
CAL["calendar (Layer 2 / hub)"]
REV["review (Layer 2)"]
AUTH["auth (independent)"]
CONTACT["contact (independent)"]
SET["settings (composition)"]
end

    subgraph Composition["Composition Layer"]
        APP["app/**/_composition + layout"]
        LIB["lib/*"]
        STORE["lib/stores/*"]
    end

    TB --> ACT
    CAL --> TB
    CAL --> ACT
    REV --> TB
    REV --> ACT
    APP --> CAL
    APP --> REV
    APP --> AUTH
    SET --> STORE
    CAL --> STORE
    LIB --> STORE
```

依存方向の正はリポジトリルートの [AGENTS.md / `pr-cross-review` skill](../../AGENTS.md / `pr-cross-review` skill) と
`apps/product/eslint.config.mjs`。`settings` は cross-cutting composition、`calendar` はページ全体を合成する hub として扱う。

### Calendar の Plan / Record と UI state

Calendar は Plan（予定）と Record（記録）を別レーンで描画し、`records.plan_id` で 1 Plan : N Record を表現する。

```mermaid
flowchart LR
    URL["URL: date / view / panel"] --> NAV["CalendarNavigationContext"]
    NAV --> CLIENT["CalendarViewClient"]
    CLIENT --> CTRL["CalendarController"]
    CLIENT --> PANEL["right-side panel: review / diff"]
    CTRL --> QUERY["tRPC + TanStack Query"]
    QUERY --> SERVICE["timeblock router / service"]
    SERVICE --> DB["Supabase: plans / records"]
    ZS["Zustand: transient interaction + persisted display/filter"] --> CTRL
    NAV -.->|"command / mirror only"| ZS
```

- 日付・view range・右パネルの表示可否は URL と `CalendarNavigationContext` が source of truth。
- `CalendarViewClient` が `CalendarController` と右側パネルを合成する。Review/Diff は独立ページではなく Calendar shell に追従する。
- Zustand は drag、inline create、clipboard、inspector、shell などの一時 UI state と、表示モード・アクティビティフィルターのユーザー設定だけを担う。URL/Context の値を永続化しない。
- Plan / Record / activity などのサーバーデータは Zustand に複製せず、tRPC / TanStack Query 経由で扱う。

### 各レイヤーの役割

#### 1. React Component

ユーザー操作を受け取り、tRPC mutation を呼び出す。

```typescript
const handleCreatePlan = async (data) => {
  await createPlan.mutateAsync(data);
};
```

#### 2. tRPC Client + TanStack Query

型安全な API 呼び出しとキャッシュ管理。

```typescript
const createPlan = api.planCommands.create.useMutation({
  onSuccess: () => {
    utils.plans.list.invalidate(); // キャッシュ無効化→再取得
  },
});
```

**なぜ tRPC か**: クライアント↔サーバー間の型安全性、自動補完、REST API より少ないコード量。

**なぜ TanStack Query か**: サーバーデータのキャッシング、自動リフェッチ、楽観的更新のサポート。

#### 3. tRPC Router

入力バリデーションと認証チェック。ルーターは薄く保つ。

```typescript
create: protectedProcedure.input(createPlanSchema).mutation(async ({ ctx, input }) => {
  const service = createPlanService(ctx.supabase);
  return service.create({ userId: ctx.userId, ...input });
});
```

#### 4. Service Layer

ビジネスロジックを集約。テストしやすく、再利用可能。

```typescript
class PlanService {
  async create(params) {
    // バリデーション
    // ビジネスロジック
    // DB操作
  }
}
```

**なぜ Service 層を分けるか**: ビジネスロジックの再利用、テストしやすさ、ルーターを薄く保つ。

#### 5. Supabase Client

```typescript
const { data, error } = await this.supabase.from('plans').insert(planData).select().single();
```

#### 6. PostgreSQL + RLS

データベースレベルでのセキュリティ。

```sql
CREATE POLICY "Users can manage own plans"
ON plans FOR ALL
USING (auth.uid() = user_id);
```

**なぜ RLS か**: アプリケーションコードでの漏れを防ぐ、ゼロトラスト原則。

### 状態管理の使い分け

| 状態の種類               | 管理方法       | 例                               |
| ------------------------ | -------------- | -------------------------------- |
| **サーバーデータ**       | TanStack Query | 予定・記録一覧、アクティビティ   |
| **UI状態（グローバル）** | Zustand        | サイドバー開閉、選択中のアイテム |
| **UI状態（ローカル）**   | useState       | フォームの入力値、モーダルの開閉 |
| **URL状態**              | Next.js Router | 現在のページ、クエリパラメータ   |

詳細は [`conventions-frontend.md`](./conventions-frontend.md) の状態管理セクションを参照。

### 楽観的更新のフロー

```
[ユーザー操作]
     ↓
[キャッシュを即座に更新] ← 体感0ms
     ↓
[tRPC mutation送信]
     ├─ 成功 → キャッシュ確定
     └─ 失敗 → キャッシュをロールバック + toast.error()
```

### 相互作用図（ツール間の連携）

```
┌─────────────────────────────────────────────────────────┐
│                    Frontend                             │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐ │
│  │  shadcn/ui  │───▶│    React    │◀───│  Tailwind   │ │
│  │  (UI部品)   │    │ (Component) │    │  (Style)    │ │
│  └─────────────┘    └──────┬──────┘    └─────────────┘ │
│                            │                            │
│                            ▼                            │
│  ┌─────────────┐    ┌─────────────┐                    │
│  │   Zustand   │◀──▶│TanStack Query│                   │
│  │  (UI状態)   │    │(サーバー状態)│                   │
│  └─────────────┘    └──────┬──────┘                    │
│                            │                            │
│                            ▼                            │
│                    ┌─────────────┐                      │
│                    │ tRPC Client │                      │
│                    │ (型安全API) │                      │
│                    └──────┬──────┘                      │
└────────────────────────────┼────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────┐
│                    Backend                              │
├─────────────────────────────────────────────────────────┤
│                    ┌─────────────┐                      │
│                    │ tRPC Router │                      │
│                    │ (+ Zod)     │                      │
│                    └──────┬──────┘                      │
│                            │                            │
│                            ▼                            │
│                    ┌─────────────┐                      │
│                    │   Service   │                      │
│                    │   Layer     │                      │
│                    └──────┬──────┘                      │
│                            │                            │
│                            ▼                            │
│                    ┌─────────────┐                      │
│                    │  Supabase   │                      │
│                    │ (Auth+DB)   │                      │
│                    └─────────────┘                      │
└─────────────────────────────────────────────────────────┘
```

---

## Database Architecture

> **RLS 対象 public テーブル数**: 27 | **PostgreSQL**: v17

Dayopt は Supabase（PostgreSQL）を使用する。本番は Pro organization の `dayopt` project、PR ごとの検証は ephemeral Preview Branches を使い、永続 Staging project は置かない。
RLS の正確な対象・policy・grant は自動生成の [`data/db/rls-snapshot.md`](./data/db/rls-snapshot.md) を正とする。

### テーブル一覧

#### コアビジネス（7テーブル）

| テーブル                     | 役割                                                             | 主要カラム                                                                                                               |
| ---------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| **plans**                    | Plan（予定）。これからやる時間の宣言                             | title, activity_id, start_at, end_at, skipped_at, source, external_calendar_event_id                                     |
| **records**                  | Record（記録）。`plan_id` で 1 Plan : N Record                   | title, activity_id, plan_id, start_at, end_at, source, external_calendar_event_id                                        |
| **external_calendar_events** | 外部カレンダー同期ミラー（テーブルのみ存在。同期実装は Phase 2） | connection_id, provider, provider_calendar_id, provider_event_id, start_at, end_at, status, dismissed_at, last_synced_at |
| **categories**               | 所属の主軸。単一所属（`activities.category_id` 1本で表現）       | name, color, icon, archived_at                                                                                           |
| **activities**               | Plan / Record の分類単位。所属カテゴリーから色・アイコンを継承   | category_id, name, archived_at                                                                                           |
| **segments**                 | 分析用の保存クエリ（横断参照、重複を許す）                       | name                                                                                                                     |
| **segment_activities**       | セグメントとアクティビティの多対多 junction                      | segment_id, activity_id                                                                                                  |

#### 外部カレンダー連携（2テーブル）

Phase 2（external-calendar-import）で追加。OAuth / 同期 / UI は Step 2 以降。

| テーブル                          | 役割                                                              | 主要カラム                                                                                       |
| --------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| **calendar_connections**          | provider アカウント接続。同一 provider の複数アカウントを許容     | provider, provider_account_id, provider_account_email, granted_scopes, refresh_token_enc, status |
| **calendar_connection_calendars** | 取り込み対象として選択されたカレンダーと per-calendar sync cursor | connection_id, provider_calendar_id, calendar_name, sync_token, last_synced_at                   |

`calendar_connections.refresh_token_enc` / `granted_scopes` / `provider_account_id` は authenticated へ GRANT しない（column-scoped SELECT）。詳細は [`data/db/rls-snapshot.md`](./data/db/rls-snapshot.md)。

#### ユーザー設定（2テーブル）

| テーブル          | 役割                                    | 主要カラム                                                                                                      |
| ----------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| **profiles**      | ユーザープロフィール（auth.usersと1:1） | email, username, full_name, avatar_url                                                                          |
| **user_settings** | 表示設定                                | timezone, theme, time format, snap interval, business hours。物理スキーマの legacy 列はプロダクト契約に含めない |

#### セキュリティ/監査（1テーブル）

| テーブル               | 役割                | 主要カラム                  |
| ---------------------- | ------------------- | --------------------------- |
| **mfa_recovery_codes** | MFAリカバリーコード | code_hash(SHA-256), used_at |

### ER図

```
                          ┌──────────────────┐
                          │    auth.users     │
                          │  (Supabase管理)   │
                          │──────────────────│
                          │ id (PK, UUID)     │
                          │ email             │
                          └────────┬─────────┘
                                   │
         ┌─────────────────────────┼─────────────────────────┐
         │                         │                         │
         ▼                         ▼                         ▼
┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐
│    profiles       │  │  user_settings    │  │     categories     │
│    (1:1)          │  │    (1:1)          │  │──────────────────│
│──────────────────│  │──────────────────│  │ id (PK)           │
│ id (PK=FK)        │  │ user_id (FK,UQ)   │  │ user_id (FK)      │
│ email, username   │  │ timezone, theme   │  │ name, color, icon │
└──────────────────┘  └──────────────────┘  │ archived_at       │
                                              └────────┬─────────┘
                                                       │ category_id (nullable)
                                                       ▼
                                              ┌──────────────────┐
                                              │    activities      │
                                              │──────────────────│
                                              │ id (PK)           │
                                              │ user_id (FK)      │
                                              │ category_id (FK,  │
                                              │   nullable)       │
                                              │ name, archived_at │
                                              └────────┬─────────┘
                                                       │ activity_id (nullable, both)
                              ┌─────────────────────────┤
                              │                         │
                              ▼                         ▼
                    ┌──────────────────┐      ┌──────────────────┐
                    │      plans        │      │      records       │
                    │──────────────────│      │──────────────────│
                    │ id (PK)           │◄─────│ plan_id (FK, NULL) │
                    │ user_id (FK)      │ 1:N  │ user_id (FK)       │
                    │ title, note       │      │ title, note        │
                    │ start_at/end_at   │      │ start_at/end_at    │
                    │ skipped_at        │      │ plan_id (nullable) │
                    │ source            │      │ source             │
                    │ external_calendar_│      │ external_calendar_ │
                    │  event_id (FK)    │      │  event_id (FK)     │
                    └────────┬─────────┘      └─────────┬──────────┘
                             │                            │
                             └─────────────┬──────────────┘
                                           ▼
                              ┌───────────────────────────┐
                              │  external_calendar_events  │
                              │  (同期ミラー)              │
                              │───────────────────────────│
                              │ id (PK)                    │
                              │ user_id (FK)                │
                              │ connection_id (FK, NULL)    │
                              │ provider, provider_calendar_ │
                              │  id, provider_event_id      │
                              │ start_at/end_at, status     │
                              │ dismissed_at, last_synced_at │
                              └─────────────┬─────────────┘
                                            │ connection_id (ON DELETE SET NULL)
                                            ▼
                              ┌───────────────────────────┐
                              │   calendar_connections     │
                              │  (provider アカウント接続) │
                              │───────────────────────────│
                              │ id (PK)                    │
                              │ user_id (FK)                │
                              │ provider, provider_account_ │
                              │  id, provider_account_email │
                              │ granted_scopes              │
                              │ refresh_token_enc           │
                              │ status, last_synced_at      │
                              └─────────────┬─────────────┘
                                            │ (id, user_id) 複合 FK
                                            ▼
                              ┌───────────────────────────┐
                              │ calendar_connection_       │
                              │   calendars (選択カレンダー)│
                              │───────────────────────────│
                              │ id (PK)                    │
                              │ connection_id, user_id (FK) │
                              │ provider_calendar_id        │
                              │ calendar_name, sync_token   │
                              └───────────────────────────┘

=== セキュリティ/監査 ===

┌──────────────────┐
│ mfa_recovery_    │
│ codes            │
│──────────────────│
│ user_id (FK)     │
│ code_hash        │
│ used_at           │
└──────────────────┘
```

### 設計判断

#### UUID主キー

全テーブルで `gen_random_uuid()` を使用。分散環境でのマージ安全性、URL推測困難性を確保。

#### RLSパターン

```sql
-- 基本パターン: ユーザーは自分のデータのみアクセス可能
(select auth.uid()) = user_id
```

#### Plan / Record 分離（ADR-025）

単一 `entries` テーブル（ADR-011）に予定 range と実績 range を同居させ、実績を read 時に自動導出するモデルは、1予定に対する複数回の記録を表現できない・自動記録が見積もり精度などの KPI を歪める、という限界を抱えていた。ADR-025 でこれを Plan / Record の2独立エンティティへ分割し、記録を自動導出ではなく明示操作に反転した。物理テーブルと公開契約は `plans` / `records` に統一している。

- 状態導出（`upcoming` / `active` / `past`）は Plan / Record それぞれの時間位置から行う
- 保存先は選択 UI ではなく `end_at > now` か否かで一意に決まる（`end_at > now` → Plan、`end_at <= now` → Record）
- 詳細は ADR-025（削除済み、git 履歴参照） 参照

#### カテゴリー / アクティビティの所有者整合

親子階層は持たない（旧タグの `level < 2` 制限を廃止）。`activities.category_id` の 1 列だけで単一所属を表現し、所有者整合は複合外部キー `(category_id, user_id) → categories(id, user_id)` で担保する。トリガーは使わない — 子側の AFTER トリガーは親の `user_id` 変更を観測できず、ロックを取らない存在確認は race するため。

#### トランザクション関数

複数テーブルを跨ぐ操作は DB 関数で原子性を保証:

- `soft_delete_plan()` / `restore_plan()` — Plan のソフトデリート / 復元
- `soft_delete_record()` / `restore_record()` — Record のソフトデリート / 復元
- `confirm_day_plans_to_records()` — 指定日の未記録 Plan を一括で Record 化（一括「この日を確定」）

### インデックス監査ランブック

本番 DB で定期的に実行し、未使用インデックスを特定する。

#### 未使用インデックスの検出

```sql
SELECT
  schemaname,
  relname AS table_name,
  indexrelname AS index_name,
  idx_scan AS times_used,
  pg_size_pretty(pg_relation_size(indexrelid)) AS index_size
FROM pg_stat_user_indexes
WHERE schemaname = 'public'
  AND idx_scan = 0
ORDER BY pg_relation_size(indexrelid) DESC;
```

#### 重複インデックスの検出

```sql
SELECT
  a.indexrelid::regclass AS index_a,
  b.indexrelid::regclass AS index_b,
  a.indrelid::regclass AS table_name
FROM pg_index a
JOIN pg_index b ON a.indrelid = b.indrelid
  AND a.indexrelid < b.indexrelid
WHERE a.indkey[0] = b.indkey[0]
  AND a.indrelid::regclass::text NOT LIKE 'pg_%';
```

> **注意**: インデックスの削除は、本番で2-4週間のデータ蓄積後に実施すること。

RLS ポリシーの自動生成スナップショットは [`data/db/rls-snapshot.md`](./data/db/rls-snapshot.md) を参照。

---

## Packages Overview（Monorepo 境界）

Dayopt の monorepo は、アプリを増やすためだけではなく、責務を小さく保つために `packages/*` を使う。
このセクションは「どのコードをどの package に出すか」を決めるための境界メモであり、大規模な移動計画ではない。

### Package Map

- `packages/foundations`（旧 `packages/design`）: design tokens / theme css / CSS variables。React components, domain logic, DB 型は入れない。
- `packages/components`（旧 `packages/ui`）: React UI primitives / reusable components。Supabase, Stripe, feature-specific business rules は入れない。
- `packages/config`: public constants / metadata / URL definitions。secrets, request-scoped values, server-only clients は入れない。
- `packages/i18n`: product / web 共通の next-intl routing / navigation / request locale fallback。message loader や app 固有 Provider は入れない。
- `packages/observability`: product / web 共通のPII sanitizer、技術context型、明示的cancel判定、browser telemetry consent契約。root exportはprovider非依存とし、明示的な`./build-gate` subpathだけにSentry Production buildのcredential / upload失敗policyを置く。Sentry SDK、Next.js、app固有capture経路は入れない。
- `apps/product/src/lib/time`（旧 `packages/domain`）: Dayopt domain model / pure types / helpers。DB row shape, React, Next, Supabase, Zustand は入れない。消費者は product のみのため、workspace package の「2 consumer 以上」基準を満たさず product-local へ統合済み（2026-08、#2168）。
- `apps/product/src/lib/database`（旧 `packages/database`）: Supabase/Postgres boundary。generated types / table names / row helper types を扱う。product 専用のため package ではなく product-local。
- `packages/billing`: Free / Pro plans, subscription status, entitlement, public-safe pricing constants。Stripe secret key, SDK, webhook handlers, checkout / portal 実装は入れない。

### Dependency Direction

`packages/*` は app / feature へ戻る import を作らない。共有 package 同士も、下位の意味を上位に漏らさない。

```txt
apps/product, apps/web, apps/storybook
  -> packages/components
  -> packages/foundations

apps/product, apps/web
  -> packages/i18n
  -> packages/config
  -> packages/billing
  -> packages/observability
```

`packages/components` は `packages/foundations` の token / CSS variables を使えるが、`packages/foundations` は `packages/components` を知らない。
`apps/product/src/lib/time`（旧 `packages/domain`）は DB row shape を知らない。DB の都合を domain model に漏らす場合は `apps/product/src/lib/database` で吸収する。

### Current Phase

`packages/foundations`, `packages/components`, `packages/config`, `packages/observability` は最小の公開面を持つ package として運用中。
`packages/i18n` は `packages/config` の locale 定義を使い、product / web に共通する next-intl adapter の公開面を環境別 subpath に限定して提供する。
`packages/observability` のroot exportはprovider非依存のprivacy / consent契約だけを公開する。Sentryの初期化、DSN値、sampling、upload実行、app固有routeは各appに残し、Production build gateの純粋な検証policyだけを`./build-gate` subpathで共有する。
`apps/product/src/lib/time`（旧 `packages/domain`）は Dayopt の意味を表すpure TypeScriptで、`TimeRange`, `TimeblockOrigin`, `ReviewPeriod`, `UserPreference`等の軽い型・定数・helperを持つ。

DB boundary は `apps/product/src/lib/database`（旧 `packages/database`、product-local 化済み）が Supabase generated types と DB row helper を担う。DB access を含む service は product 側に残す。
`packages/billing` は Free / Pro の公開 plan model, subscription status, entitlement map（`entitlementKeys` / `planEntitlements`）, pricing 表示用定数の境界として運用中。Stripe SDK / secret / webhook / checkout / portal は product 側の server-only 境界に残す。
`packages/types`, `packages/server`, `packages/utils` は未使用のまま責務が立たなかったため削除済み。

### Integration Audit

現時点の shared package 統合では、`packages/*` から `apps/*` / product feature / app alias へ戻る依存は作らない。`packages/components` の React / Radix 依存は UI primitive の責務として許容し、`apps/product/src/lib/database` の Stripe 文字列は generated DB type と table name 由来の DB boundary として扱う。

Source of truth:

- URL / domain / contact / public brand constants: `packages/config`
- next-intl routing / navigation / request locale fallback: `packages/i18n`
- Sentry event sanitizer / technical context / explicit cancellation / browser telemetry consent / Production build gate policy: `packages/observability`
- Plan / Record source・time range・time conflict / date-time preference / pure Dayopt concept: `apps/product/src/lib/time`（旧 `packages/domain`）
- Supabase generated type / table name / row helper type: `apps/product/src/lib/database`
- Free / Pro plan / subscription status / entitlement map / public pricing: `packages/billing`

Apps 側に残る legal / i18n / docs / test fixture の URL, email, price 文字列は、ユーザー向け文言・履歴・例示が混ざるため機械的には置換しない。DB access の `.from('plans')` / `.from('records')` / `.from('activities')` / `.from('user_settings')` も Supabase 型推論と呼び出し箇所が多いため、`databaseTables` 適用は段階的な follow-up にする。

### Foundation Readiness

Package foundation は第一段階として運用可能な状態にある。root scripts の `build:packages`, `typecheck:packages`, `check:workspace`, `lint:boundaries`, `build`, `build:web`, `build-storybook` は現在の package 構成を検証対象に含め、CI も `product` job（旧 `packages-build` job）で `pnpm build:packages` を実行する。

品質ゲートは apps と同じ水準に揃っている。tsconfig の共通部分は root `tsconfig.base.json` に集約し、各 package はそこから `extends` して固有オプションだけを持つ。ESLint は root `eslint.config.packages.mjs` を共有 flat config とし、各 package の `eslint.config.mjs` が re-export する。全 package が `lint: eslint src --max-warnings 0` を持つため `turbo run lint`（= `pnpm lint`）と CI の `static` job（旧 lint job）が packages を検証対象に含む。Prettier も root `format:check` が `packages/*/src` の TS/TSX/CSS/MDX を対象にする。packages は Next.js に依存しないため、app 側の `core-web-vitals` ではなく TypeScript ルール + Storybook plugin を base にする。

apps への adoption は完了している。ADR-021（削除済み、git 履歴参照）（2026-06-22）で packages を canonical とし、product / web は shim を介さず直接 import する形に統一した。UI・トークンの app 側重複は解消済みで、i18n も routing / navigation を `@dayopt/i18n/*` から直接 import する。app 側には message loading と next-intl plugin entrypoint を担う `request.ts`、app 固有 Provider だけを残す。残る follow-up は `.from('table')` への `databaseTables` 段階適用など小粒のものに限られる。

### Package Boundaries

#### `packages/foundations`

Dayopt の見た目の source of truth。React component は持たず、tokens と theme（+ token showcase の Story）だけを扱う。
CSS variables は無 prefix（`--background`, `--primary`, `--radius-*` など）が唯一の canonical 体系。旧 `--dayopt-*` prefix は ADR-021 で廃止した。

公開面は `exports` の `./tokens.css` と `./scrollbar.css` の 2 subpath だけ。個別 token CSS（`src/tokens/*.css`, `src/tailwind-theme.css`）は `tokens.css` が相対 import で集約して供給し、直接 import できる subpath としては公開しない。docs やコメントから個別ファイルを指す時は、import 可能な subpath と誤読されないよう `packages/foundations/src/tokens/colors.css` のような repo 相対 path で書く。

Storybook 表示: `Shared/Foundations/*`（Colors / Typography / Spacing / Radius / Elevation / Z-Index / Motion / Icons / Overview）

#### `packages/components`

Domain logic を持たない React UI primitive / 汎用複合 component の置き場。Button, Badge, Card, Logo のように複数 app で使える部品だけを入れる。
ADR-021 以降、product / web の canonical UI として直接 import で全面採用済み。app 固有（i18n 結合が強い confirm dialog 等）だけを app-local（`apps/*/src/components/`）に残す。

知ってよいもの:

- React
- accessibility primitives
- `packages/foundations`
- generic utility

知ってはいけないもの:

- `apps/product/src/features/*`
- Supabase / database row
- Stripe / billing secret
- user session / auth policy
- timeblock/tag/calendar 固有の business rule

#### `packages/config`

Product/web が共有する public constants の置き場。副作用を持たず、Next.js / React / Zod / env / server-only に依存しない。
`apps/product` では low-risk な public brand / domain / URL / contact constants から利用を広げている。
`apps/web` では social links と docs repository links から利用を広げ、legal / i18n / content 本文は copy として残す。

入れてよいもの:

- Dayopt の domain と canonical URL
- support / security / contact email
- brand name / public social URL
- URL join helper

入れないもの:

- env validation
- secrets
- request-scoped value
- Next.js metadata generator 本体
- server-only client

#### `packages/i18n`

product / web が共有する next-intl adapter の置き場。`packages/config` の locale constants を唯一の source of truth とし、実行環境が異なる API は root barrel を作らず `./routing`, `./navigation`, `./request` の subpath から公開する。

入れてよいもの:

- next-intl routing 定義と locale-aware navigation
- request locale の検証と default locale fallback
- app 固有 message loader を受け取る request config factory

入れないもの:

- app alias や `apps/*` への import
- message JSON / namespace discovery /固定 namespace 配列
- app 固有 Provider / plugin entrypoint
- Next.js / React の直接 import

#### `packages/observability`

Product / Webが同じprivacy boundaryとbrowser telemetry同意判定を使うためのprovider非依存契約。Sentry protocol IDを保持しながら、任意content、secret、URL queryをdrop-by-defaultで除去する。

入れてよいもの:

- pure TypeScriptのevent / transaction / span / breadcrumb sanitizer
- 技術contextのallowlist型と正規化
- 明示的なuser cancellation判定
- 既存`dayopt_cookie_consent`形式を読むbrowser telemetry consent helper
- explicitな`./build-gate` subpathに置く、secret値を保持しないProduction build-time policy helper

入れないもの:

- `@sentry/*` SDK、DSN値、sampling rate、release / source map uploadの実行
- Next.js instrumentation / route handler / error boundary
- app固有のfeature、logger、capture経路
- operator smokeやapp固有runtime Production env

#### `apps/product/src/lib/time`（旧 `packages/domain`）

Dayopt の「意味」を pure TypeScript の型・定数・helper にする。DB に保存する形ではなく、アプリが考える概念を置く。
consumer が product のみで「2 consumer 以上」基準（#2100 Phase 3-1）を満たさないため、workspace package から product-local へ統合済み（2026-08、#2168）。

入れてよいもの:

- pure TypeScript types
- enum 相当の union type / const arrays
- Date と primitive だけを使う pure helper
- DB/UI に依存しない business concept

入れないもの:

- Supabase generated types
- DB row shape
- React component / props
- Zustand store state
- Next.js route / server-only helper
- CSS / UI token

#### `apps/product/src/lib/database`（旧 `packages/database`）

Supabase/Postgres 上の形を扱う境界。generated types, table names, row helper types を公開する。
product 専用（web・他 package から参照なし）のため package ではなく product-local（`@/lib/database`）に置く。
`types:generate` の出力先も `apps/product/src/lib/database/generated/database.types.ts`。

例:

- `Database`
- `Row<typeof databaseTables.records>` / `Insert<'activities'>`
- `databaseTables`

入れないもの:

- Supabase client instance
- service role secret
- route handler / server action
- React / Zustand / UI component

#### `packages/billing`

公開してよい plan / subscription / entitlement 定義を置く境界。client import できる public-safe な billing model だけを扱う。
`apps/product` では billing / settings の表示判定で利用を広げている。Stripe runtime は product-local のままにする。

例:

- Free / Pro plan id と plan name
- Free `$0`, Pro `$5/month` の公開価格表示用定数
- `free | active | past_due | canceled | trialing` の subscription status
- entitlement map（`entitlementKeys` / `planEntitlements`）と pure helper

入れないもの:

- Stripe secret key / webhook secret
- Stripe SDK client
- webhook handler
- checkout / customer portal 実装
- env validation / server action / route handler

### Extraction Rules

抽出は「共通化したいから」ではなく、責務境界が明確になった時だけ行う。

- UI だけで成立し、domain を知らない: `packages/components`
- 見た目の token / CSS variable / theme: `packages/foundations`
- URL / metadata / public constants: `packages/config`
- locale-aware routing / navigation / request fallback: `packages/i18n`
- DB なしで説明できる Dayopt の business definition（product 専用）: `apps/product/src/lib/time`（旧 `packages/domain`、product-local）
- Supabase row / generated type / domain converter: `apps/product/src/lib/database`（product-local）
- plan / subscription / entitlement の公開定義: `packages/billing`
- Dayopt に依存しない pure helper: 再利用先が明確になるまでは利用する app 内に置く
- secret, admin, webhook, service-role を使う共通処理: product の server-only 境界に置く

### Storybook Policy

Storybook は `packages/foundations` と `packages/components` の公開面を確認する場所にする。

- `packages/foundations`: token の一覧、意味、使用禁止例を `Shared/Foundations/*` で可視化する。
- `packages/components`: props と状態を `Shared/Components/*` で可視化する。
- `apps/product/src/lib/time`（旧 `packages/domain`）, `packages/billing`, `apps/product/src/lib/database`: UI カタログではなく docs と decision table で境界を説明する。
- `apps/product` 固有の feature component は `Product/*` に残し、汎用化できたものだけ `packages/components` に移す。

`apps/storybook` が `@dayopt/product` に加えて `@dayopt/foundations` / `@dayopt/components` を直接 dependencies に持つのは意図的で、product 経由の二重経路ではない。`.storybook/main.ts` の `stories` glob が両 package の `src` を直接読み込み、`packages/components/src/*.stories.tsx` は `@dayopt/components` を package 名で self-import する。直接依存は Storybook build の実入力を宣言している。

### Ownership And Operations

Storybook の story title top-level は所有境界（package / app）で分ける（ADR-023（削除済み、git 履歴参照））。第二階層以下は責務ベース（ADR-022（削除済み、git 履歴参照））。`scripts/tasks/check-story-taxonomy.ts` が物理位置と title prefix の一致を CI で強制する。

| title prefix           | Source of truth                                                                                                |
| ---------------------- | -------------------------------------------------------------------------------------------------------------- |
| `Shared/Foundations/*` | `packages/foundations`                                                                                         |
| `Shared/Components/*`  | `packages/components`                                                                                          |
| `Shared/Patterns/*`    | `apps/storybook/.storybook/stories/patterns`（`@dayopt/components` のみに依存する pattern）                    |
| `Product/Components/*` | `apps/product/src/components/**`（app 固有 component。`apps/product/src/features/**` の straggler も一部含む） |
| `Product/Features/*`   | `apps/product/src/features/**`                                                                                 |
| `Product/Patterns/*`   | `apps/storybook/.storybook/stories/patterns`（`@/`＝product 内部に依存する pattern）                           |
| `Product/Emails/*`     | `apps/product/src/emails`                                                                                      |
| `Web/*`                | `apps/web/src/*`                                                                                               |

operations / engineering の散文 docs は Storybook ではなく repo 直下 `docs/` が正（`docs/operations/`, `docs/engineering/`）。

### Before Auth Package

`packages/auth` はまだ作らない。auth / permission は現時点では product-only で、admin app や同じ permission model を使う second runtime がまだないため、まず product-local auth domain として `apps/product` 内で境界を整える。

Current placement:

- Pure product auth model / access policy: `apps/product/src/lib/auth/domain`
- Product auth runtime: `apps/product/src/lib/supabase`, `apps/product/src/proxy.ts`, auth routes, server actions

Future extraction:

- `databaseTables`（`apps/product/src/lib/database`）を DB access call site に少しずつ適用できるか確認する。
- billing / legal / pricing 文言は i18n の表示責務と `packages/billing` の public constants の境界を分けて扱う。
- admin app または別 runtime が同じ permission model を必要とした時点で、product auth domain を `packages/auth` の pure model として昇格する。
- 昇格後も Supabase client, cookie, middleware, session refresh, route handler は product 側に残す。
