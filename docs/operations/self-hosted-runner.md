---
status: current
last_verified: 2026-09-14
code:
  - .github/workflows/promote.yml
---

# promote E2E の self-hosted runner

promote.yml の `🎭 E2E Tests` job だけを、GitHub-hosted から手元の Linux runner へ切り替える手順。private repo の Actions 課金で最大の main push job（直近 30 日 569 分）を runner 側へ逃がす（予算の全体像は [testing.md §Actions 予算](../engineering/testing.md#actions-予算private-repo-前提)）。

**未実施（2026-09-14 時点）。** workflow 側の切替手段だけが入っている。runner の登録と変数の設定は User が行う。

## 境界

- 寄せてよいのは `e2e` job だけ。`web` / `release` / `notify_failure` は Vercel の promote token や `issues: write` を持つので GitHub-hosted に固定する（`scripts/ci/release-workflow-contract.test.ts` が固定）
- runner は Linux 前提。job の入口で `runner.os != 'Linux'` を止める（apt の `--with-deps`、jq、Docker を使うため）
- repo が private で、この job を起動できるのは main push と `workflow_dispatch`（repo の書き込み権限者）だけ。fork PR のコードが runner で走る経路は無い
- 手元の開発用 Supabase とポートを取り合わないよう、**macOS に直接ではなく専用の Linux VM に入れる**（job は `supabase start` / `supabase stop` を実行するので、同じ Docker を共有すると開発中の DB を止める）

## 登録（User 操作）

1. OrbStack で専用の Linux machine を作る（例 `orb create ubuntu dayopt-runner`）。machine の中に Docker、jq、git を入れる
2. GitHub の repo Settings → Actions → Runners → New self-hosted runner（Linux x64 / arm64）の手順で、machine の中に runner を置く。`./config.sh` の label に `dayopt-e2e` を足す
3. `sudo ./svc.sh install && sudo ./svc.sh start` で常駐させる
4. repo Settings → Secrets and variables → Actions → Variables に `PROMOTE_E2E_RUNNER` = `["self-hosted","linux","dayopt-e2e"]` を作る

## 確認

- 次の main push で `🎭 E2E Tests` の run log 冒頭の Runner name が手元の runner になっている
- 所要が GitHub-hosted の実測（平均 7.8 分）から大きく外れていない。Step Summary の retry report で retry-pass が増えていない

## 戻し方

変数 `PROMOTE_E2E_RUNNER` を削除する。次の run から `ubuntu-latest` に戻る。

## 止まった時の症状

- **runner が落ちている / machine が寝ている**: job が `Queued` のまま進まず、promote も待つ（GitHub は最大 24 時間待ってから失敗にする）。急ぐ時は変数を削除して run を re-run する
- **`Require a Linux runner` で失敗**: macOS の runner に label が付いている。label か変数を直す
- **`supabase start` がポート使用中で失敗**: 前回の job の stack が残っている。machine の中で `supabase stop --no-backup` を実行する
