---
name: trpc-router-creating
description: 新規 feature の `apps/product/src/features/{feature}/server/router.ts` と service を作成する時、既存 router に procedure を追加する時、ビジネスロジックが router に混在していて service 層への分離が必要と判断した時に発動。feature-colocated 構造、Zod 入力検証、サービス層分離、エラーハンドリングを適用する。型定義のみの変更時や、auth 境界のみの変更時（`security` skill の領域）は発動しない。
effort: medium
maxTurns: 15
---

# tRPC Router Creating Skill

DayoptプロジェクトのtRPC v11ルーターを規約に沿って作成するスキルです。

## When to Use

以下の状況で発動:

- 新規 feature に `apps/product/src/features/{feature}/server/router.ts` と `{feature}-service.ts` を追加する時
- 既存 router に新規 procedure（query / mutation）を追加する時
- 大規模 feature で `router-index.ts` / `service-index.ts` によるマージ構造が必要になった時
- 新規 procedure 作成時に Zod schema の input validation 設計が必要になった時
- 既存 router にビジネスロジックが直接書かれており、service 層への分離が必要と判断した時

## When NOT to Use

- `types.ts` のみの型定義変更で、procedure 構造が変わらない時
- 既存 procedure の auth 境界変更のみ（`security` skill の領域、router 構造は変えない）
- Frontend 側の mutation 呼び出し方の変更のみ（`optimistic-update` skill の領域）

## ルーター構造（feature-colocated）

```
apps/product/src/features/{feature}/server/
├── router.ts              # ルーター定義
├── router.test.ts         # テスト（対象ファイルの隣に置く。`test` skill、#2485）
├── {feature}-service.ts   # ビジネスロジック
└── types.ts               # feature内の型定義（optional）
```

大規模featureの場合（例: timeblock）:

```
apps/product/src/features/timeblock/server/
├── plans-router.ts        # 個別ルーター（records-router / statistics-*-router も同様）
├── router-index.ts        # ルーターのマージ・エクスポート
├── plan-service.ts        # 個別サービス（record-service / statistics-*-service も同様）
├── service-index.ts       # サービスのマージ
└── mcp-mutation-contract.ts # 外部契約（MCP）は同居させ、保護対象 path として扱う
```

テストは各対象ファイルの隣に `X.test.ts` として置く（`__tests__/` は使わない。`test` skill、#2485）。

## 作成手順

### 1. サービス層（ビジネスロジック）

```typescript
// apps/product/src/features/{feature}/server/{feature}-service.ts
import type { Database } from '@/lib/database';
import type { SupabaseClient } from '@supabase/supabase-js';

type Db{Entity}Row = Database['public']['Tables']['{entities}']['Row'];

export function create{Entity}Service(supabase: SupabaseClient<Database>) {
  return {
    async list(params: { userId: string; limit?: number; offset?: number }) {
      const { data, error } = await supabase
        .from('{entities}')
        .select('*')
        .eq('user_id', params.userId)
        .range(params.offset ?? 0, (params.offset ?? 0) + (params.limit ?? 50) - 1);

      if (error) throw error;
      return data;
    },

    async getById(params: { userId: string; id: string }) {
      const { data, error } = await supabase
        .from('{entities}')
        .select('*')
        .eq('id', params.id)
        .eq('user_id', params.userId)
        .single();

      if (error) throw error;
      return data;
    },

    async create(params: { userId: string; input: Create{Entity}Input }) {
      const { data, error } = await supabase
        .from('{entities}')
        .insert({ ...params.input, user_id: params.userId })
        .select()
        .single();

      if (error) throw error;
      return data;
    },

    async update(params: { userId: string; id: string; input: Update{Entity}Input }) {
      const { data, error } = await supabase
        .from('{entities}')
        .update(params.input)
        .eq('id', params.id)
        .eq('user_id', params.userId)
        .select()
        .single();

      if (error) throw error;
      return data;
    },

    async delete(params: { userId: string; id: string }) {
      const { error } = await supabase
        .from('{entities}')
        .delete()
        .eq('id', params.id)
        .eq('user_id', params.userId);

      if (error) throw error;
      return { success: true };
    },
  };
}
```

### 2. ルーター定義

