---
name: i18n
description: UI テキストを含む component の新規実装・編集時、ハードコードされた日本語/英語の文字列リテラルを検出した時、`apps/product/messages/en/*.json` / `apps/product/messages/ja/*.json` 翻訳ファイルを編集する時、`docs/product/glossary.md` の用語確認や `docs/product/glossary.md#禁止表記一覧` の禁止語チェックが必要な時に発動。next-intl v4 の `useTranslations` / `getTranslations` パターンを適用し、Copy System のルール（用語集・禁止表記）に従う。内部ログやエラーコードなど非 UI 文字列には発動しない。
effort: low
maxTurns: 10
---

# 国際化（i18n）スキル

Dayoptの国際化対応を支援するスキル。next-intl v4を使用。

## When to Use

以下の状況で発動:

- 新規 component で UI テキスト（ボタン文言、ラベル、placeholder、aria-label）を書く時
- `apps/product/messages/en/*.json` / `apps/product/messages/ja/*.json` に新規キーを追加する時
- 既存 component で日本語/英語のハードコード文字列リテラル（`"記録"` / `"Save"` など）を検出した時
- en / ja のキー不整合（片方にしか存在しないキー、`lint:i18n` で検出される類）が発生した時
- `docs/product/glossary.md` を参照して用語の正しい表記を確認する時

## When NOT to Use

- 内部ログ・logger 出力用の英語文字列（`logger.info('...')`、ユーザーに表示されない）
- ErrorBoundary のフォールバックメッセージなど開発者向け文言（`error-handling` skill の領域）
- Storybook の test fixture / story args の表示確認用文字列（実運用 UI ではない）

## 技術スタック

| 項目       | 内容                                   |
| ---------- | -------------------------------------- |
| ライブラリ | next-intl v4                           |
| 対応言語   | English (en), 日本語 (ja)              |
| デフォルト | English                                |
| URL方式    | as-needed（/ja/\* のみプレフィックス） |

## Copy System — 用語集と禁止表記

**最初に確認する**:

1. [`docs/product/glossary.md`](../../../docs/product/glossary.md) — 用語の正解（タイムブロック / 予定 / 記録 / アクティビティ等）と禁止表記
2. [`scripts/lib/glossary/terms.ts`](../../../scripts/lib/glossary/terms.ts) — その**正本**。用語や禁止語を足す時はここを編集して `pnpm glossary:generate` を実行する（glossary.md の表は生成物）

用語集は 3 層に分かれる。`ui` が UI 文言に出る呼称（`pnpm copy:check` が messages を機械検査する）、`design` は docs でだけ使う設計語（決算バー・羅針盤など。UI 文言に書かない）、`code` は識別子と DB 名の対応。

用語だけでなく**トーン**（研究者ペルソナ、CTA 階層、数字フレーミング）は [`docs/product/copywriting.md`](../../../docs/product/copywriting.md) が正本。UI 文言を書く時はこちらも読む。

新規テキスト追加後に `pnpm copy:check` を実行する（CI と同じ基準は `pnpm copy:check:strict`）。**値だけでなくキー名も検査される** — キー名に `task` / `entry` / `entries` / `tag` / `event` を使わない。値が正しくてもキー名が旧語彙だと、次の実装が既存キーを手本にして旧語彙を再生産する。

## アーキテクチャ（重要）

### 共有 next-intl adapter

`packages/i18n` が routing / navigation / request locale fallback を共有する。consumer は `@dayopt/i18n/routing` または `@dayopt/i18n/navigation` を直接 import し、app-local shim は作らない。両 app の `request.ts` は next-intl plugin entrypoint と app 固有 message loader のために残す。

### namespace 自動検出（apps/product）

`apps/product/src/lib/i18n/request.ts` が `messages/{locale}/` ディレクトリを**自動スキャン**してすべての `.json` を読み込むため、新規 namespace の追加は JSON ファイルを作るだけで有効になる（**手動の NAMESPACES 配列への登録は不要**）。

```
apps/product/messages/en/calendar.json → 自動で calendar namespace を検出
```

