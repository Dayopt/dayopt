---
status: current
last_verified: 2026-08-07
code: apps/product/src
---

# フロントエンド規約

エラーページ / ErrorBoundary 自動復旧、tRPC hooks パターン、状態管理（Zustand vs Context vs TanStack Query）、TanStack Query 使用ガイド、Next.js パフォーマンス最適化。「コーディング規約は?」のフロントエンド部分（コアの feature/lib 規約は [`conventions.md`](./conventions.md)、API 規約は [`conventions-api.md`](./conventions-api.md)）。

---

## エラーページシステム

B2C個人向けアプリに必要なエラーハンドリングだけに整理した6コンポーネント構成。

### アーキテクチャ

```
エラー発生
│
├─ Root Layout 破壊 ──→ global-error.tsx
├─ ルートエラー ──→ error.tsx
├─ 404 ──→ not-found.tsx
├─ カレンダー SSR エラー ──→ calendar/error.tsx
├─ React レンダリングエラー ──→ error-boundary.tsx
└─ メンテナンス ──→ maintenance/route.ts
```

### 主要コンポーネント

| コンポーネント | 責務                                     | ファイル                                    |
| -------------- | ---------------------------------------- | ------------------------------------------- |
| GlobalError    | Root Layout破壊時。Sentry連携            | `src/app/global-error.tsx`                  |
| RootError      | Provider外のランタイムエラー。Sentry連携 | `src/app/error.tsx`                         |
| RootNotFound   | 404表示。ホームへの導線のみ              | `src/app/not-found.tsx`                     |
| CalendarError  | カレンダーSSR/ランタイムエラー。i18n対応 | `src/app/[locale]/(app)/calendar/error.tsx` |
| ErrorBoundary  | Reactレンダリングエラー。Sentry連携      | `src/components/error-boundary.tsx`         |
| maintenance    | メンテナンスモード。静的HTML             | `src/app/maintenance/route.ts`              |

### 言語の挙動

ページによって表示言語が異なる。技術的制約に基づく意図的な設計。

| コンポーネント         | 表示言語                | 理由                                              |
| ---------------------- | ----------------------- | ------------------------------------------------- |
| `global-error.tsx`     | 英語固定                | Provider外（i18n使用不可）                        |
| `error.tsx`            | 英語固定                | Provider外（i18n使用不可）                        |
| `not-found.tsx`        | 英語固定                | Provider外（i18n使用不可）                        |
| `calendar/error.tsx`   | ユーザーのlocale        | `[locale]`配下で`useTranslations()`使用可能       |
| `error-boundary.tsx`   | ユーザーのlocale        | アプリ内レンダリングで`useTranslations()`使用可能 |
| `maintenance/route.ts` | 英語メイン + 日本語併記 | 静的HTML（i18n使用不可）                          |

Root系3ページが英語固定な理由: これらが表示される = `NextIntlClientProvider`自体がマウントできなかった状況。i18nに依存するとProvider破壊時にエラーページすら表示できなくなる。

#### i18nキーの場所

| ページ               | キー                                                   |
| -------------------- | ------------------------------------------------------ |
| `calendar/error.tsx` | `messages/{locale}/calendar.json` → `calendar.error.*` |
| `error-boundary.tsx` | `messages/{locale}/error.json` → `error.boundary.*`    |

### 注意点

- フルページエラー（global-error, error, not-found）はカード型デザイン（`max-w-md`, `rounded-2xl`）で統一
- HTTPステータスコード（404, 500等）は見出しに使わない。ユーザーに意味がないため
- CTAは最小限にする。404に「お問い合わせ」は不要（サポート案件ではない）
- `global-error.tsx`は`<html>``<body>`タグを含む（Root Layoutが壊れているため）

### 削除したページ（2026-02-10）