```typescript
// apps/product/src/features/{feature}/server/router.ts
import { z } from 'zod';

import { logger } from '@/lib/logger';
import { handleServiceError } from '@/lib/trpc/errors';
import { createTRPCRouter, protectedProcedure } from '@/lib/trpc/procedures';
import { create{Entity}Service } from './{feature}-service';

export const {feature}Router = createTRPCRouter({
  list: protectedProcedure.query(async ({ ctx }) => {
    const service = create{Entity}Service(ctx.supabase);
    try {
      return await service.list({ userId: ctx.userId });
    } catch (error) {
      handleServiceError(error);
    }
  }),

  getById: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const service = create{Entity}Service(ctx.supabase);
      try {
        return await service.getById({ userId: ctx.userId, id: input.id });
      } catch (error) {
        handleServiceError(error);
      }
    }),

  create: protectedProcedure
    .input(z.object({
      name: z.string().min(1).max(100),
      // other fields
    }))
    .mutation(async ({ ctx, input }) => {
      const service = create{Entity}Service(ctx.supabase);
      try {
        return await service.create({ userId: ctx.userId, input });
      } catch (error) {
        handleServiceError(error);
      }
    }),

  update: protectedProcedure
    .input(z.object({
      id: z.string().uuid(),
      data: z.object({ name: z.string().min(1).max(100) }).partial(),
    }))
    .mutation(async ({ ctx, input }) => {
      const service = create{Entity}Service(ctx.supabase);
      try {
        return await service.update({ userId: ctx.userId, id: input.id, input: input.data });
      } catch (error) {
        handleServiceError(error);
      }
    }),

  delete: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const service = create{Entity}Service(ctx.supabase);
      try {
        return await service.delete({ userId: ctx.userId, id: input.id });
      } catch (error) {
        handleServiceError(error);
      }
    }),
});
```

### 3. メインルーターに登録

```typescript
// apps/product/src/app/api/trpc/_server/app-router.ts（lib/trpc/root.ts は re-export のみ）
import { {feature}Router } from '@/features/{feature}/server/router';

export const appRouter = createTRPCRouter({
  // existing routers...
  {feature}: {feature}Router,
});
```

## アーキテクチャ

```
┌─────────────────────┐
│   tRPC Router       │  ← Zodバリデーション + エラーハンドリング
├─────────────────────┤
│   Service Layer     │  ← ビジネスロジック
├─────────────────────┤
│   Supabase Client   │  ← データアクセス
└─────────────────────┘
```

## 重要なインポートパス

```typescript
import { createTRPCRouter, protectedProcedure } from '@/lib/trpc/procedures';
import { handleServiceError } from '@/lib/trpc/errors';
import { logger } from '@/lib/logger';
import type { Database } from '@/lib/database';
```

## チェックリスト

- [ ] サービス層を `apps/product/src/features/{feature}/server/{feature}-service.ts` に作成
- [ ] ルーターを `apps/product/src/features/{feature}/server/router.ts` に作成
- [ ] `protectedProcedure` を使用（認証必須）
- [ ] `handleServiceError` でエラーハンドリング
- [ ] `user_id` でフィルタリング（マルチテナント）
- [ ] テストファイル作成
- [ ] `apps/product/src/app/api/trpc/_server/app-router.ts` に登録

## 既存ルーター参考

```
apps/product/src/features/
├── timeblock/server/         # 最も大規模な例（router-index + service-index、統計 router 群）
├── activities/server/        # 標準的なCRUD例（query / mutation / archive / delete を service 分割）
├── auth/server/              # ユーザー管理
├── settings/server/          # billing-router / mcp-connections-router を含む複数ルーター
├── contact/server/           # 小さな単一 router の例
└── external-calendar/server/ # 外部 provider 連携（sync / token / revoke の service 群）
```

現行 feature は `activities / auth / calendar / contact / external-calendar / settings / timeblock` のみ（`calendar` は server を持たない）。ここに無い feature 名（entry / notifications 等）は廃止済みなので参考にしない。

## 関連スキル

- `/optimistic-update` - クライアント側のキャッシュ更新
- `/store-creating` - Zustandストアとの連携
- `/security` - 認証/認可の詳細パターン
- `/test` - tRPCエンドポイントのテスト
