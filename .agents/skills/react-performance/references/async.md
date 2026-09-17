# 非同期・データ取得の規則（async）

出典: vercel-labs/agent-skills @ 063bee94c3f4df8453406c830b0a7df0f2860278（取得 2026-09-17）の `skills/react-best-practices/rules/`。上流は LICENSE ファイルを持たず、README と SKILL.md frontmatter で MIT を宣言している。転記すべき著作権表示は存在しない。
上流の原文を Dayopt 向けに抜粋・再構成したもので、公式原文そのままではない。更新は `docs/operations/tooling.md` の外部 skill 導入一覧に従う。

適用順は上から。**指摘する前に、その経路が実際に直列化しているかをコードで確認する**。上流の impact 表記（CRITICAL / HIGH）は Dayopt の P1 / P2 ではない。

---

## Promise.all() for Independent Operations

`async-parallel` — impact: CRITICAL（上流表記: 2-10× improvement）

When async operations have no interdependencies, execute them concurrently using `Promise.all()`.

**Incorrect (sequential execution, 3 round trips):**

```typescript
const user = await fetchUser();
const posts = await fetchPosts();
const comments = await fetchComments();
```

**Correct (parallel execution, 1 round trip):**

```typescript
const [user, posts, comments] = await Promise.all([fetchUser(), fetchPosts(), fetchComments()]);
```

---

## Defer Await Until Needed

`async-defer-await` — impact: HIGH（上流表記: avoids blocking unused code paths）

Move `await` operations into the branches where they're actually used to avoid blocking code paths that don't need them.

**Incorrect (blocks both branches):**

```typescript
async function handleRequest(userId: string, skipProcessing: boolean) {
  const userData = await fetchUserData(userId);

  if (skipProcessing) {
    // Returns immediately but still waited for userData
    return { skipped: true };
  }

  // Only this branch uses userData
  return processUserData(userData);
}
```

**Correct (only blocks when needed):**

```typescript
async function handleRequest(userId: string, skipProcessing: boolean) {
  if (skipProcessing) {
    // Returns immediately without waiting
    return { skipped: true };
  }

  // Fetch only when needed
  const userData = await fetchUserData(userId);
  return processUserData(userData);
}
```

**Another example (early return optimization):**

```typescript
// Incorrect: always fetches permissions
async function updateResource(resourceId: string, userId: string) {
  const permissions = await fetchPermissions(userId);
  const resource = await getResource(resourceId);

  if (!resource) {
    return { error: 'Not found' };
  }

  if (!permissions.canEdit) {
    return { error: 'Forbidden' };
  }

  return await updateResourceData(resource, permissions);
}

// Correct: fetches only when needed
async function updateResource(resourceId: string, userId: string) {
  const resource = await getResource(resourceId);

  if (!resource) {
    return { error: 'Not found' };
  }

  const permissions = await fetchPermissions(userId);

  if (!permissions.canEdit) {
    return { error: 'Forbidden' };
  }

  return await updateResourceData(resource, permissions);
}
```

This optimization is especially valuable when the skipped branch is frequently taken, or when the deferred operation is expensive.

For `await getFlag()` combined with a cheap synchronous guard (`flag && someCondition`), see [Check Cheap Conditions Before Async Flags](./async-cheap-condition-before-await.md).

---

## Dependency-Based Parallelization

`async-dependencies` — impact: CRITICAL（上流表記: 2-10× improvement）

For operations with partial dependencies, use `better-all` to maximize parallelism. It automatically starts each task at the earliest possible moment.

**Incorrect (profile waits for config unnecessarily):**

```typescript
const [user, config] = await Promise.all([fetchUser(), fetchConfig()]);
const profile = await fetchProfile(user.id);
```

**Correct (config and profile run in parallel):**

```typescript
import { all } from 'better-all';

const { user, config, profile } = await all({
  async user() {
    return fetchUser();
  },
  async config() {
    return fetchConfig();
  },
  async profile() {
    return fetchProfile((await this.$.user).id);
  },
});
```

**Alternative without extra dependencies:**

We can also create all the promises first, and do `Promise.all()` at the end.

```typescript
const userPromise = fetchUser();
const profilePromise = userPromise.then((user) => fetchProfile(user.id));

const [user, config, profile] = await Promise.all([userPromise, fetchConfig(), profilePromise]);
```

