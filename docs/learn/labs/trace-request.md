---
status: current
last_verified: 2026-09-21
---

# Lab: 1 つの依頼を端から端まで追う

壊さずに、Plan を 1 つ作った時に何が起きるかを自分の目で確かめる。[経路: Plan を保存](../journeys/save-plan.md) の答え合わせ。

## 目的

- ブラウザから送られる依頼の数と中身を見る
- DB に入った行と、利用記録（product_events）を見る
- 「保存した後に何を取り直しているか」を見る

## 予想を書く（先に）

1. 「保存」で送られる HTTP の依頼は何本か
2. 保存の後に取り直す query はいくつか。それは何本の HTTP にまとまるか
3. DB の行の `source` は何か

## 準備

- local Supabase を起動している（`supabase status` で API が出る）
- local で product を起動し、サインインしてカレンダーを開く（いつもの `pnpm dev` でよい）
- Chrome の DevTools → Network を開き、フィルタに `api/trpc` を入れる

## 手順

1. サイドバーのアクティビティ（例: `ミーティング`）を 1 回押す。既定の長さで Plan がすぐ作られる
2. Network に出た依頼を上から順に見る。URL の `/api/trpc/` の後ろが procedure 名
3. DB を見る:

```bash
DB_URL=$(supabase status -o json | python3 -c "import json,sys; print(json.load(sys.stdin)['DB_URL'])")
psql "$DB_URL" -c "SELECT id, source, start_at, end_at, created_at FROM public.plans ORDER BY created_at DESC LIMIT 1;"
psql "$DB_URL" -c "SELECT event_name, created_at FROM public.product_events ORDER BY created_at DESC LIMIT 1;"
```

## 観察する 5 点

| 観点     | 見る場所                                     |
| -------- | -------------------------------------------- |
| 画面     | トーストの文言、カードが出るタイミング       |
| DB       | `plans` の行、`product_events` の行          |
| 再試行   | 自動で送り直しているか（Network）            |
| 痕跡     | ログ・Sentry（local では Sentry は動かない） |
| 二重登録 | 同じ時間帯に 2 つできていないか              |

## 実測結果（2026-09-21、local）

<details>
<summary>開く</summary>

- 依頼は 2 本だった。1 本目が `planCommands.create`（200、約 90ms）
- 2 本目は取り直しで、`statistics.getActivityStats` / `plans.list` / `records.list`（2 回）/ `plans.getById` / `statistics.getActivityEstimationFactors` の 6 つが **1 本の HTTP にまとまっていた**（`httpBatchLink`）。成功・失敗どちらでも走る `onSettled` の invalidate
- トースト: 「予定を追加しました ✓」と「元に戻す」
- DB の行は `source = manual`。開始は押した時刻の次の区切り（13:27 に押して 13:28–13:58）
- `product_events` に `plan_created` が行の作成から約 10ms 後に入った（Service が保存の後に送る）

</details>

## 元に戻す

トーストの「元に戻す」を押す（5 秒以内）。過ぎたら Plan を開いて削除する。どちらも行は消えず `deleted_at` が付く（ソフト削除）。

## 関連

- [経路: Plan を保存](../journeys/save-plan.md)
- [2. UI → DB](../02-ui-to-db.md)
- 次の lab: [通信を壊す](break-network.md)

## 参照（検査用）

このページの本文が名指ししているコード。`pnpm docs:check` が、ファイルが在り `find` の文字列を含むことを検査する。本文を書き換えたらここも直す。

```json learn:refs
[
  {
    "path": "apps/product/src/features/timeblock/server/timeblock-command-service.ts",
    "find": "plan_created"
  },
  {
    "path": "apps/product/src/lib/trpc/browser-client.ts",
    "find": "httpBatchLink"
  }
]
```