### apps/web は固定配列方式

`apps/web/src/platform/i18n/request.ts` に `NAMESPACES = ['common', 'legal', 'marketing', 'search']` がハードコードされている。web 側に namespace を追加する場合はこの配列にも追加が必要。

### ロードされる全 namespace（apps/product）

`request.ts` がディレクトリを自動スキャンするため、**実体は `ls apps/product/messages/en` が正**。用途の説明は [`docs/engineering/i18n.md`](../../../docs/engineering/i18n.md#ネームスペース一覧) にある（ここでは複製しない）。

### packages/components は next-intl 非依存

`packages/components` から `next-intl` を import しない。翻訳は apps 側の責務。テキストは props/children で受け取る。next-intl に依存してよい共有 package は adapter 境界の `packages/i18n` だけ。

## 使用パターン

### Client Component（主要パターン）

```typescript
'use client';
import { useTranslations } from 'next-intl';

export function MyComponent() {
  // 複数 namespace を参照する場合 — 引数なしでフルパスアクセス
  const t = useTranslations();
  return (
    <div>
      <button>{t('common.actions.save')}</button>
      <span>{t('calendar.toolbar.today')}</span>
    </div>
  );
}
```

### スコープ付き（特定機能に閉じたコンポーネント向け）

```typescript
// 1 namespace のみ使う場合 — キーが短くなる
const t = useTranslations('settings');
t('account.displayName'); // = settings.account.displayName

// ⚠️ スコープ外のキーにはアクセスできない
// t('common.actions.save'); // ← settings.common.actions.save を探すので動かない
```

**判断基準**: 1つのネームスペースのキーしか使わないなら、スコープ付きでもOK。複数なら引数なし。

### Server Component

```typescript
import { getTranslations } from 'next-intl/server';

export async function MyPage() {
  const t = await getTranslations();
  return <h1>{t('calendar.pageTitle')}</h1>;
}
```

### 変数埋め込み

```typescript
// JSON: { "greeting": "Hello, {name}!" }
t('greeting', { name: 'John' });
```

### 複数形

```typescript
// JSON: { "items": "{count, plural, =0 {No items} =1 {1 item} other {# items}}" }
t('items', { count: 5 }); // → "5 items"
```

## ファイル構造とキー配置ルール

### 翻訳ファイル一覧（apps/product）

上と同じく `ls apps/product/messages/en` が正。1 ファイル = 1 トップレベルキー（`common` と `email` だけが歴史的例外）で、`pnpm lint:i18n` が強制する。

### common.json の内部構造（最重要）

`common.json` は複数のトップレベルキーを持つ特殊なファイル:

| トップレベルキー | 用途                                          |
| ---------------- | --------------------------------------------- |
| `common`         | ナビゲーション・状態・ユーティリティ          |
| `actions`        | 汎用アクション動詞（save, cancel, delete 等） |
| `aria`           | アクセシビリティラベル                        |
| `status`         | ステータス表示                                |
| `time`           | 相対時間表現                                  |
| `validation`     | バリデーションメッセージ                      |
| `errors`         | サービスエラー                                |

### キー配置の判断フロー

```
新しい翻訳キーを追加
│
├─ 汎用アクション動詞？（保存、削除、キャンセル等）
│  └─ YES → actions.*
│
├─ a11y ラベル？
│  └─ YES → aria.*
│
├─ 確認ダイアログのテンプレート？
│  └─ YES → confirm.*
│
├─ バリデーション？
│  └─ YES → validation.*
│
├─ 特定機能でしか使わない？
│  └─ YES → feature ファイル（例: calendar.toast.deleted）
│
└─ ナビゲーション・UI状態
   └─ common.*
```

## 新規翻訳キー追加手順

1. **用語を確認**: `docs/product/glossary.md` で正しい表記を確認（無い概念なら `scripts/lib/glossary/terms.ts` へ足して `pnpm glossary:generate`）
2. **配置先を決める**: 上記フロー参照
3. **両言語に追加**: en と ja のキー構造を完全一致させる
4. **検証**: `pnpm i18n:check && pnpm copy:check:strict`

```json
// apps/product/messages/en/timeblock.json — 追加
{
  "timeblock": {
    "toast": { "created": "Plan created" }
  }
}

// apps/product/messages/ja/timeblock.json — 追加
{
  "timeblock": {
    "toast": { "created": "予定を作成しました" }
  }
}
```

## 禁止事項

### ❌ ハードコードされた文字列

```typescript
// ❌ 禁止
<button>保存</button>

// ✅ 正しい
<button>{t('common.actions.save')}</button>
```

### ❌ 機能固有キーを common.json に置く

```json
// ❌ 禁止 — calendar でしか使わないキーを common に置く
{ "common": { "calendar": { "toolbar": { "today": "今日" } } } }

// ✅ 正しい — calendar.json に置く
{ "calendar": { "toolbar": { "today": "今日" } } }
```

### ❌ 汎用単語を feature ファイルに重複定義

```typescript
// ❌ 禁止 — "保存" を activities.json に定義して使う
t('activities.category.save');

// ✅ 正しい — actions.save を再利用
t('actions.save');
```

### ❌ 禁止語を使う

```typescript
// ❌ 禁止 — 禁止語「タスク」を使う
{ "calendar": { "event": { "newTask": "タスクを作成" } } }

// ✅ 正しい — glossary に従う
{ "timeblock": { "create": "タイムブロックを作成" } }
```

## AI/Agent ルール

1. 直接日本語・英語文字列をコードに書かない
2. `messages/{locale}/{namespace}.json` に追加する
3. namespace は画面/機能単位にする
4. `common` に入れるのは共通操作語だけ（domain 固有キーは feature ファイルへ）
5. 新しい用語は `docs/product/glossary.md` を確認する
6. 迷ったら既存キーをまず検索する（重複定義を防ぐ）
7. 最後に `pnpm i18n:check` と `pnpm copy:check:strict` を実行する

## チェックリスト

新しいUIテキスト追加時：

- [ ] `docs/product/glossary.md` で用語を確認したか
- [ ] 配置先を判断フローで決定したか
- [ ] en/ja 両方に追加したか（キー構造が完全一致）
- [ ] 汎用単語は `actions.*` / `common.*` を再利用しているか（重複定義していない）
- [ ] 機能固有キーは feature ファイルに置いたか（common.json に混ぜていない）
- [ ] キー名は意味のあるドット記法か（例: `calendar.toast.deleted`）
- [ ] `pnpm i18n:check` が通るか
- [ ] キー名に旧語彙（`task` / `entry` / `tag` / `event`）を使っていないか
- [ ] `pnpm copy:check:strict` が通るか

## 言語検出の仕組み

1. URLパスから言語を検出（`/ja/*` → 日本語）
2. デフォルトは英語（プレフィックスなし）
3. ミドルウェア（`apps/product/src/lib/supabase/middleware.ts`）が自動処理

## 関連ファイル

- `docs/product/glossary.md` - 用語集（生成物。`#禁止表記一覧` に禁止語の一覧）
- `scripts/lib/glossary/terms.ts` - 用語集の正本。編集後は `pnpm glossary:generate`
- `docs/engineering/i18n.md` - 実装ガイド（詳細版）
- `packages/i18n/src/routing.ts` - 共通ルーティング設定
- `packages/i18n/src/navigation.ts` - 共通ナビゲーションユーティリティ
- `packages/i18n/src/request.ts` - locale fallback と request config factory
- `apps/product/src/lib/i18n/request.ts` - メッセージローダー（自動検出）
- `apps/web/src/platform/i18n/request.ts` - メッセージローダー（固定 namespace）
- `apps/product/src/lib/i18n/scripts/check-keys.ts` - キー差分チェック（`pnpm i18n:check`）
- `apps/product/src/lib/i18n/scripts/find-unused.ts` - 未使用キー検出（`pnpm i18n:unused`）
- `scripts/tasks/check-glossary.ts` - 禁止表記スキャン（`pnpm copy:check`）