| ページ                                | 理由                                                             |
| ------------------------------------- | ---------------------------------------------------------------- |
| `[locale]/error/page.tsx`             | デッドコード。どこからもリダイレクトされない                     |
| `[locale]/error/401/page.tsx`         | デッドコード。Middlewareが`/auth/login`へ直接リダイレクト        |
| `[locale]/error/403/page.tsx`         | デッドコード + B2Cアプリにロールベース権限なし                   |
| `[locale]/error/500/page.tsx`         | デッドコード。Next.jsが`error.tsx`を自動表示                     |
| `[locale]/error/maintenance/page.tsx` | デッドコード。Middlewareは`/maintenance`(route.ts)へリダイレクト |

---

## ErrorBoundary 自動復旧システム

4段階の復旧戦略（自動→手動→リロード→ホーム）を持つエラーハンドリングシステム。

### 主要機能

- **全画面レベル保護** — アプリケーション全体をエラーから守る
- **自動エラー分析** — エラーの種類・重要度・復旧可能性を自動判定
- **段階的復旧** — 自動→手動→リロード→ホームの4段階
- **カテゴリ別フォールバック** — エラータイプに最適化されたUI

### システム構成

```
src/
├── components/
│   ├── common/
│   │   ├── GlobalErrorBoundary.tsx      # 全画面レベルエラーバウンダリー
│   │   └── ErrorFallbacks.tsx           # カテゴリ別フォールバック
│   └── error-boundary.tsx               # ErrorBoundary, FeatureErrorBoundary
├── hooks/
│   └── useAutoRetry.ts                  # 自動リトライフック群
├── config/
│   └── error-patterns.ts                # エラーパターン辞書
└── constants/
    └── errorCodes.ts                    # エラーコード体系
```

エラーコード体系・Sentry連携の詳細は [`conventions-api.md`](./conventions-api.md) のエラーパターン辞書セクションを参照。

### 基本的な使い方

#### グローバルエラーバウンダリー（自動適用済み）

```tsx
// src/app/layout.tsx
<GlobalErrorBoundary maxRetries={3} retryDelay={1000} onError={handleGlobalError}>
  <Providers>
    {children}
    <ToastContainer />
  </Providers>
</GlobalErrorBoundary>
```

#### コンポーネント別エラーバウンダリー

```tsx
import { SmartErrorBoundary, DatabaseErrorFallback } from '@/lib/components/common'

// 自動判定（推奨）
<SmartErrorBoundary>
  <YourComponent />
</SmartErrorBoundary>

// 特定のフォールバックを指定
<SmartErrorBoundary fallbackComponent={DatabaseErrorFallback}>
  <DatabaseComponent />
</SmartErrorBoundary>
```

#### 自動リトライフック

```tsx
import { useApiRetry, useDataFetchRetry } from '@/lib/components/common';

// API呼び出し用
const { execute, isLoading, retry, error } = useApiRetry(async () => {
  const response = await fetch('/api/data');
  if (!response.ok) throw new Error(`API Error: ${response.status}`);
  return response.json();
});

// データフェッチ用
const dataRetry = useDataFetchRetry(async () => {
  return await fetchUserData();
});
```

### カテゴリ別フォールバック

| フォールバック          | 用途                   | 特徴                   |
| ----------------------- | ---------------------- | ---------------------- |
| `NetworkErrorFallback`  | ネットワーク接続エラー | Wi-Fi・接続確認の案内  |
| `DatabaseErrorFallback` | データベースエラー     | 自動修復中の表示       |
| `APIErrorFallback`      | API通信エラー          | サーバー通信問題の説明 |
| `AuthErrorFallback`     | 認証エラー             | ログインページへの誘導 |
| `UIErrorFallback`       | UIコンポーネントエラー | 軽量な再表示ボタン     |
| `GenericErrorFallback`  | 汎用エラー             | あらゆるエラーに対応   |

#### 自動選択（推奨）

```tsx
import { selectErrorFallback } from '@/lib/components/common'

const FallbackComponent = selectErrorFallback(error)
<FallbackComponent error={error} resetErrorBoundary={reset} />
```

### 復旧戦略の階層

#### 1. 自動リトライ（バックグラウンド）

