---
status: current
last_verified: 2026-08-17
code: apps/product/src/lib/date
---

# タイムゾーン設計ガイド

どの国のユーザーでも同じ体験を保証するための3層アーキテクチャ（TZ Source of Truth / Boundary Functions / Application Code）。禁止パターン、DB層のTZ処理、SSR Cookie方式をまとめる。

---

## 3層アーキテクチャ

```
┌─────────────────────────────────────────────┐
│  Layer 1: TZ Source of Truth               │
│  「このユーザーのTZはAsia/Tokyo」           │
│  唯一の参照元。全レイヤーがここから取得     │
├─────────────────────────────────────────────┤
│  Layer 2: Boundary Functions               │
│  「このユーザーの"今日"はUTCで何時〜何時？」│
│  TZを受け取り、UTC境界を返す関数群          │
├─────────────────────────────────────────────┤
│  Layer 3: Application Code                 │
│  Entry作成・表示・クエリ・統計             │
│  Layer 2のみ使い、生のDate操作を禁止       │
└─────────────────────────────────────────────┘
```

---

## Layer 1: TZ Source of Truth

ユーザーのタイムゾーンを取得する唯一の方法。環境によって取得元が異なる。

| 環境                    | ソース                                        | フォールバック                                     |
| ----------------------- | --------------------------------------------- | -------------------------------------------------- |
| **クライアント**        | `useUserPreferences((s) => s.timezone)`       | `Intl.DateTimeFormat().resolvedOptions().timeZone` |
| **サーバー (tRPC)**     | `user_settings.timezone` (DB)                 | `'UTC'`                                            |
| **サーバー (SSR)**      | Cookie `user-tz` → `x-user-timezone` ヘッダー | `'UTC'`                                            |
| **DB関数 (PostgreSQL)** | `get_user_timezone(p_user_id)`                | `'UTC'`                                            |

### クライアントでの取得パターン

```tsx
// ✅ 正しい: userSettings query cacheから取得
const timezone = useUserPreferences((s) => s.timezone);

// ✅ 正しい: ブラウザ検出（TZ未設定時のフォールバックのみ）
import { getBrowserTimezone } from '@/lib/date/timezone';
const browserTz = getBrowserTimezone(); // "Asia/Tokyo" etc.

// ❌ 禁止: localStorageから直接読む
const tz = localStorage.getItem('user-timezone'); // 廃止済み
```

### サーバーでの取得パターン

```typescript
// ✅ tRPC procedure内: DBから取得
const { data } = await supabase
  .from('user_settings')
  .select('timezone')
  .eq('user_id', userId)
  .single();
const timezone = data?.timezone ?? 'UTC';

// ✅ Server Component: Cookieヘッダーから取得
import { headers } from 'next/headers';
const h = await headers();
const timezone = h.get('x-user-timezone') ?? 'UTC';

// ❌ 禁止: サーバーのローカルTZを使う
const today = new Date();
today.setHours(0, 0, 0, 0); // サーバーTZの0時 ≠ ユーザーの0時
```

---

## Layer 2: Boundary Functions

日付境界・時刻判定は `@/lib/date/timezone` から、日付キー生成（`getDateKey`）は `@/lib/date/core` からインポートする。**TZ文字列を受け取り、UTC ISO文字列を返す。**

### 時刻変換（入力 ↔ 表示）

| 関数                                 | 用途                       | 例                                     |
| ------------------------------------ | -------------------------- | -------------------------------------- |
| `convertToTimezone(utcDate, tz)`     | UTC → ユーザーTZ表示用Date | DBデータ → カレンダー表示              |
| `convertFromTimezone(localDate, tz)` | ユーザーTZ → UTC           | DnDドロップ位置 → DB保存               |
| `localTimeToUTCISO(date, h, m, tz)`  | 時刻入力 → UTC ISO文字列   | "14:30" → `"2026-03-26T05:30:00.000Z"` |

### 日付境界（クエリ・集計用）

| 関数                     | 返り値                                 | 用途         |
| ------------------------ | -------------------------------------- | ------------ |
| `toTZStartISO(date, tz)` | UTC ISO (`"2026-03-25T15:00:00.000Z"`) | 日の開始境界 |
| `toTZEndISO(date, tz)`   | UTC ISO (`"2026-03-26T14:59:59.999Z"`) | 日の終了境界 |

