# RLS と権限の設計（Postgres）

出典: supabase/agent-skills @ 8331f910845103c08d51f6ca1d86ebb7d1f745e3（取得 2026-09-17）の `skills/supabase-postgres-best-practices/references/`。License: MIT, Copyright (c) 2026 Supabase.

上流の原文を Dayopt 向けに抜粋・再構成したもので、公式原文そのままではない。更新は `docs/operations/tooling.md` の外部 skill 導入一覧に従う。

**この参照資料は判断材料であり、Dayopt の運用を置き換えない。** migration owner、`local → PR Preview → production`、明示承認、production への手動 `db push` 禁止は `SKILL.md` 側が正本。

**Dayopt の固定条件**（上流より優先する）:

- ユーザー識別は `auth.uid()` に固定する。上流が併記する `current_setting('app.current_user_id')` パターンは使わない
- 新規テーブルは RLS 有効化 + `REVOKE ALL` + `authenticated` への明示 GRANT + policy を同一 migration に置く（`docs/engineering/invariants.md` §データ分離）
- 新規の集計・ビジネスロジックは TS service 層に置く。既存 PL/pgSQL 関数は凍結資産で bug fix のみ
- **性能を理由に RLS を外す・迂回する提案はしない**（REVIEW-1）

---

## Enable Row Level Security for Multi-Tenant Data

`security-rls-basics` — impact: CRITICAL（上流表記: Database-enforced tenant isolation, prevent data leaks）

Row Level Security (RLS) enforces data access at the database level, ensuring users only see their own data.

**Incorrect (application-level filtering only):**

```sql
-- Relying only on application to filter
select * from orders where user_id = $current_user_id;

-- Bug or bypass means all data is exposed!
select * from orders;  -- Returns ALL orders
```

**Correct (database-enforced RLS):**

```sql
-- Enable RLS on the table
alter table orders enable row level security;

-- Create policy for users to see only their orders
create policy orders_user_policy on orders
  for all
  using (user_id = current_setting('app.current_user_id')::bigint);

-- Force RLS even for table owners
alter table orders force row level security;

-- Set user context and query
set app.current_user_id = '123';
select * from orders;  -- Only returns orders for user 123
```

Policy for authenticated role:

```sql
create policy orders_user_policy on orders
  for all
  to authenticated
  using (user_id = auth.uid());
```

Reference: [Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security)

---

> **Dayopt 注記**: 例中の `current_setting('app.current_user_id')` は Dayopt では使わない。`auth.uid() = user_id` を既定とする。

---

## Optimize RLS Policies for Performance

`security-rls-performance` — impact: HIGH（上流表記: 5-10x faster RLS queries with proper patterns）

Poorly written RLS policies can cause severe performance issues. Use subqueries and indexes strategically.

**Incorrect (function called for every row):**

```sql
create policy orders_policy on orders
  using (auth.uid() = user_id);  -- auth.uid() called per row!

-- With 1M rows, auth.uid() is called 1M times
```

**Correct (wrap functions in SELECT):**

```sql
create policy orders_policy on orders
  using ((select auth.uid()) = user_id);  -- Called once, cached

-- 100x+ faster on large tables
```

Use security definer functions for complex checks:

`SECURITY DEFINER` functions run with the creator's privileges and bypass RLS on any tables they touch — which is what makes them useful for internal lookups, but also what makes them dangerous if misused. Always include an explicit `auth.uid()` check inside the function body, keep them in a non-exposed schema, and revoke `EXECUTE` from any role that shouldn't call them directly.

```sql
-- Create helper function in a private schema
create or replace function private.is_team_member(team_id bigint)
returns boolean
language sql
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.team_members
    -- always check the calling user's identity inside the function
    where team_id = $1 and user_id = (select auth.uid())
  );
$$;

-- Revoke direct execution from public roles
revoke execute on function private.is_team_member(bigint) from PUBLIC, anon, authenticated, service_role;

-- Use in policy (indexed lookup, not per-row check)
create policy team_orders_policy on orders
  using ((select private.is_team_member(team_id)));
```

Always add indexes on columns used in RLS policies:

```sql
create index orders_user_id_idx on orders (user_id);
```

Reference: [RLS Performance](https://supabase.com/docs/guides/database/postgres/row-level-security#rls-performance-recommendations)

---

> **Dayopt 注記**: `(select auth.uid())` でのラップと SECURITY DEFINER helper の private schema 配置は Dayopt の既存方針と整合する。helper を新設する時は `_v<N>` 命名と EXECUTE の REVOKE を `SKILL.md` §絶対ルールに従って同じ migration で行う。

---

## Apply Principle of Least Privilege

`security-privileges` — impact: MEDIUM（上流表記: Reduced attack surface, better audit trail）

Grant only the minimum permissions required. Never use superuser for application queries.

**Incorrect (overly broad permissions):**

```sql
-- Application uses superuser connection
-- Or grants ALL to application role
grant all privileges on all tables in schema public to app_user;
grant all privileges on all sequences in schema public to app_user;

-- Any SQL injection becomes catastrophic
-- drop table users; cascades to everything
```

**Correct (minimal, specific grants):**

```sql
-- Create role with no default privileges
create role app_readonly nologin;

-- Grant only SELECT on specific tables
grant usage on schema public to app_readonly;
grant select on public.products, public.categories to app_readonly;

-- Create role for writes with limited scope
create role app_writer nologin;
grant usage on schema public to app_writer;
grant select, insert, update on public.orders to app_writer;
grant usage on sequence orders_id_seq to app_writer;
-- No DELETE permission

-- Login role inherits from these
create role app_user login password 'xxx';
grant app_writer to app_user;
```

Revoke public defaults:

```sql
-- Revoke default public access
revoke all on schema public from public;
revoke all on all tables in schema public from public;
```

Reference: [Roles and Privileges](https://supabase.com/blog/postgres-roles-and-privileges)