- 指数バックオフ（1秒 → 2秒 → 4秒）
- 最大3回まで自動実行
- ユーザーの操作を中断しない

#### 2. 手動リトライ（ユーザー操作）

- 「手動再試行」ボタン
- リトライ回数表示

#### 3. ページ再読み込み（確実な復旧）

- 「ページ再読み込み」ボタン
- アプリケーション全体をリセット

#### 4. ホーム画面誘導（最終手段）

- 「ホームに戻る」ボタン
- 安全な画面への誘導

### 設定オプション

#### GlobalErrorBoundary設定

```tsx
<GlobalErrorBoundary
  maxRetries={3} // 最大リトライ回数
  retryDelay={1000} // 初期遅延時間（ms）
  onError={(error, errorInfo, retryCount) => {
    // Sentryへの送信など
  }}
>
  {children}
</GlobalErrorBoundary>
```

#### useAutoRetry設定

```tsx
const config = {
  maxRetries: 3,
  initialDelay: 1000,
  backoffFactor: 2,
  maxDelay: 30000,
  shouldRetry: (error: Error, retryCount: number) => {
    return error.message.includes('network') && retryCount < 3;
  },
  onRetry: (error: Error, retryCount: number) => {
    // リトライ時のコールバック
  },
  onFinalFailure: (error: Error, retryCount: number) => {
    // 最終失敗時のコールバック
  },
};
```

### ベストプラクティス

#### エラーバウンダリーの配置

```tsx
// ❌ 全体を1つのエラーバウンダリーでラップ
<ErrorBoundary>
  <Header />
  <Sidebar />
  <Main />
</ErrorBoundary>

// ✅ 重要なコンポーネントごとに配置
<div>
  <Header />
  <SmartErrorBoundary>
    <Sidebar />
  </SmartErrorBoundary>
  <SmartErrorBoundary>
    <Main />
  </SmartErrorBoundary>
</div>
```

#### リトライ設定の最適化

```tsx
// API呼び出し：積極的にリトライ
const apiRetry = useApiRetry(apiCall, {
  maxRetries: 3,
  initialDelay: 1000,
});

// ユーザーアクション：控えめにリトライ
const userActionRetry = useUserActionRetry(userAction, {
  maxRetries: 1,
  initialDelay: 2000,
});
```

---

## Hooks Pattern

tRPC カスタムフックの統一実装パターン。全 Feature 共通で適用する。

### データ取得フック

```typescript
import { api } from '@/lib/trpc';
import { CACHE_5_MINUTES } from '@/lib/date';

export function useItems(filters?: ItemFilters, options?: { enabled?: boolean }) {
  return api.items.list.useQuery(filters, {
    staleTime: CACHE_5_MINUTES,
    retry: 1,
    ...options,
  });
}
```

### ミューテーションフック

```typescript
export function useItemMutations() {
  const utils = api.useUtils();

  const invalidateItems = () => {
    void utils.items.list.invalidate();
  };

  const createItem = api.items.create.useMutation({
    onSuccess: () => {
      toast.success('作成しました');
      invalidateItems();
    },
    onError: () => {
      toast.error('作成に失敗しました');
    },
  });

  return { createItem };
}
```

### チェックリスト

| 項目               | 説明                         |
| ------------------ | ---------------------------- |
| `api` クライアント | `trpc` ではなく `api` を使用 |
| `retry: 1`         | リトライを1回に設定          |
| JSDoc              | パラメータと戻り値を説明     |
| `void`             | Promiseを明示的に無視        |

### キャッシュ戦略（hooks 側の目安）

既定値は staleTime 5分 / gcTime 2時間。`QueryClient` 生成時に一度だけ設定する（詳細は後述の「TanStack Query 使用ガイド」内キャッシュ戦略を参照）。hook 側で同じ 5 分を明示したい時は `@/lib/date` の `CACHE_5_MINUTES` を使う。

### ファイル命名規則

```
src/features/{feature}/hooks/
├── use{Feature}s.ts         # 一覧取得
├── use{Feature}.ts          # 単一取得
├── use{Feature}Mutations.ts # ミューテーション
└── index.ts                 # エクスポート
```

