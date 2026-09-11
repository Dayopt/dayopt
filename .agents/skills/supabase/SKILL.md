---
name: supabase
description: 新規 Supabase migration ファイル(`supabase/migrations/*.sql`)を追加する時、既存 schema に RLS ポリシーを設計・変更する時、Storage バケットポリシーを編集する時、Realtime 購読(`postgres_changes`)を新規実装する時、Edge Functions(`supabase/functions/`)を追加・デプロイする時、production main への DB 変更を適用する時に発動。Supabase Branching による local → PR Preview → production 運用パターンを適用する。アプリケーション層のみの変更では発動しない。
effort: high
maxTurns: 25
---

# Supabaseスキル

Dayoptでの Supabase 運用パターンを支援するスキル。

> ## 現状: Supabase Branching 運用
>
> Dayopt は **1 Supabase project (`dayopt`, ref `yvglwblxrnrenfifsnje`) + PR ごとの Preview Branch** で運用する。標準ルートは `local → PR Preview → production`。
>
> **現状で守ること**:
>
> - migration owner は Supabase GitHub integration
> - Vercel Preview は PR 用 Supabase Preview Branch を参照
> - GitHub Actions から `supabase db push` しない
> - 手動 `db push` は emergency only
> - PR Preview credentials は 1Password に保存しない

## When to Use

以下の状況で発動:

- `supabase/migrations/*.sql` に新規 migration ファイルを追加する時
- 既存テーブルに RLS ポリシーを新規定義、または `USING` / `WITH CHECK` を変更する時
- Storage バケットポリシー(`storage.objects` の RLS)を編集する時
- Realtime 購読(`postgres_changes` subscription)を新規実装・変更する時
- `supabase/functions/` 配下の Edge Function を追加・変更・デプロイする時
- Supabase secrets の追加・変更を行う時

## When NOT to Use

- アプリケーション層のみの変更(tRPC router 内部ロジック、`trpc-router-creating` skill の領域、DB 未変更)
- 認証フローのみの変更で DB schema が変わらない時(`security` skill の領域)
- 型生成結果(`apps/product/src/lib/database/generated/database.types.ts`)のみの更新(`types:generate` 後の自動反映)

## 環境構成

### 原則

**1 Supabase project + ephemeral PR Preview branches**

git の世界観と揃える:

- `main` = production
- persistent staging = 固定URLが必要な時だけ追加
- `feat/*` = preview branch(PR単位、自動生成・自動破棄)

### 環境マップ

| 環境           | 実体                    | ライフサイクル            | 用途                                            |
| -------------- | ----------------------- | ------------------------- | ----------------------------------------------- |
| **Preview**    | Supabase preview branch | PR open〜close(ephemeral) | 日常の開発・PR検証                              |
| **Staging**    | persistent branch       | 必要時のみ                | Stripe webhook検証、OAuth callback、closed beta |
| **Production** | main project            | 永続                      | 実ユーザー                                      |
| **Local**      | `supabase start`        | 任意                      | 手元の開発                                      |

### 守るもの・捨てるもの

**守る:**

- 本番データ・認証ユーザー・APIキーは Supabase branch 機構で完全隔離
- 開発作業は staging/production の DB を直接汚さない
- migration は git history に残り、CI で検証されたものだけが production に到達

**捨てる(=意図的に採用しない):**

- Supabase プロジェクトの物理分離(1 organization で完結)
- ローカル開発からの staging / production 直結
- Dashboard SQL Editor での手動 production migration

## Migration 運用

### 作成フロー

```bash
# 1. ブランチ作成
git checkout -b feat/add-xxx

# 2. migration ファイル作成
npx supabase migration new add_xxx

# 3. SQL編集
# supabase/migrations/YYYYMMDDHHMMSS_add_xxx.sql

# 4. push → PR
git push -u origin feat/add-xxx
gh pr create

# 5. 自動実行
# - Supabase preview branch 自動生成
# - migration が preview branch で実行
# - CI で status check 実行
# - Vercel Preview が preview branch に接続

# 6. PR レビュー・動作確認

# 7. main merge
# - production に migration 自動適用
# - Vercel production 自動デプロイ
```

### Staging branch への適用

通常の PR フローは preview → production 直行。staging を経由するのは**以下の場合のみ**:

- Stripe 本番 webhook との結合検証が必要な migration
- launch 後の hotfix で、本番相当の検証が必要な時
- closed beta 用のデータモデル変更

