---
name: test
description: バグ修正・挙動変更の着手時（実装前に症状を検出する失敗テストを書く）、新機能実装の完了時（tRPC procedure / React hook / pure function / component の新規作成後）、既存テストの assertion 追加が必要な実装変更時に発動。Vitest + Testing Library の配置規約（対象ファイルの隣に `X.test.ts`）と red → green の規約に従う。型定義のみ・UI 文言のみの変更では発動しない。
effort: medium
maxTurns: 15
---

# テスト作成スキル

Dayoptのテスト作成を支援するスキル。Vitest + Testing Libraryを使用。

## When to Use

以下の状況で発動:

- バグ修正・挙動変更に着手する時（**実装前に**対象症状を検出する失敗テストを書く）
- 新規 tRPC procedure / service 関数 / React hook / pure function を実装完了した時
- 複雑な状態遷移を持つ component を新規追加した時
- Zod schema の制約を追加・変更した時（入力境界の test case 追加）
- 既存の実装変更で分岐や境界条件が増えた時（未カバーの path が生まれる）
- バグを修正した直後（実装前に置けなかった場合に、同じ回帰を検知するテストを追加する）

## When NOT to Use

- 型定義のみの変更（挙動が変わらず、テスト対象の実装が存在しない）
- UI 文言・レイアウトのみの変更（`storybook` skill の視覚検証領域、test 対象外）
- 既存テストのリファクタリング（構造変更のみ、カバレッジは変わらない）

## 技術スタック

| ツール          | 用途                      |
| --------------- | ------------------------- |
| Vitest          | テストランナー            |
| Testing Library | コンポーネントテスト      |
| MSW             | APIモック（必要に応じて） |

## テスト配置ルール