---

## 状態管理ガイド: Zustand vs Context API

Dayopt における状態管理の判断基準。**原則: 新規は Zustand を優先する。**

### 判断フローチャート

```
外部ライブラリが提供するContext？
(next-themes, react-hook-form等)
│
├─ YES → Context API（変更不可）
│
└─ NO
   │
   ▼
5秒に1回以上変更される？
│
├─ YES → Zustand
│
└─ NO
   │
   ▼
10個以上のコンポーネントが参照？
│
├─ YES → Zustand
│
└─ NO
   │
   ▼
永続化（LocalStorage）が必要？
│
├─ YES → Zustand
│
└─ NO
   │
   ▼
Redux DevToolsでデバッグしたい？
│
├─ YES → Zustand
│
└─ NO → どちらでもOK（Zustand推奨）
```

### 状態の種類と管理方法

| 状態の種類               | 管理方法       | 例                               |
| ------------------------ | -------------- | -------------------------------- |
| **サーバーデータ**       | TanStack Query | プラン一覧、アクティビティ       |
| **UI状態（グローバル）** | Zustand        | サイドバー開閉、選択中のアイテム |
| **UI状態（ローカル）**   | useState       | フォームの入力値、モーダルの開閉 |
| **URL状態**              | Next.js Router | 現在のページ、クエリパラメータ   |

### Zustand 使用例

#### 基本パターン

```typescript
import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import { createSelectors } from '@/lib/zustand/createSelectors';

interface SidebarState {
  isOpen: boolean;
  toggle: () => void;
}

const useSidebarStoreBase = create<SidebarState>()(
  devtools(
    (set) => ({
      isOpen: true,
      toggle: () => set((state) => ({ isOpen: !state.isOpen })),
    }),
    { name: 'sidebar-store' },
  ),
);

export const useSidebarStore = createSelectors(useSidebarStoreBase);
```

#### selector必須パターン

```typescript
// ✅ .use.プロパティ名() で取得（最も簡潔）
const isOpen = useSidebarStore.use.isOpen();
const toggle = useSidebarStore.use.toggle();

// ✅ 手動selectorでも可
const isOpen = useSidebarStore((state) => state.isOpen);

// ❌ 全プロパティ取得（不要な再レンダリングが発生）
const { isOpen, toggle } = useSidebarStore();
```

#### 永続化が必要な場合

```typescript
import { persist } from 'zustand/middleware';

export const useLocalUiSettingsStore = create<LocalUiSettingsState>()(
  persist(
    (set) => ({
      hourHeight: 72,
      showWeekends: true,
    }),
    { name: 'calendar-settings' },
  ),
);
```

### Context API 使用例（正当な理由が必要）

#### 外部ライブラリ（変更不可）

```typescript
// next-themes, react-hook-form, react-dnd
// → ライブラリが提供するContextをそのまま使う
```

#### 特定機能内の軽量状態

```typescript
// ✅ 理由をコメントに明記すること
// 理由: カレンダー内部のみで使用、更新頻度が低いためContext APIで十分
const CalendarNavigationContext = createContext<CalendarNavigationContextValue | null>(null);
```

### 現在の使用状況

#### Zustand

| ストア            | 説明           | 理由                           |
| ----------------- | -------------- | ------------------------------ |
| `useAuthStore`    | 認証状態       | 頻繁な更新、アプリ全体で使用   |
| `useSidebarStore` | サイドバー開閉 | 多数のコンポーネントから参照   |
| `useEventStore`   | イベント管理   | 複雑な状態、デバッグツール必要 |
| `useTaskStore`    | タスク管理     | 複雑な状態、デバッグツール必要 |

#### Context API（正当な理由あり）