Reference: [https://github.com/shuding/better-all](https://github.com/shuding/better-all)

---

> **Dayopt 注記**: 上流は `better-all` package の追加を例示するが、Dayopt では新規依存を足さない。`Promise.all` の分割と `await` 位置の調整で足りない場合だけ、AGENTS.md の依存追加基準で別途判断する。

---

## Prevent Waterfall Chains in API Routes

`async-api-routes` — impact: CRITICAL（上流表記: 2-10× improvement）

In API routes and Server Actions, start independent operations immediately, even if you don't await them yet.

**Incorrect (config waits for auth, data waits for both):**

```typescript
export async function GET(request: Request) {
  const session = await auth();
  const config = await fetchConfig();
  const data = await fetchData(session.user.id);
  return Response.json({ data, config });
}
```

**Correct (auth and config start immediately):**

```typescript
export async function GET(request: Request) {
  const sessionPromise = auth();
  const configPromise = fetchConfig();
  const session = await sessionPromise;
  const [config, data] = await Promise.all([configPromise, fetchData(session.user.id)]);
  return Response.json({ data, config });
}
```

For operations with more complex dependency chains, use `better-all` to automatically maximize parallelism (see Dependency-Based Parallelization).

---

> **Dayopt 注記**: Dayopt の新規 API は tRPC（Router → Service → Supabase）。同じ waterfall 規則を service 層に適用し、REST route handler の新設は既存 allowlist の範囲でだけ検討する。

---

## Check Cheap Conditions Before Async Flags

`async-cheap-condition-before-await` — impact: HIGH（上流表記: avoids unnecessary async work when a synchronous guard already fails）

When a branch uses `await` for a flag or remote value and also requires a **cheap synchronous** condition (local props, request metadata, already-loaded state), evaluate the cheap condition **first**. Otherwise you pay for the async call even when the compound condition can never be true.

This is a specialization of [Defer Await Until Needed](./async-defer-await.md) for `flag && cheapCondition` style checks.

**Incorrect:**

```typescript
const someFlag = await getFlag();

if (someFlag && someCondition) {
  // ...
}
```

**Correct:**

```typescript
if (someCondition) {
  const someFlag = await getFlag();
  if (someFlag) {
    // ...
  }
}
```

This matters when `getFlag` hits the network, a feature-flag service, or `React.cache` / DB work: skipping it when `someCondition` is false removes that cost on the cold path.

Keep the original order if `someCondition` is expensive, depends on the flag, or you must run side effects in a fixed order.

---

## Strategic Suspense Boundaries

`async-suspense-boundaries` — impact: HIGH（上流表記: faster initial paint）

Instead of awaiting data in async components before returning JSX, use Suspense boundaries to show the wrapper UI faster while data loads.

**Incorrect (wrapper blocked by data fetching):**

```tsx
async function Page() {
  const data = await fetchData(); // Blocks entire page

  return (
    <div>
      <div>Sidebar</div>
      <div>Header</div>
      <div>
        <DataDisplay data={data} />
      </div>
      <div>Footer</div>
    </div>
  );
}
```

The entire layout waits for data even though only the middle section needs it.

**Correct (wrapper shows immediately, data streams in):**

```tsx
function Page() {
  return (
    <div>
      <div>Sidebar</div>
      <div>Header</div>
      <div>
        <Suspense fallback={<Skeleton />}>
          <DataDisplay />
        </Suspense>
      </div>
      <div>Footer</div>
    </div>
  );
}

async function DataDisplay() {
  const data = await fetchData(); // Only blocks this component
  return <div>{data.content}</div>;
}
```

Sidebar, Header, and Footer render immediately. Only DataDisplay waits for data.

**Alternative (share promise across components):**

```tsx
function Page() {
  // Start fetch immediately, but don't await
  const dataPromise = fetchData();

  return (
    <div>
      <div>Sidebar</div>
      <div>Header</div>
      <Suspense fallback={<Skeleton />}>
        <DataDisplay dataPromise={dataPromise} />
        <DataSummary dataPromise={dataPromise} />
      </Suspense>
      <div>Footer</div>
    </div>
  );
}

function DataDisplay({ dataPromise }: { dataPromise: Promise<Data> }) {
  const data = use(dataPromise); // Unwraps the promise
  return <div>{data.content}</div>;
}

function DataSummary({ dataPromise }: { dataPromise: Promise<Data> }) {
  const data = use(dataPromise); // Reuses the same promise
  return <div>{data.summary}</div>;
}
```

Both components share the same promise, so only one fetch occurs. Layout renders immediately while both components wait together.

**When NOT to use this pattern:**

- Critical data needed for layout decisions (affects positioning)
- SEO-critical content above the fold
- Small, fast queries where suspense overhead isn't worth it
- When you want to avoid layout shift (loading → content jump)

**Trade-off:** Faster initial paint vs potential layout shift. Choose based on your UX priorities.