**`X.test.ts` は `X` の隣に置く。`__tests__/` ディレクトリは作らない**（[#2485](https://github.com/Dayopt/dayopt/issues/2485)）。

```
apps/product/src/features/{feature}/
├── components/
│   ├── MyComponent.tsx
│   └── MyComponent.test.tsx
├── hooks/
│   ├── useMyHook.ts
│   └── useMyHook.test.ts
└── utils/
    ├── myUtil.ts
    └── myUtil.test.ts
```

## 実行環境（node / happy-dom）

`apps/product` の unit test は **2 つの project に分かれる**。全 test に happy-dom を掛けると
実行時間の大半が DOM 構築とモジュール読み込みに消えるため、**既定は `node`** で、DOM が要るものだけ happy-dom に入れる。

| project    | 環境        | 対象                                                          | setup           |
| ---------- | ----------- | ------------------------------------------------------------- | --------------- |
| `unit`     | `node`      | 上記以外の `*.test.ts`（domain / service / lib の純ロジック） | `setup-node.ts` |
| `unit-dom` | `happy-dom` | `*.test.tsx`、`use*.test.ts`、明示列挙した例外                | `setup.ts`      |

- **component / hook の test は自動で happy-dom 側に入る**（`.tsx` と `use*` の 2 パターン）。
  普通に書いていれば意識しなくてよい
- **上の 2 パターンに当てはまらない test で DOM が要る場合**は、`apps/product/vitest.config.ts`
  の `DOM_ONLY_TESTS` に path を追加する
- **分類が合っているかはローカルで判断しない。** Node 22 以降は `environment: 'node'` でも
  `localStorage` が使えてしまい、**ローカルでは通るのに CI（Node 24）で
  `ReferenceError: localStorage is not defined` になる**。分類を変えたら CI を oracle にする
- **DOM 依存は test を読んでも分からないことがある。** test 本体が localStorage に触れて
  いなくても、**実装側**が触っていれば DOM が要る。迷ったら DOM 側に置く（遅くなるだけで壊れない）
- **module mock（`server-only` / `next/navigation` / `next-intl`）は両 project 共通**。
  追加する時は `src/lib/test/setup-node.ts` に書く（`setup.ts` はこれを import している）。
  `setup.ts` にだけ足すと node 側の test が静かに素の実装を掴む

## テスト実行コマンド

```bash
# 単一ファイル
pnpm test -- path/to/file.test.ts

# 特定のディレクトリ（pnpm test は apps/product 内で vitest を起動するため package-relative）
pnpm test -- src/features/calendar/

# 全体
pnpm test

# ウォッチモード
pnpm test -- --watch
```

## テストパターン

### ユニットテスト（関数）

```typescript
import { describe, it, expect } from 'vitest';
import { formatDate } from '../formatDate';

describe('formatDate', () => {
  it('正常系: 日付をフォーマットする', () => {
    const date = new Date('2024-01-15');
    expect(formatDate(date)).toBe('2024/01/15');
  });

  it('エッジケース: 無効な日付', () => {
    expect(() => formatDate(null as any)).toThrow();
  });
});
```

### コンポーネントテスト

```typescript
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { Button } from '../Button';

describe('Button', () => {
  it('renders correctly', () => {
    render(<Button>Click me</Button>);
    expect(screen.getByRole('button')).toHaveTextContent('Click me');
  });

  it('calls onClick when clicked', async () => {
    const handleClick = vi.fn();
    render(<Button onClick={handleClick}>Click</Button>);

    await userEvent.click(screen.getByRole('button'));
    expect(handleClick).toHaveBeenCalledTimes(1);
  });

  it('is disabled when disabled prop is true', () => {
    render(<Button disabled>Disabled</Button>);
    expect(screen.getByRole('button')).toBeDisabled();
  });
});
```

### フックテスト

```typescript
import { renderHook, act } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { useCounter } from '../useCounter';

describe('useCounter', () => {
  it('初期値が設定される', () => {
    const { result } = renderHook(() => useCounter(10));
    expect(result.current.count).toBe(10);
  });

  it('incrementで値が増える', () => {
    const { result } = renderHook(() => useCounter(0));

    act(() => {
      result.current.increment();
    });

    expect(result.current.count).toBe(1);
  });
});
```

### Zustand storeテスト

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { useMyStore } from '../myStore';

describe('myStore', () => {
  beforeEach(() => {
    // ストアをリセット
    useMyStore.setState({ count: 0 });
  });

  it('初期状態', () => {
    const state = useMyStore.getState();
    expect(state.count).toBe(0);
  });

  it('increment action', () => {
    useMyStore.getState().increment();
    expect(useMyStore.getState().count).toBe(1);
  });
});
```

## テストケース設計

### 3つのカテゴリ

| カテゴリ     | 内容                           | 優先度 |
| ------------ | ------------------------------ | ------ |
| 正常系       | 期待通りの入力                 | 必須   |
| エラー系     | 異常な入力、エラーハンドリング | 必須   |
| エッジケース | 境界値、空配列、null           | 推奨   |

## red → green の規約

バグ修正と挙動変更では、**修正の前に**その症状で失敗するテストを書く。修正してから書くと、そのテストが本当に症状を検出できるか分からない。

- **red は対象の不具合で失敗する**。import error、型エラー、fixture の不備で失敗しているだけの red は red ではない。失敗メッセージが症状を説明しているか確認する
- **green は同じ検証コマンドで確認する**。red を出したコマンドをそのまま再実行する。別の条件で通しても証明にならない
- **期待値は実装から逆算しない**。実装と同じ手順で期待値を計算する test は、実装が間違っていても通る（恒真）。既知のリテラル・手計算した値・仕様を使う
- **1 cycle 1 slice**。1 つの境界に 1 つの test を書き、それを通す最小の実装を書く。テストを全部先に書いてから実装をまとめて書かない
- **refactor は loop の外**。red → green の中で構造を変えない

正しい seam（テストを置ける境界）が無い場合は、無理に作らず理由を報告する。原因調査そのものは `diagnosing-bugs` skill の領域で、この skill は signal を作る手段としての test を担当する。

例と mock の境界は [`references/tdd-loop.md`](./references/tdd-loop.md) を読む（必要時のみ）。

## Assert 対象の規約（正本）

**対象操作後にだけ生じるユーザー可視の結果または永続状態を assert する。** 操作前から存在する要素、generic な alert / class、または発火していない mock を確認しただけで test が成功すると、本番では対象操作が失敗しても回帰を検出できない（failure scenario）。

- network mock は login / render / cache warm より前に登録し、必要なら request の発生と最終 UI の両方を確認する
- **例外**: pure function の unit test など、入力と直接の返り値だけで契約を完全に証明できる場合はこの限りでない

この規約は `AGENTS.md` の TEST-1（凍結前の定義）を踏襲しているが、**この skill が生きた正本**。`AGENTS.md` 側は変更しない。

## skip 条件つき test は緑が証拠にならない

**`describe.skipIf` / `it.skipIf` は収集時に評価される。** env や設定フラグに応じて skip する test を書くと、条件を満たさない実行では「失敗」ではなく「skipped」として集計され、**exit code は 0（緑）のまま**になる。CI では正しい条件が渡っているのにローカルでは渡っていない、という差分があると、ローカル実行だけが無音で本体を素通りする（#2178）。

- **passed と skipped を読み分ける。** サマリー行の「N passed」だけでなく「M skipped」も必ず読む。skip されたテストは実行されていないため、regression があっても検出できない
- **両状態で 1 回ずつ走らせて突き合わせる。** 条件を満たす環境（例: `USE_LOCAL_DB=true`）と満たさない環境の両方で実行し、「満たす → passed / 満たさない → skipped」の対称性を確認する。片方だけでは「本当に条件で分岐しているか」「常に skip されていないか」を区別できない
- **DB 接続などの前提が満たせない時は、skip ではなく明示的な失敗にする方が安全。** 無音 skip は「実行していないのに緑」という最悪の状態を生む。前提の未整備をエラーメッセージ付きで落とす設計の方が、緑の誤認を構造的に防げる

## Dayopt固有のパターン

### tRPCエンドポイントのテスト

```typescript
// サービス層を直接テスト
import { createActivitiesService } from '../server/activities-service';

describe('ActivitiesService', () => {
  it('アクティビティを作成する', async () => {
    const mockSupabase = createMockSupabase();
    const service = createActivitiesService(mockSupabase);

    const result = await service.createActivity({
      userId: 'user-1',
      input: { name: 'Test Activity' },
    });

    expect(result.name).toBe('Test Activity');
  });
});
```

### カレンダーコンポーネントのテスト

```typescript
// ドラッグ操作のテストは複雑なため、
// ユニットテストは状態管理に集中
describe('useCalendarDrag', () => {
  it('ドラッグ開始で状態が更新される', () => { ... });
  it('ドラッグ終了で状態がリセットされる', () => { ... });
});
```

## 出力形式

```markdown
## テスト作成完了

### 作成したテスト

| ファイル             | テスト数 | 内容             |
| -------------------- | -------- | ---------------- |
| `formatDate.test.ts` | 3        | 日付フォーマット |

### カバレッジ

- 正常系: 2件
- エラー系: 1件
- エッジケース: 0件

### 実行結果
```

✓ formatDate > 正常系: 日付をフォーマットする
✓ formatDate > 正常系: 時刻を含む日付
✓ formatDate > エラー系: 無効な日付

```

```

## チェックリスト

テスト作成時：

- [ ] 正常系をカバーしたか
- [ ] エラー系をカバーしたか
- [ ] テストが独立しているか（他のテストに依存しない）

テスト実行時：

- [ ] `pnpm test` が通るか
- [ ] 新しいテストが既存テストを壊していないか

## 関連スキル

- `/diagnosing-bugs` - 原因調査（再現 signal の設計、仮説の潰し方）
- `/error-handling` - エラー処理のテスト
- `/storybook` - UIコンポーネントのビジュアルテスト