| Context                          | 理由                   |
| -------------------------------- | ---------------------- |
| `ThemeProvider` (next-themes)    | 外部ライブラリ         |
| `FormProvider` (react-hook-form) | 外部ライブラリ         |
| `DndProvider` (react-dnd)        | 外部ライブラリ         |
| `CalendarNavigationContext`      | 特定機能内、低頻度更新 |
| `ToastProvider`                  | UIライブラリパターン   |

### パフォーマンスの違い

#### Context API の問題

```typescript
// Provider の値が変わると、すべての子が再レンダリング
<ThemeContext.Provider value={{ theme, setTheme }}>
  <ComponentA />  {/* theme未使用でも再レンダリング */}
  <ComponentB />  {/* theme未使用でも再レンダリング */}
</ThemeContext.Provider>
```

#### Zustand の最適化

```typescript
// selectorで必要な状態のみ購読 → 関係ないコンポーネントは再レンダリングしない
function ComponentA() {
  const theme = useThemeStore((state) => state.theme); // themeが変わった時だけ
}

function ComponentB() {
  // useThemeStoreを使用していない → 再レンダリングされない
}
```

新規 store 作成時の devtools / persist / 型安全パターンは `store-creating` skill を参照。

---

## TanStack Query 使用ガイド

Dayopt における TanStack Query（React Query）の標準的な使用方法とベストプラクティス。

### Query Key Factory パターン

#### 基本構造

```typescript
export const featureKeys = {
  all: ['feature'] as const,
  lists: () => [...featureKeys.all, 'list'] as const,
  list: (filters: Record<string, unknown>) => [...featureKeys.lists(), { filters }] as const,
  details: () => [...featureKeys.all, 'detail'] as const,
  detail: (id: string) => [...featureKeys.details(), id] as const,
};
```

#### 階層的なキャッシュ無効化

```typescript
// すべてのアクティビティ関連クエリを無効化
queryClient.invalidateQueries({ queryKey: activityKeys.all });

// リストのみ無効化
queryClient.invalidateQueries({ queryKey: activityKeys.lists() });

// 特定のフィルタのみ無効化
queryClient.invalidateQueries({ queryKey: activityKeys.list({ includeArchived: true }) });

// 特定のアクティビティ詳細のみ無効化
queryClient.invalidateQueries({ queryKey: activityKeys.detail('activity-id') });
```

### キャッシュ戦略

#### デフォルト設定

`staleTime` / `gcTime` は `QueryClient` 生成時（`src/lib/trpc/query-client.ts`）に一度だけ定義する。個別の hook は、デフォルトと違う挙動が必要な時だけ上書きする。

```typescript
// src/lib/trpc/query-client.ts
new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5 * 60 * 1000, // 5分(一般的なデータのデフォルト)
      gcTime: PERSIST_MAX_AGE_MS, // 2時間(query cache の IndexedDB 永続化)
    },
  },
});
```

| 設定      | 値    | 理由                                                                                                                         |
| --------- | ----- | ---------------------------------------------------------------------------------------------------------------------------- |
| staleTime | 5分   | シングルユーザーアプリでは自分以外がデータを変更しない。楽観的更新で常に最新に保たれるため、長めにして無駄な再フェッチを防ぐ |
| gcTime    | 2時間 | IndexedDB からの復元前にメモリキャッシュが GC されないよう長めに設定                                                         |

#### 個別 hook での上書き

デフォルトと同じ 5 分を明示したい時は `@/lib/date` の `CACHE_5_MINUTES` を使う。

```typescript
import { CACHE_5_MINUTES } from '@/lib/date';

export function useUserSettings() {
  return api.userSettings.get.useQuery(undefined, {
    staleTime: CACHE_5_MINUTES,
    refetchOnWindowFocus: false,
    refetchOnMount: false,
  });
}
```

永続化させたくない一時的なクエリ（検索結果など）は `gcTime: 0` を明示する。

```typescript
// apps/product/src/features/calendar/components/search/TimeblockSearchDialog.tsx
const plansQuery = api.plans.list.useQuery(searchInput, {
  enabled: hasDebouncedQuery,
  gcTime: 0, // 閉じる・検索語変更でmemory cacheにも残さない
  meta: { persist: false },
});
```

