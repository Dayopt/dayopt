---
name: security
description: 認証/認可フロー変更時、tRPC の `protectedProcedure` 追加・変更時、Storage/RLS ポリシー編集時、Supabase Auth 設定変更時、ユーザー入力を受ける新規フォーム実装時、外部 API/Webhook からのデータ取り込み実装時に発動。OWASP Top 10 の観点でレビューする。型定義のみ・UI 文言のみの変更では発動しない。
effort: high
maxTurns: 25
disallowedTools: Write
---

# セキュリティ監査スキル

## When to Use

以下の状況で発動:

- tRPC router に新規 procedure を追加する時、または既存 procedure の auth 境界を変更する時
- `protectedProcedure` / `publicProcedure` の区分を変える時、`ctx.userId` フィルタを追加・削除する時
- Supabase の RLS ポリシー / Storage ポリシー / Auth 設定を編集する時
- ユーザー入力を受け付ける新規フォームや API endpoint を実装する時
- 外部サービス（Webhook、OAuth callback、外部 API response）からのデータを DB に書き込む処理を実装する時
- `.env` / secrets の取り扱いに関わるコード変更時

## When NOT to Use

- 型定義のみの変更（auth 境界が変わらない型エイリアス追加など）
- UI 文言・レイアウトのみの変更で、データフローに触れない時
- 既存テストのアサーション追加のみの時（新しい入力経路が増えない）

## チェックリスト（重要度順）

### 1. [Critical] 認証・認可

**Dayoptの正しいパターン** (`apps/product/src/features/activities/server/router.ts`参照):

```typescript
// ✅ Dayoptパターン
export const activitiesRouter = createTRPCRouter({
  listActivities: protectedProcedure
    .input(z.object({ ... }).optional())
    .query(async ({ ctx, input }) => {
      const service = createActivitiesService(ctx.supabase);
      return await service.listActivities({
        userId: ctx.userId!,  // 必須: userIdでフィルタ
        ...input,
      });
    }),
});
```

**チェック項目**:

- [ ] 全てのエンドポイントで `protectedProcedure` を使用
- [ ] Service層に `userId` を渡している
- [ ] publicProcedure は本当に公開が必要な場合のみ

### 2. [Critical] 入力検証

**Dayoptの正しいパターン**:

```typescript
// ✅ 厳密なバリデーション
.input(z.object({
  planId: z.string().uuid(),                    // UUID検証
  title: z.string().min(1).max(200),            // 長さ制限
  sortOrder: z.enum(['asc', 'desc']).default('asc'),  // 列挙型
}))

// ❌ 危険: 検証なし
.input(z.object({
  id: z.string(),  // UUIDでない文字列を受け入れてしまう
}))
```

**チェック項目**:

- [ ] ID系は `z.string().uuid()` で検証
- [ ] 文字列は `min(1).max(N)` で長さ制限
- [ ] 数値は `int().min(0).max(N)` で範囲制限
- [ ] 配列は `z.array().max(100)` で上限設定

### 3. [High] SQLインジェクション対策

**確認ポイント**:

- Supabaseクエリビルダーを使用
- ユーザー入力を直接埋め込まない

```typescript
// ✅ 安全: クエリビルダー使用
const { data } = await supabase
  .from('activities')
  .select('*')
  .eq('user_id', userId)
  .ilike('name', `%${searchTerm}%`);

// ❌ 危険: 生SQL + 文字列結合
const { data } = await supabase.rpc('search', {
  query: `SELECT * FROM activities WHERE name = '${userInput}'`, // 危険!
});
```

### 4. [High] XSS対策

**確認ポイント**:

- `dangerouslySetInnerHTML` を使用していない
- Reactの自動エスケープを信頼

```typescript
// ❌ 危険
<div dangerouslySetInnerHTML={{ __html: userInput }} />

// ✅ 安全（Reactが自動エスケープ）
<div>{userInput}</div>
```

### 5. [Medium] 機密情報の取り扱い

**チェック項目**:

- [ ] `NEXT_PUBLIC_` は本当に公開が必要な値のみ
- [ ] APIキーやシークレットがクライアントに露出していない
- [ ] console.logに機密情報を出力していない

### 6. [Low] 依存関係のセキュリティ

```bash
# 脆弱性チェック（= pnpm audit --audit-level=moderate）
pnpm security:check
```

## 出力形式

```markdown
## セキュリティ監査結果

### Critical

- [ ] [ファイル:行] 問題の説明
  - リスク:
  - 修正:

### High

- [ ] ...

### Medium

- [x] 問題なし

### Low

- [x] pnpm security:check: 脆弱性なし
```

## Dayopt固有ルール

1. **全データアクセスは `userId` でフィルタ** - RLSだけに頼らない
2. **Service層を経由** - ルーターに直接ロジックを書かない
3. **`handleServiceError()` を使用** - 直接TRPCErrorをthrowしない
4. **守るべき前提を作ったら `docs/engineering/invariants.md` を同じ PR で更新** - 新しい
   Pro 限定機能、新しい公開エンドポイント種別、新しい table パターンなど。カタログは
   内製クロスレビュー（`.agents/skills/pr-cross-review/SKILL.md`）が
   「あるべき検査の不在」を判定する時の照合先なので、更新を怠ると新機能の穴が構造的に
   見えなくなる。**判定は自動では走らない**（merge の hard gate ではない advisory
   レビュー。別 provider の反証は User が必要時に使う任意経路。AGENTS.md §レビュー規則、
   #2596）。危険クラスの diff では merge 前に `pr-cross-review` skill を明示的に実行する

5. **実装前に `docs/engineering/threat-model.md` の既往クラスと却下記録を読む** - Dayopt で
   実際に起きた欠陥のクラスと、反証つきで却下済みの候補が並んでいる。同じ穴を掘り直さない
   ためのチェックであり、汎用の OWASP 観点では拾えない。ファイルが対象境界を含んでいない
   場合は、そこが未検査であることを前提に進める

## 関連する検査経路

- **`pr-cross-review` skill** — auth / RLS / service role / OAuth / webhook / billing / redirect / migration を扱う PR の merge 前クロスレビュー
- **`security-sweep` skill** — PR 差分ではなく 1 SHA の scope を読む provider 非依存の調査。候補・反証・実行証拠を候補集合として残し、その結果が `docs/engineering/threat-model.md` へ戻る
- **`/claude-security`** — 既存コードの深掘りスキャン。`security-sweep` の researcher 段の任意の加速器で、必須ではない

> このスキルは「実装時のガイド」、上記は「既存コードの検査」。新規コード実装時はこのスキルを、既存コードのスキャンは `/claude-security` を使う。

## 関連スキル

- `/trpc-router-creating` - 認証付きエンドポイント作成
- `/test` - セキュリティテストの作成