その場合の手順:

```bash
# staging branch に cherry-pick or merge
git checkout staging
git merge feat/add-xxx
git push
# → staging Supabase branch に自動適用
```

### Preview branch の作られ方

「Supabase preview branch 自動生成」が起きるのは **PR の diff に migration（schema に実影響する変更）が含まれる時だけ**。branch が作られない時に bot が出す文言（`there are no changes detected in supabase directory`）は「directory の変更」と読めるが、**ディレクトリ単位ではない** — `supabase/` 直下に任意のファイルを置いても、`supabase/seed.sql` を編集しても発火しない。「適当なファイルを触って Preview 用の branch を出す」opt-in は成立しない。

**帰結**: `supabase/` を触らない PR の Vercel Preview には Supabase env が注入されず、auth など DB 接続が要る挙動は検証できない（env validation で 500 になる）。**Preview での実挙動確認に依存した検証計画を立てない。** local + production 確認で回すのが既定（[#1461](https://github.com/Dayopt/dayopt/issues/1461)）。

### 未 merge の migration を書き直す時

pre-tool guard が止めるのは **`origin/main` に載っている migration** だけになった（[#2185](https://github.com/Dayopt/dayopt/issues/2185)）。main へ merge された migration は production へ適用されるため改変を禁じるが、未 merge の PR ブランチにしか無い migration は同じ PR 内で直してよい（レビュー指摘の反映・設計の訂正）。guard が古い判定を出す時は `git fetch origin main` を先に実行する。

**ただし push 済みの migration を書き換えた場合、その PR の Supabase preview branch は同じ version を再適用しない**（`supabase_migrations.schema_migrations` に version が残っているため）。preview で実挙動を確認する必要があるなら、preview branch を作り直すか、打ち消し用の migration を別途足す。未 push のうちに直せば、この問題は起きない。

### CLI から preview branch を作る時

調査目的などで手動に作る場合、次の 2 点を外すと確実に失敗する。

**1. `--git-branch` は必須。**

```bash
supabase --experimental branches create <name> \
  --project-ref yvglwblxrnrenfifsnje \
  --region ap-northeast-1 --size micro \
  --git-branch <実在する git branch>
```

省略すると action run の `git_config.ref` が空になり、`migrate` step が `DEAD` で停止する。git `main` への紐付けは **409 で拒否される**（default branch が占有済み）。実在する feature branch に紐付ければ全 migration が適用される。

**2. 手動 branch の credential は Vercel へ同期されない**（integration が自分で branch を作る経路でしか同期が走らないため）。Preview を実際に動かす目的では使えない。

**削除は 2 段階**（persistent の場合）:

```bash
supabase --experimental branches update <id> --project-ref <ref> --persistent=false
supabase --experimental branches delete <id> --project-ref <ref>
```

### migration 失敗時の誤診の罠

**`supabase_migrations.schema_migrations` の記録を信用しない。** branch 作成が失敗した状態でも、baseline (`00000000000000`) と次の 1 件が applied として**記録されるのに、スキーマは空**になることがある。`supabase migration list` の remote 列もこの 2 件を applied と表示する。

この状態では 3 個目の migration が `relation "public.xxx" does not exist` で落ちるため、**その migration 固有の問題に見える**。実際はテーブルが 1 つも無いのが原因。

実体の確認はこちらを使う:

```sql
select count(*) from pg_tables where schemaname = 'public';
```

失敗理由の調べ方（公開 Management API に branch-action log 本文の endpoint は無い。`/v1/projects/{ref}/actions/{run_id}/logs` は失敗 run では log stream 自体が作られず 400 になる）:

```bash
# git_config.ref が空なら --git-branch 未指定が原因
curl -s "https://api.supabase.com/v1/projects/<branch-ref>/actions" \
  -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
  | jq '[.[] | {git_config, run_steps: [.run_steps[] | {name, status}]}]'
```

**API / CLI の出力は `jq` の allowlist 射影だけを表示する。** `supabase branches get` は credential を返す command なので、状態確認には metadata しか返さない `branches list` を使う（[#1920](https://github.com/Dayopt/dayopt/issues/1920)。経緯は git 履歴参照）。

### 機能削除の順序（destructive change）

column / table の削除を伴う機能撤去は 3 段階に分け、1 PR に混ぜない:

1. **コード削除** — 該当 column / table への読み書きコードを全て削除して deploy する（DB 側は温存）
2. **稼働確認** — 本番でエラーが出ていないことを Sentry で確認する
3. **migration drop** — 参照ゼロを確認してから `DROP COLUMN` / `DROP TABLE` migration を別 PR で適用する

先に drop すると、旧コードが動いている deploy 間隙で本番エラーになる。core column 削除で確立した手順。

**1 と 3 を同一 PR に束ねると CI が落とす**（`scripts/ci/check-destructive-migration.mjs` の coupled 判定。既存オブジェクトへの `REVOKE` / `DROP POLICY` / `DROP COLUMN` 等 + `apps/product/**` / `packages/**` の runtime 変更）。Supabase 連携は merge 時に即適用、Vercel promote は E2E 後なので、promote が失敗している間は旧 build が新 schema に当たる（2026-09-08、#2672 で 5 時間 4 分）。新規テーブル雛形の `REVOKE ALL` → `GRANT` や、同 PR で足した列への列レベル `REVOKE` は対象外。

### 命名規則

```
supabase/migrations/YYYYMMDDHHMMSS_description.sql
```

例: `20260420000000_add_streak_column.sql`

### マイグレーションテンプレート

```sql
-- テーブル作成
CREATE TABLE IF NOT EXISTS public.new_table (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- RLSを有効化
ALTER TABLE public.new_table ENABLE ROW LEVEL SECURITY;

-- Data API への明示 GRANT（RLS とセットで必須）
-- Supabase は新規 public テーブルを Data API に自動公開しなくなる方向のため、
-- authenticated role での PostgREST アクセス権を明示的に付与する。
-- anon は原則付与しない（公開読み取りが必要なテーブルのみ SELECT を個別付与）。
GRANT SELECT, INSERT, UPDATE, DELETE ON public.new_table TO authenticated;

-- RLSポリシー
CREATE POLICY "Users can view own data"
  ON public.new_table FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own data"
  ON public.new_table FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own data"
  ON public.new_table FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own data"
  ON public.new_table FOR DELETE
  USING (auth.uid() = user_id);

-- updated_atトリガー
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON public.new_table
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_updated_at();

-- インデックス
CREATE INDEX idx_new_table_user_id ON public.new_table(user_id);
```

### マイグレーション作成時チェックリスト

- [ ] RLS を有効化したか
- [ ] 適切な RLS ポリシーを設定したか
- [ ] `authenticated` への `GRANT` を明示したか（RLS + policy + GRANT をセットで。Data API 自動公開に依存しない）
- [ ] `anon` に過剰な権限を付与していないか（公開読み取りが必要なテーブルのみ `SELECT` を個別付与）
- [ ] 新規テーブルで不要な grant を `REVOKE ALL ON TABLE ... FROM PUBLIC, anon, authenticated` で明示的に閉じたか（**production の `pg_default_acl` は新規 public テーブルに anon/authenticated へ `arwdDxtm`（ほぼ全権限）を既定付与するが、local/Preview は `Dxtm` のみ**。REVOKE を書き忘れると production でだけテーブルが開き、local と CI では再現しない。#1715）
- [ ] Realtime が必要な場合だけ `supabase_realtime` publication に追加したか
- [ ] `user_id` カラムがあるか(ユーザーデータの場合)
- [ ] `ON DELETE CASCADE` を設定したか
- [ ] インデックスを追加したか
- [ ] `pnpm rls:snapshot` で RLS / GRANT / Realtime publication の差分を確認したか
- [ ] preview branch で適用確認したか

## Seed 戦略

### 方針: 最小限

`supabase/seed.sql` には**最小限のカテゴリー / アクティビティと、検証用の Plan / Record のみ**を記述。

理由:

- preview branch はエフェメラルで、毎回 seed 実行のコストを小さくしたい
- アプリ側の UI 動作確認はテストユーザーが手動でデータを作成して行う
- ペルソナベースのシナリオデータは現段階では YAGNI

```sql
-- supabase/seed.sql
INSERT INTO public.categories (id, user_id, name, color) VALUES
  -- 開発用のカテゴリー(色・アイコンを持つのはカテゴリーだけ)
  (...)
;
INSERT INTO public.activities (id, user_id, category_id, name) VALUES
  -- Plan / Record が参照する分類単位
  (...)
;
```

## RLS 設計パターン

### 基本ルール

```
1. 全テーブルで RLS を有効化
2. auth.uid() = user_id でフィルタ
3. tRPC側でも ctx.userId でフィルタ(二重チェック)
4. authenticated への GRANT を明示（RLS は GRANT 済みテーブルへのアクセスを絞るもの。
   GRANT が無いと RLS 以前に permission denied になる）
```

### パターン別ポリシー

```sql
-- 読み取り専用(公開データ)
CREATE POLICY "Public read access"
  ON public.public_table FOR SELECT
  USING (true);

-- 自分のデータのみ
CREATE POLICY "Own data only"
  ON public.user_data FOR ALL
  USING (auth.uid() = user_id);

-- 親子関係(例: タグ → エントリ)
CREATE POLICY "Access via parent"
  ON public.entry_tags FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.entries
      WHERE entries.id = entry_tags.entry_id
      AND entries.user_id = auth.uid()
    )
  );
```

### RLS デバッグ

```sql
-- 現在のユーザーIDを確認
SELECT auth.uid();

-- ポリシーを確認
SELECT * FROM pg_policies WHERE tablename = 'your_table';
```

## Realtime 購読

Dayopt は現状 Realtime を使わない。`supabase_realtime` publication は空が期待値。再導入する時は
購読対象 table を最小化し、RLS policy と `postgres_changes` filter を同じ PR でレビューする。

```sql
SELECT schemaname, tablename
FROM pg_publication_tables
WHERE pubname = 'supabase_realtime'
ORDER BY schemaname, tablename;
```

### 基本パターン

```typescript
import { useEffect } from 'react';
import { createClient } from '@/lib/supabase/client';

export function useEntityRealtime(onUpdate: () => void) {
  useEffect(() => {
    const supabase = createClient();

    const channel = supabase
      .channel('entity-changes')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'entities',
          filter: `user_id=eq.${userId}`,
        },
        (payload) => {
          onUpdate();
        },
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [onUpdate]);
}
```

### 楽観的更新との競合防止

詳細は `/optimistic-update` skill を参照。

## Edge Functions

### 構成

**正本は `supabase/functions/` の実体と `supabase/config.toml` の `[functions.*]` 宣言。** この表ではなく、そちらを確認する。

| Function          | 用途                                 | Preview | Production |
| ----------------- | ------------------------------------ | ------- | ---------- |
| `send-auth-email` | Supabase Auth メール送信(Resend経由) | ✅      | ✅         |

**方針**: preview branch には「PR検証に必要な function のみ」デプロイする。cron は preview で動いても意味がなく、コスト要因になるため除外。

旧 `check-reminders` / `daily-insights` は廃止済み（cron 登録も `20260425000000_unschedule_removed_edge_function_cron_jobs.sql` で解除済み）。

### Auth Hook を Edge Function で受ける時の verify_jwt

**`verify_jwt = false` にする。** Auth の send_email hook は standardwebhooks の署名を付けて POST するが、**JWT は付けない**。`true` のままだと入口で弾かれ、GoTrue 側に `500: Hook requires authorization token` が返り、**認証メールが 1 通も送れない**。画面には汎用エラーしか出ないため、Auth ログを見るまで原因が分からない。

真正性は function 側の署名検証（`SEND_EMAIL_HOOK_SECRET`）で担保する。この設定は `scripts/auth-hook-config.test.ts` で固定している。

### デプロイ経路

**既定は config.toml 宣言による自動デプロイ。** `supabase/config.toml` に `[functions.<slug>]` を宣言した function だけが、Preview branch と production へ自動デプロイされる。宣言が無いと、function を変更した PR をマージしても本番に反映されない。新しい function を追加したら宣言も同じ PR に含める。手動デプロイは緊急時や宣言前の検証に限る。

### デプロイコマンド(手動)

**必須: `--use-api` フラグ**(この環境に Docker がないため、デフォルトの Docker ビルドは失敗する)

```bash
# preview branch
npx supabase functions deploy send-auth-email --use-api --project-ref=<PREVIEW_REF>

# production
npx supabase functions deploy send-auth-email --use-api --project-ref=<PROD_REF>
```

通常は GitHub Actions が自動実行する。

### Secrets 管理

#### マトリクス

| Secret                   | Preview           | Staging               | Production               | 備考                            |
| ------------------------ | ----------------- | --------------------- | ------------------------ | ------------------------------- |
| `RESEND_API_KEY`         | test key          | test key              | **live key**             | Resend は test/live の2分割     |
| `RESEND_FROM_EMAIL`      | `noreply-dev@...` | `noreply-staging@...` | `noreply@dayopt.app`     | 環境別                          |
| `NEXT_PUBLIC_APP_URL`    | preview URL       | staging URL           | `https://app.dayopt.app` | 環境別                          |
| `CRON_SECRET`            | (不要)            | UUID-staging          | UUID-production          | `openssl rand -hex 32`          |
| `SEND_EMAIL_HOOK_SECRET` | test値            | staging値             | production値             | Supabase Auth hook 設定時に発行 |

**Supabase platform 自動注入(触らない):**

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

#### 設定方法

```bash
# CLI経由
npx supabase secrets set KEY=value --project-ref=<REF>

# 一括投入
npx supabase secrets set --env-file .env.edge.<env> --project-ref=<REF>
```

`.env.edge.production` / `.env.edge.staging` / `.env.edge.preview` は **`.gitignore` 必須**。

#### Resend key の切り分け

- **test key**: preview / staging で共用。Resend test mode なので実メール送信されない
- **live key**: production 専用。実ユーザーにメール送信する

## 絶対ルール

### Migration

- production への手動 `db push` 禁止(自動適用フローに一本化)
- production Dashboard SQL Editor での直接クエリ禁止(git 履歴と DB 実態の乖離を防ぐ)
- migration ファイル作成後、そのSQLを git 外の経路で実行することを禁止

### 新規 public オブジェクトの境界（#2433）

新しく `public` へ table / view / SECURITY DEFINER 関数を足す時に守ること。正本は
[`docs/engineering/invariants.md`](../../../docs/engineering/invariants.md) §データ分離（RLS）で、
ここでは「どの migration を書く時に思い出すか」だけを示す（条件の複製はしない）。

- **table**: `ENABLE ROW LEVEL SECURITY` / `REVOKE ALL ... FROM PUBLIC, anon, authenticated` /
  必要な `GRANT` / 権限不変条件の `DO` ブロックを**同一 migration に置く**。REVOKE を GRANT より
  先に打つ（production の `pg_default_acl` が local と違うため、GRANT だけ書くと production に
  過剰権限が残る）。雛形は `20260818130000_create_segments.sql`
- **所有者付きの参照**: 単一 ID FK ではなく `(id, user_id)` の複合 FK にする。参照先に
  `UNIQUE (id, user_id)` の anchor が要る
- **view**: `security_invoker = true` と `_v<N>` 命名が必須。`anon` へ権限を出さない
  （**新規 view には default ACL で `anon` 権限が付くので明示的な `REVOKE` が要る**）。
  旧 version を残したまま新 version を足し、切替後に旧を撤去する（可逆な cutover）
- **旧 version の撤去**: version ごとに exact signature で `REVOKE` / `GRANT` を明示する。
  「新しい方だけ安全にした」状態で旧 version が残るのが典型的な穴
- **`user_id` を持つ table**: account-preserving purge
  （`delete_all_user_data_command_v3`）へ入れるか、消さない理由を
  `user-data-purge-enumeration.integration.test.ts` の allowlist へ書く

いずれも機械で強制されている（`private.assert_public_contract_exposure_v1()` /
`pnpm rls:snapshot:check` / integration test）ので、抜けたら CI か migration 適用で落ちる。

### Edge Functions

- デプロイは必ず `--use-api` フラグ付きで実行
- production の secrets を preview / staging にコピーしない
- `RESEND_API_KEY` の live key は production のみ
- cron function は preview にデプロイしない（現状そのような function は無い）

### Secrets

- `SUPABASE_SERVICE_ROLE_KEY` / `RESEND_API_KEY` 等の秘匿値を**ログ出力・commit しない**
- `.env.edge.*` は `.gitignore` 対象
- secrets の値を `console.log` / `logger` に含めない

### 環境操作

- Staging と Production は同時に触らない（`AGENTS.md` §Deploy / Release）
- production への変更は必ず preview branch での検証を経る
- staging は「Stripe検証 / hotfix / closed beta」以外の目的では触らない

## 関連スキル

- `/optimistic-update` - Realtime 競合対策
- `/security` - 認証/認可パターン
- `/trpc-router-creating` - Service 層での Supabase 使用