機能ごとに `staleTime` / `gcTime` を一元管理する集約レイヤー（`cacheStrategies`）はかつて存在したが、17 キー全部が未使用のまま保守されていただけだったため削除した（#1858）。実際のコールサイトは一貫してデフォルト（5分 / 2時間）を使っている。

### エラーハンドリング

#### 統一エラーハンドラー

```typescript
import { handleQueryError } from '@/lib/tanstack-query/error-handler';

export function useCreateActivity() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: activityAPI.createActivity,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: activityKeys.all });
    },
    onError: (error) => {
      handleQueryError(error, {
        queryKey: activityKeys.all,
        operation: 'create',
        feature: 'activities',
      });
    },
  });
}
```

#### リトライ戦略

グローバル設定で自動適用（`src/components/providers.tsx`）:

- **404エラー**: リトライしない
- **401/403エラー**: リトライしない
- **429エラー**: 最大2回、長めの遅延でリトライ
- **その他のエラー**: 最大3回、指数バックオフでリトライ

### 楽観的更新

#### Mutation内での楽観的更新

```typescript
export function useCreateActivity() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: activityAPI.createActivity,
    onMutate: async (newActivity) => {
      await queryClient.cancelQueries({ queryKey: activityKeys.lists() });
      const previous = queryClient.getQueryData(activityKeys.lists());

      // 楽観的更新
      queryClient.setQueryData(activityKeys.lists(), (old) => [...old, newActivity]);

      return { previous };
    },
    onError: (error, variables, context) => {
      // エラー時にロールバック
      if (context?.previous) {
        queryClient.setQueryData(activityKeys.lists(), context.previous);
      }
    },
  });
}
```

キャッシュ操作・ロールバック・Realtime 競合対策の詳細は `optimistic-update` skill を参照。

### テスト方法

#### テストヘルパー

```typescript
function createTestQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        gcTime: Infinity,
      },
    },
  })
}

function createWrapper() {
  const queryClient = createTestQueryClient()
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      {children}
    </QueryClientProvider>
  )
}
```

#### テスト例

```typescript
describe('useActivities', () => {
  it('should fetch activities', async () => {
    const { result } = renderHook(() => useActivities(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toHaveLength(3);
  });
});
```

### マイグレーション: useEffect → TanStack Query

```typescript
// ❌ Before: 手動fetch
const [data, setData] = useState([]);
const [loading, setLoading] = useState(false);

useEffect(() => {
  setLoading(true);
  fetch('/api/data')
    .then((res) => res.json())
    .then(setData)
    .finally(() => setLoading(false));
}, []);

// ✅ After: TanStack Query
const { data, isLoading } = useQuery({
  queryKey: dataKeys.lists(),
  queryFn: () => fetch('/api/data').then((res) => res.json()),
});
```

---

## Next.js パフォーマンス最適化

Dayoptで実装済みのNext.js App Router向けパフォーマンス最適化の技術リファレンス。exact versionは`apps/product/package.json`を参照する。

### 実装済み最適化一覧

| カテゴリ        | 実装内容                                     | ファイル                       |
| --------------- | -------------------------------------------- | ------------------------------ |
| PPR             | Partial Prerendering有効化                   | `next.config.mjs`              |
| Server Prefetch | tRPC Server-side helpers + HydrationBoundary | `src/lib/trpc/server.ts`       |
| Router Cache    | staleTimes設定                               | `next.config.mjs`              |
| Link最適化      | ネットワーク条件に応じたprefetch             | `nav-main.tsx`                 |
| LCP最適化       | priority属性追加                             | エラーページ各種               |
| SW最適化        | キャッシュ自動バージョニング                 | `useServiceWorker.ts`, `sw.js` |
| Bundle最適化    | optimizePackageImports拡張                   | `next.config.mjs`              |
| 遅延ロード      | Novel Editor dynamic import                  | `PlanInspectorContent.tsx`     |

### Phase 1: PPR + Server-side Prefetch