週・月・年の境界は `@/features/review` の `resolveReportRange(anchorDate, granularity, tz, weekStartsOn)` が返す（`features/review/lib/report-period.ts`）。**半開区間 `[startAt, endAt)`** で、終端は次の期間の開始時刻と一致する。旧 `tzWeekStart` / `tzWeekEnd` は `23:59:59.999` を返す閉区間寄りの表現で、隣接期間の間に 1ms の穴が空いたため削除した（#2575）。

`date` は `date-fns` のローカルフィールド演算（`setHours` / `startOfDay` / `addDays` 等）で作った壁時計 Date を渡す（instant ではない）。`toZonedTime` / `formatInTimeZone` を `date` に直接掛けると system TZ とのずれで日付がずれるバグを踏む（#2017 で実際に発生）。月境界の TZ 対応関数は現状無く、月グリッド表示は `@/lib/date/core` の TZ 非依存 `startOfMonth` / `endOfMonth`（ナビゲーション用途のみ、クエリ境界には未使用）を使う。

### 日付判定

| 関数                                | 返り値         | 用途                                                            |
| ----------------------------------- | -------------- | --------------------------------------------------------------- |
| `getDateKey(date, tz?)`（`./core`） | `"2026-03-26"` | グルーピング用日付キー。`tz` 省略時はローカルフィールド読み取り |
| `tzIsSameDay(a, b, tz)`             | `boolean`      | 2つのUTC瞬間が同じユーザーTZ日か                                |
| `isTodayInTimezone(date, tz, now?)` | `boolean`      | 指定 TZ で「今日」と同じ日か                                    |

ユーザーの「今日」の日付文字列が必要な場合は `getDateKey(new Date(), timezone)` を使う（専用の `tzToday` 関数は無い）。

### 使用例

```tsx
import { toTZStartISO, toTZEndISO, tzIsSameDay } from '@/lib/date/timezone';

// ✅ 「今日の全タイムブロック」を取得するクエリ境界
const startDate = toTZStartISO(new Date(), timezone); // "2026-03-25T15:00:00.000Z" (JST)
const endDate = toTZEndISO(new Date(), timezone); // "2026-03-26T14:59:59.999Z" (JST)
const plans = api.plans.list.useQuery({ startDate, endDate });

// ✅ マルチデイ判定
const isMultiDay = !tzIsSameDay(plan.startDate, plan.endDate, timezone);
```

---

## Layer 3: Application Code

### データフロー

```
ユーザー入力 (14:30)
  │ localTimeToUTCISO(date, 14, 30, 'Asia/Tokyo')
  ▼
Supabase (TIMESTAMPTZ: "2026-03-26T05:30:00.000Z")
  │ convertToTimezone(utcDate, 'Asia/Tokyo')
  ▼
カレンダー表示 (14:30)
```

### 予定 / 記録の作成

```tsx
// ✅ 正しい: TZユーティリティ経由
const startISO = localTimeToUTCISO(date, hours, minutes, timezone);
const endISO = localTimeToUTCISO(date, endHours, endMinutes, timezone);
createPlan({ start_at: startISO, end_at: endISO });

// ❌ 禁止: ブラウザTZ依存
const start = new Date();
start.setHours(14, 30, 0, 0);
createPlan({ start_at: start.toISOString() }); // ブラウザTZ ≠ 設定TZ
```

### クエリ境界の計算

```tsx
// ✅ 正しい: 半開区間を返す境界関数（週・月・年）
const { startAt, endAt } = resolveReportRange(anchorDate, 'week', timezone, weekStartsOn);
// 選択は重なりで書き、取得後に [max(start, S), min(end, E)) へ clip する
const data = api.review.getReportPeriod.useQuery({
  anchorDate,
  granularity: 'week',
  timezone,
  weekStartsOn,
});

// ❌ 禁止: startOfWeek + toISOString
const start = startOfWeek(currentDate);
const dateRange = {
  startDate: start.toISOString(), // TZずれ！
  endDate: endOfWeek(currentDate).toISOString(),
};
```

### 日付の表示・比較

