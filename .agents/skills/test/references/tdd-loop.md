# red → green ループの参照資料

出典: [mattpocock/skills](https://github.com/mattpocock/skills) `skills/engineering/tdd/`（`tests.md` / `mocking.md`）@ `959a8e9f1edc3adbe2f7e3054bb6fbefa6696260`（取得 2026-09-17）。
License: MIT, Copyright (c) 2026 Matt Pocock.

上流の原文を Dayopt 向けに抜粋・再構成したもので、公式原文そのままではない。更新は `docs/operations/tooling.md` の外部 skill 導入一覧に従う。

**Dayopt 調整**: 上流の「seam をテスト前にユーザーへ確認する」規則は取り込んでいない（AGENTS.md の AUTONOMOUS に反し、可逆な作業で不要な停止を作るため）。テスト対象の境界は実装者が判断し、迷う場合だけ判断理由を報告に書く。上流が参照する `codebase-design` / `code-review` skill と `CONTEXT.md` は Dayopt に存在しないため参照しない。テスト配置は `SKILL.md` の「`X.test.ts` は `X` の隣」が正本。

---

## 良い test

公開インターフェース越しに**挙動**を検証する。内部構造が全部変わっても、挙動が同じなら test は通り続ける。

```typescript
// GOOD: 観測可能な挙動を検証する
test('user can checkout with valid cart', async () => {
  const cart = createCart();
  cart.add(product);
  const result = await checkout(cart, paymentMethod);
  expect(result.status).toBe('confirmed');
});
```

特徴:

- 呼び出し側が気にする挙動を検証する
- public API だけを使う
- 内部の refactor で壊れない
- HOW ではなく WHAT を記述する
- 1 test に論理的な assertion 1 つ

## 避ける test

### 実装詳細に結合した test

```typescript
// BAD: 内部の協調オブジェクトを mock して呼び出しを検証している
test('checkout calls paymentService.process', async () => {
  const mockPayment = vi.mock(paymentService);
  await checkout(cart, payment);
  expect(mockPayment.process).toHaveBeenCalledWith(cart.total);
});
```

兆候: 自前 module を mock している / private を検証している / 呼び出し回数・順序を assert している / 挙動を変えていない refactor で壊れる / test 名が HOW を説明している。

### インターフェースを迂回して検証する test

```typescript
// BAD: インターフェースを通さず DB を直接見ている
test('createUser saves to database', async () => {
  await createUser({ name: 'Alice' });
  const row = await db.query('SELECT * FROM users WHERE name = ?', ['Alice']);
  expect(row).toBeDefined();
});

// GOOD: インターフェース越しに確認する
test('createUser makes user retrievable', async () => {
  const user = await createUser({ name: 'Alice' });
  const retrieved = await getUser(user.id);
  expect(retrieved.name).toBe('Alice');
});
```

### 恒真な test（tautological）

期待値を実装と同じ手順で計算すると、実装が間違っていても test は通る。**期待値は実装から独立した出所**（既知のリテラル、手計算した例、仕様）から取る。

```typescript
// BAD: 期待値をコードと同じ方法で再計算している
test('calculateTotal sums line items', () => {
  const items = [{ price: 10 }, { price: 5 }];
  const expected = items.reduce((sum, i) => sum + i.price, 0);
  expect(calculateTotal(items)).toBe(expected);
});

// GOOD: 独立した既知のリテラル
test('calculateTotal sums line items', () => {
  expect(calculateTotal([{ price: 10 }, { price: 5 }])).toBe(15);
});
```

これは `SKILL.md` の TEST-1（挙動を証明しない test）と同じ失敗の別の形。

### 水平スライス（horizontal slicing）

test を全部先に書いてから実装を全部書くと、**想像した挙動**を検証することになる。実装を理解する前に test の構造へコミットしてしまい、実際の変更に鈍感な test が残る。

**垂直スライスで進める**: 1 test → 1 実装 → 繰り返し。各 cycle が前の cycle で分かったことに反応する。

## mock の境界

mock は**システム境界だけ**に置く。

mock してよい:

- 外部 API（Stripe、Resend、外部 calendar provider など）
- 時刻・乱数
- ファイルシステム
- DB（可能なら local Supabase の実 DB を優先する）

mock しない:

- 自前の module / class
- 内部の協調オブジェクト
- 自分が制御できるもの

### mock しやすい設計

**依存を注入する**:

```typescript
// mock しやすい
function processPayment(order, paymentClient) {
  return paymentClient.charge(order.total);
}

// mock しにくい
function processPayment(order) {
  const client = new StripeClient(process.env.STRIPE_KEY);
  return client.charge(order.total);
}
```

Dayopt の service 層はこの形になっている（`createActivitiesService(supabase)` など）。service を直接テストし、router や component を経由しない。

**汎用 fetcher より操作ごとの関数**:

```typescript
// GOOD: 操作ごとに独立して mock できる
const api = {
  getUser: (id) => fetch(`/users/${id}`),
  createOrder: (data) => fetch('/orders', { method: 'POST', body: data }),
};

// BAD: mock 側に条件分岐が要る
const api = {
  fetch: (endpoint, options) => fetch(endpoint, options),
};
```

mock の登録順（network mock は login / render / cache warm より前）は `SKILL.md` の「Assert 対象の規約」が正本。