#### PPR (Partial Prerendering)

```js
// next.config.mjs
experimental: {
  ppr: true,
  staleTimes: {
    dynamic: 30,
    static: 180,
  },
}
```

**効果**: 静的シェルを即座に表示、動的部分を後からストリーミング。FCPの大幅改善。

#### tRPC Server-side Prefetch

```tsx
// src/app/[locale]/(app)/calendar/[view]/page.tsx
import { dehydrate, HydrationBoundary } from '@tanstack/react-query';
import { createServerHelpers } from '@/lib/trpc/server';

export default async function CalendarPage() {
  const helpers = await createServerHelpers();

  await helpers.plans.list.prefetch();
  await helpers.records.list.prefetch();
  await helpers.activities.list.prefetch();

  return (
    <HydrationBoundary state={dehydrate(helpers.queryClient)}>
      <CalendarClient />
    </HydrationBoundary>
  );
}
```

**効果**: 初回レンダリング時にデータが既にキャッシュ済み。クライアントでの追加フェッチ不要。

### Phase 2: Link Prefetch最適化

#### ネットワーク条件に応じたprefetch

```tsx
const shouldPrefetch = useMemo(() => {
  if (typeof navigator === 'undefined') return true;

  const connection = (navigator as Navigator & {
    connection?: { saveData?: boolean; effectiveType?: string }
  }).connection;

  if (connection?.saveData) return false;
  if (connection?.effectiveType === '2g' || connection?.effectiveType === 'slow-2g') {
    return false;
  }

  return true;
}, []);

<Link href={item.url} prefetch={shouldPrefetch}>
```

**効果**: モバイルデータ節約、遅いネットワークでの帯域消費削減。

### Phase 3: LCP最適化

#### priority属性

```tsx
<Image
  src="..."
  alt="..."
  width={960}
  height={540}
  priority // LCP画像に追加
  className="..."
/>
```

**効果**: ファーストビューの大きな画像を優先ロード。LCP改善。

### Phase 4: Service Worker最適化

#### キャッシュ自動バージョニング

```ts
// src/lib/hooks/useServiceWorker.ts（getBuildSha は src/lib/app-info.ts）
const buildSha = getBuildSha();
const swUrl = buildSha ? `/sw.js?v=${buildSha}` : '/sw.js';
```

**効果**: デプロイ時にSWが自動更新、古いキャッシュの自動クリーンアップ。

### Phase 5: Bundle最適化

#### optimizePackageImports

```js
// next.config.mjs
experimental: {
  optimizePackageImports: [
    'lucide-react',
    '@radix-ui/react-icons',
    'date-fns',
    'framer-motion',
    '@tanstack/react-query',
    '@tiptap/react',
    '@tiptap/core',
    '@tiptap/starter-kit',
    '@tiptap/extension-placeholder',
  ],
}
```

#### Heavy Component遅延ロード

```tsx
const NovelDescriptionEditor = dynamic(
  () => import('../shared/NovelDescriptionEditor').then((mod) => mod.NovelDescriptionEditor),
  {
    ssr: false,
    loading: () => (
      <div className="text-muted-foreground min-h-8 px-2 py-1 text-sm">読み込み中...</div>
    ),
  },
);
```

**効果**: 初期バンドルサイズ約300KB削減。

### 意図的にスキップした最適化

| 項目               | 理由                                                |
| ------------------ | --------------------------------------------------- |
| Settings遅延ロード | Next.jsがルート別に自動コード分割済み               |
| React.memo追加     | 工数対効果が低い（既にuseMemo/useCallback実装済み） |
| Edge Runtime       | 既存構成で十分、複雑性増加のリスク                  |

### 計測方法

#### Lighthouse（ローカル）

```bash
npm run build && npm run start
# 別ターミナル
npx lighthouse http://localhost:3000 --view
```

#### Vercel Analytics

本番環境では Vercel Speed Insights でリアルユーザーメトリクスを確認。

パフォーマンス関連のバンドル監視は `docs/operations/` を参照。
