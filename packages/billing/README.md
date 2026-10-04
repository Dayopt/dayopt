# @dayopt/billing

> 責務境界の全体像: [docs/engineering/architecture.md](../../docs/engineering/architecture.md)。課金フロー自体は [docs/product/specs/billing.md](../../docs/product/specs/billing.md)

アプリ横断で使う **public-safe な billing model の source of truth**。
単一有料プランの利用状態・45日間のアプリ体験・subscription status・価格定数を一元化する。
旧Free/Pro識別子と機能別entitlementは移行互換で残し、現行の認可には使わない。
client import できる pure model だけを持ち、Stripe SDK / secret / runtime は **持たない**。

consumer は `apps/product`（settings / access policy / webhook）と `apps/web`（LP pricing）の両方。

## 構造

<!-- docs-live:files:start -->

正本は [packages/billing/src/](src)。現在の一覧は `pnpm docs:read packages/billing/README.md` で生成して読む。

<!-- docs-live:files:end -->

## 入れる / 入れない

**入れる**: plan id / plan name / plan metadata、subscription status とその判定・Stripe からの変換、
アプリ体験と利用状態の判定、旧entitlement互換定数、価格表示用定数（`$0` / `$5` / cents）、trial 日数、上記に閉じた pure helper。
すべて**全環境で同一・公開して安全・副作用なし**。

**入れない（置き場）**:

| 入れないもの                                                                      | 正しい置き場                                                   |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Stripe SDK client / secret / webhook handler                                      | `apps/product/src/lib/stripe` / `app/api/webhooks/stripe`      |
| Checkout / Customer Portal / Invoice 等の Stripe API 操作                         | `apps/product/src/features/settings/server/billing-service.ts` |
| plan 説明文 / 機能リスト / email 本文（翻訳文言）                                 | `apps/*/messages`                                              |
| `BILLING_ENFORCED` / Stripe price ID 等の env 依存値                              | env（`apps/product/src/env.ts`）                               |
| 利用権の enforcement on/off / tRPC `protectedProcedure`・互換 `entitledProcedure` | `apps/product/src/lib/billing` / `lib/trpc/procedures.ts`      |

## 3 つの境界（billing model / Stripe runtime / i18n copy）

- **billing model（この package）**: 全環境同一・公開・静的な「Dayopt が考える課金の意味」
- **Stripe runtime（product server-only）**: secret・SDK・webhook・checkout。Stripe の status は
  `mapStripeSubscriptionStatus()` で billing の `SubscriptionStatus` に変換してから model に渡す
- **i18n copy（messages）**: 翻訳が必要な説明文・機能リスト・email 本文。価格数値や plan id のような
  machine constant は billing を参照し、文言だけ messages に置く

## Boundary（依存方向）

`@dayopt/billing` は zero-dependency。Stripe SDK にも何にも依存しない。

```
apps/product ─┐
apps/web ─────┴──> @dayopt/billing
```

NG: `@dayopt/billing` → `stripe` / `apps/*` / `next/*` / `react` / DB client

## 体験と認可の区別

- `appTrialDays` / `appTrialDurationMs` は、初回アプリ表示から始まる45日・1080時間の体験。`resolveBillingAccess` が現在のprofileと時刻から利用状態を判定する。
- `dayoptProTrialDays` は既存Stripe trialとの移行互換で7日。新方式のCheckoutにはStripe trialを付けない。
- `canUseEntitlement` / `planEntitlements` は旧機能別モデルの互換用。現行のserver認可は `getBillingAccess` と `operation-access.ts` を使い、UIは `BillingAccessProvider` の結果を参照する。
- `BILLING_ENFORCED` による新方式の有効化と本番公開は別判断。[公開手順](../../docs/operations/billing-single-plan-rollout.md)へ従う。