```tsx
// ✅ 正しい: TZ対応の日付キー
const dateKey = getDateKey(entry.start_time, timezone);

// ❌ 禁止: ローカルTZの .getDate()
const dateKey = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
```

---

## 禁止パターン一覧

| パターン                                    | 問題                     | 代替                          |
| ------------------------------------------- | ------------------------ | ----------------------------- |
| `date.setHours(0,0,0,0)` + `.toISOString()` | ブラウザTZの0時をUTC変換 | `toTZStartISO(date, tz)`      |
| `new Date().toISOString()` で日境界生成     | TZずれ                   | `toTZStartISO` / `toTZEndISO` |
| `.getDate()` / `.getDay()` で日付比較       | ブラウザTZ依存           | `tzIsSameDay` / `getDateKey`  |
| `startOfDay()` + `.toISOString()`           | ローカルTZ→UTC変換ずれ   | `toTZStartISO(date, tz)`      |
| `startOfWeek()` + `.toISOString()`          | 同上                     | `resolveReportRange(...)`     |
| サーバーで `new Date().setHours(0,0,0,0)`   | サーバーTZ依存           | `toTZStartISO(date, userTz)`  |
| `'Asia/Tokyo'` ハードコードフォールバック   | 非日本ユーザーに不正確   | `'UTC'`                       |

---

## DB層のパターン

### PostgreSQL: ユーザーTZ取得

```sql
-- 共通ヘルパー
SELECT public.get_user_timezone(p_user_id) INTO v_tz;
-- 返り値: 'Asia/Tokyo', 'America/New_York' 等。未設定時 'UTC'
```

### PostgreSQL: 日付集計

```sql
-- ✅ ユーザーTZで日付抽出
SELECT (r.start_at AT TIME ZONE v_tz)::DATE AS record_date
FROM records r
WHERE r.user_id = p_user_id;

-- ✅ インデックス活用可能なフィルタリング
WHERE r.start_at >= (p_start::timestamp AT TIME ZONE v_tz)
  AND r.start_at <  ((p_end + 1)::timestamp AT TIME ZONE v_tz)

-- ❌ 禁止: UTCハードコード
WHERE (r.start_at AT TIME ZONE 'UTC')::DATE >= p_start
```

---

## SSR Cookie方式

```
1. 初回訪問
   └→ クライアント: user-tz Cookie を自動設定
      (Intl.DateTimeFormat().resolvedOptions().timeZone)

2. 2回目以降の訪問
   └→ proxy.ts（旧 middleware.ts）: Cookie読み取り → x-user-timezone ヘッダー
   └→ Server Component: ヘッダーからTZ取得 → prefetchに使用

3. TZ設定変更時
   └→ useUpdateUserSettings: Cookie更新 + entries全キャッシュ無効化
```

---

## 将来の拡張ポイント

### Temporal API 移行

Layer 2 (`@/lib/date/timezone.ts`) を唯一の変更点として維持。
`date-fns-tz` → `Temporal` の置換は内部実装のみ。Application codeは変更不要。

### event_timezone カラム

繰り返しイベント・フローティングタイム導入時に:

| 値                   | 意味                                 |
| -------------------- | ------------------------------------ |
| `NULL`               | ユーザーの現在TZで解釈（現行動作）   |
| `'FLOATING'`         | TZ変換なし（どこでも同じ壁時計時刻） |
| `'America/New_York'` | このTZで作成（繰り返し展開に使用）   |

---

## 関連ファイル

| ファイル                                             | 役割                                              |
| ---------------------------------------------------- | ------------------------------------------------- |
| `src/lib/date/timezone.ts`                           | Layer 2: 全TZユーティリティ（唯一のTZライブラリ） |
| `src/lib/date/core.ts`                               | TZ非依存の日付計算（加算・比較等）                |
| `src/lib/hooks/useUserPreferences.ts`                | Layer 1: クライアントTZ参照                       |
| `src/proxy.ts`                                       | SSR: Cookie → ヘッダー転写（旧 middleware.ts）    |
| `supabase/migrations/20260326000000_*.sql`           | DB: TZ対応統計関数                                |
| `src/lib/date/__tests__/timezone-edge-cases.test.ts` | DST・半時間オフセット等のエッジケーステスト       |
