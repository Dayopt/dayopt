---
status: current
last_verified: 2026-09-21
---

# 9. デプロイ（commit から本番まで）

## この章で答えられるようになる問い

- merge したコードが本番の利用者に届くまで、何が起きるか
- merge したのに本番が変わらない時、どこを見るか
- Preview と Production は何が違うか

## 概念

Dayopt は **merge と本番公開を分けている**。main への merge は本番候補を作るだけで、本番 domain を切り替えるのは Production Release workflow（`promote.yml`）だけ。

```mermaid
flowchart LR
  PR["PR<br/>Vercel Preview（migration を含む PR は Supabase Preview Branch も）"] --> M["main へ merge<br/>ruleset の required checks"]
  M --> MIG["Supabase: migration を本番へ適用<br/>（merge の時点）"]
  M --> B["Vercel: 本番候補を build<br/>（domain 未割当）"]
  M --> I["Production Release: 影響判定"] --> L3["E2E / Web / Storybook"]
  B -.->|"release が build を待つ"| P
  L3 -->|"緑"| P["smoke → promote<br/>本番 domain を切り替え"]
  L3 -->|"赤"| X["公開しない<br/>area:deployment の issue"]
```

**migration は先に入る**。merge の時点で本番 DB に適用され、コードの公開は E2E の後。その間は「新しい DB + 古いコード」が動くので、migration は古いコードでも壊れない形で書く。

## Dayopt ではどうなっているか

[経路: merge → 本番公開](journeys/deploy.md) を ▶ で流し、各段の失敗を見る。

**Preview と Production の違い**:

| 項目                          | Preview（PR ごと）                                                                                                       | Production                                                         |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| DB                            | migration を含む PR だけ Supabase Preview Branch が作られる（本番 DB を参照しない）。app-only の PR は branch を持たない | 本番 Supabase                                                      |
| Sentry                        | 動かない（`IS_SENTRY_PRODUCTION` が偽）                                                                                  | 動く                                                               |
| Resend・Stripe・Google の env | 揃っていなくてよい（MCP の OAuth を有効にした Preview の build では置くこと自体を禁じる）                                | Resend は必須、Stripe と Google は全部あるか全部無いか（`env.ts`） |
| 公開                          | Preview の URL                                                                                                           | promote が domain を切り替えた時だけ                               |

**開いているタブ**は、別のタブが新しい版を開いた時（Service Worker の controllerchange）か、1 分以上たってからタブへ戻った時（`/api/health/version` で版を比べる）に新版に気づき、その時点で編集中でなければ黙って再読み込みする。通知は出ない。編集中だった時は、次にタブが見えるようになるまで古い版のまま。API の入力を必須にする変更は、古いタブからの呼び出しを壊す。

## 正本

- [docs/engineering/infra.md](../engineering/infra.md) の「デプロイフロー」「merge と Production 公開の分離」「merge gate の required checks」
- [docs/operations/runbook.md](../operations/runbook.md) の「Playbook 2: Vercelデプロイ失敗（P1）」
- `.github/workflows/promote.yml`
- `releasing` skill — リリース作業（明示依頼時のみ）

## 自分で確かめる問い

<details>
<summary>1. merge して 30 分経っても本番が変わらない。最初に何を見るか</summary>

`area:deployment` の issue と、Actions の Production Release の run。E2E が赤なら promote されていない。docs だけの merge でも build は作られ、影響判定で project ごとに要否が決まる。

</details>

<details>
<summary>2. 列を削除する migration を入れたい。何が危ないか</summary>

migration は merge の時点で本番に入り、古いコードが E2E 完走まで動き続ける。古いコードがその列を読んでいれば壊れる。先に読まないコードを出し、次の変更で列を消す。

</details>

<details>
<summary>3. Preview では確認メールが届いた。本番でも届くか</summary>

Preview と本番は別の Supabase・別の env。本番の Resend の設定（`RESEND_*`、送信元ドメイン）と Supabase の Auth hook を見る必要がある。Preview での成功は本番の証明にならない。

</details>

## 参照（検査用）

このページの本文が名指ししているコード。`pnpm docs:check` が、ファイルが在り `find` の文字列を含むことを検査する。本文を書き換えたらここも直す。

```json learn:refs
[
  {
    "path": ".github/workflows/promote.yml",
    "find": "Verify candidate migrations are applied in Production"
  },
  {
    "path": "scripts/ci/production-migration-readiness.mjs",
    "find": "**advisory**"
  },
  {
    "path": "scripts/ci/production-release.mjs",
    "find": "Force Promote: skipping smoke and Production Config Audit."
  },
  {
    "path": "docs/engineering/infra.md",
    "find": "app-only の PR には branch を要求しない"
  },
  {
    "path": "apps/product/src/app/[locale]/(app)/_providers/useApplyUpdateWhenSafe.ts",
    "find": "export function useApplyUpdateWhenSafe"
  }
]
```
