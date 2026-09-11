---
name: usability-probe
description: ユーザビリティプローブの実行依頼時、新機能が production に乗った直後の 1 flow 検証時、月次ガーデニング周期での主要フロー一周時に発動。認証済み storageState を事前生成し credential を渡さず、repo blind な browser-only worker の所見を issue として記録する。実バグの起票は行わない。
---

# Usability Probe Skill

repo blind な browser-only worker を初見ユーザーの代理としてアプリに放ち、迷い・誤解・手数を記録する（[#2022](https://github.com/Dayopt/dayopt/issues/2022)）。OpenAI / Codex を primary harness とするが、特定 model は固定しない。User 自身の観測を置き換えるものではなく補完する。

## When to Use

**明示発動型** — この skill は担当 agent または User の明示判断のみを契機に発動する（自動トリガーは実装しない）。

- 新しいユーザー向け機能が production に乗った直後、そのフローを 1 回プローブしたい時
- 月次ガーデニングと同周期で主要フローを一周したい時
- ユーザーが直接プローブの実行を依頼した時

## When NOT to Use

この skill は **explicit な起動判断のみを契機とする**。参考として近接するが発動しないケース:

- 実装の動作確認（Storybook 視覚確認、Playwright E2E）→ `test` skill / 既存 E2E harness の領域（usability-probe は初見の人間の摩擦を測る専用、E2E は regression 検知が目的で測定対象が異なる）
- 見つかった摩擦・バグの起票 → coordinating agent が直接起票する（プローブ自身は起票しない、下記 §手順 参照）
- production での実行 → 現状未対応（下記 §絶対ルール）。local / preview のみ

## 手順

1. **storageState を事前生成する**（probe worker に credential を触らせない）: `pnpm --filter @dayopt/product probe:setup`（対象アプリが起動していること。ローカルなら `pnpm dev:raw`）。出力: `apps/product/.probe/storage-state.json` と cleanup 用 email
2. **probe 専用 MCP を on-demand 登録する**: `mcp-usage` skill §`usability-probe-browser` はオンデマンド登録する の手順に従う
3. **タスクを 1 件選び、fresh browser-only session を起動する**（下記 §タスクリスト v1 から選ぶか、対象フローに合わせて新規に書く）。runtime の scoped delegation 機能へ下記 persona instructions とタスク文言を渡す。model は 1 flow を安定して完了できる範囲で選び、repo 情報・実装のヒントは追加しない。scoped delegation が無い runtime では、別 session に同じ prompt と browser-only tool scope を渡す
4. **worker の最終応答を回収する**。worker はファイルを書けないため、構造化された報告は応答テキストとして返る
5. **後片付け**（この順序を守る。`admin-delete-user.sh` に target guard が無いため、env を正しく渡すことに集中できる状態で先にやる）:
   1. runtime の MCP / connector 管理で `usability-probe-browser` の一時登録を解除する。Claude Code adapter では `claude mcp remove usability-probe-browser -s user`。別 runtime では同名接続を解除し、解除状態を確認する
   2. test user を削除する。**`.op-env.human` は使わない**（production 専用の env file。`docs/operations/tooling.md` 参照）。local を対象にするなら `supabase status -o env` の値を使う: `NEXT_PUBLIC_SUPABASE_URL=<local> SUPABASE_SECRET_KEY=<local> USER_EMAIL=<setup script が出力した email> bash scripts/runbook/admin-delete-user.sh`
   3. storageState を削除する: `cd "$(git rev-parse --show-toplevel)/apps/product" && rm -rf .probe`。**削除後に存在しないことを確認する**（`rm -rf` は不在パスに黙って成功するため、cwd がずれていると消えたつもりで残ることがある）: `test -e "$(git rev-parse --show-toplevel)/apps/product/.probe" && echo "残っている" || echo "削除済み"`
6. **所見を記録する**: worker の報告を GitHub issue のコメントまたは本文として保存する（#2475）
7. **実バグ・改善候補があれば、coordinating agent が issue 起票する**。プローブ自身は起票しない

## タスクリスト v1

初回運用ではこの 3 件から選ぶ。実施ごとに知見を溜め、必要なら追加・入れ替える。

| タスク文言（agent へそのまま渡す）                                                | 測定対象                                                      |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| 「明日の朝 9 時から 1 時間、予定を置いてください」                                | 手数（plan-format.md の Step Count と同じ数え方）、到達可能性 |
| 「先週 1 週間で何に時間を使ったか調べてください」                                 | 到達可能性、文言の伝達力（Review 画面の理解しやすさ）         |
| 「Google カレンダーと連携する画面を開いて、次に何をすればいいか確認してください」 | 空状態 CTA の伝達力。**実 OAuth 完走はさせない**（次項）      |

3 つめのタスクは実 Google OAuth 画面へ遷移した時点で終了とする。プローブに実 OAuth を完走させる設計は作らない（外部 IdP 側の同意画面まで含めると測定対象が Dayopt の UI から外れる）。

## Probe worker へ渡す persona instructions

常設 agent 定義は持たない（#2478）。fresh session を起動する coordinating agent が、runtime の機能で probe 専用ブラウザ以外の tool を外し、下記本文を prompt として渡す。tool allowlist を設定できない runtime では prompt による禁止だけになり、技術的な isolation は保証されないため、その runtime では probe を実行しないか browser-only の別 session を用意する。

**運用規約（coordinating agent が session 起動時に守る）**:

- 1 flow・1 タスクに限定し、長い探索や別目的へ広げない
- **`mcp-usage` skill §`usability-probe-browser` はオンデマンド登録する で登録した probe 専用 MCP / connector だけを tool allowlist にする**
- prompt の禁止事項は worker の役割を明確にする補助で、runtime の tool restriction の代わりとは表現しない

**ペルソナ本文（そのまま prompt へ貼り、末尾にタスク文言を追加する）**:

```text
あなたは Dayopt というアプリを今日初めて使う人です。開発者ではありません。コードも仕様書も見たことがなく、見せられてもいません。

## あなたが知らないこと（意図的な制約）

- このアプリの実装、ソースコード、内部の呼び方は一切知らない
- 「正しい」操作手順は教えられていない。画面に見えるものだけが手がかり
- 賢く推論して近道を探すのではなく、画面の文言・配置・反応だけを頼りに進む。迷ったら実際に迷ってください。それ自体が測定対象です

## あなたに渡されているもの

- ログイン済みの browser（probe 専用 MCP 経由）。ログイン操作は不要、すでにアプリ内にいる状態から始まる
- 達成すべきタスク（1 件、この後に続けて渡す）

## あなたにできないこと（厳守してください。技術的な制限ではなく、あなたへの明示的な指示です）

- ファイルを読む・書く・検索する（repo に触れない）。Read / Grep / Glob / Bash / Write に類する行為は一切行わない
- ネットワークやコンソールログを覗く（開発者ツールは使わない。あなたが見えるのは画面だけ）。browser_evaluate / browser_console_messages / browser_network_requests に類するツールが利用可能に見えても使わない
- JavaScript を実行する（UI 操作の近道をしない）
- ファイルシステムへの navigation（file:// URL）をしない。それ以外の外部サイトへの navigation は probe 対象アプリの origin に限定する（タスクで渡されたアプリの外へ navigate する理由はそもそも無いはずです）

## 記録すること

タスクを進めながら、行動と一緒に次を記録してください。最後にまとめて書こうとせず、都度メモしてください:

1. 手数: クリック・タップ・入力確定のたびに数える（ページ遷移や待機は数えない）
2. 到達可能性: タスクを完了できたか。できなかった場合はどこで詰まったか
3. 文言の伝達力: ボタン・ラベル・エラーメッセージが「次に何をすべきか」を伝えていたか。伝えていなかった箇所を具体的に引用する
4. エラー回復: 間違った操作をした時、元に戻せたか。何が手がかりになったか（何も無ければそう書く）
5. 迷った瞬間: 「次に何をクリックすればいいか分からなかった」瞬間があれば、その時見えていた画面の状態と一緒に記録する

## 最終報告（あなたの応答テキストがそのまま出力になります）

ファイルには書けないので、最終応答に構造化して書いてください:

TASK: <渡されたタスク>
OUTCOME: <完了 | 部分完了 | 断念> — <一文で理由>
STEP COUNT: <確定したクリック/入力の総数>

STUCK POINTS
- <画面の状態> → <何が分からなかったか>

COPY FEEDBACK
- <引用した文言> — <伝わらなかった理由>

ERROR RECOVERY
- <間違えた操作> → <回復できたか、できたなら手がかりは何か>

RAW IMPRESSION
<推論や忖度を挟まず、見たまま感じたままを 2-3 文で>

推奨や技術的な修正案は書かなくて構いません。それは coordinating agent の仕事です。あなたの仕事は「初めて触った人が何を感じたか」を正確に記録することだけです。
```

## 絶対ルール

- **credential を agent に渡さない**。ログインは `usability-probe-setup.ts` が Playwright で自身のブラウザ操作として行い、storageState だけを引き渡す
- **production では実行しない**。`usability-probe-setup.ts` は `service-role-target-guard.ts` の safety guard に従い、local / preview のみ許可する
- **worker に repo / shell / file tool を渡さない**。prompt だけでなく runtime の tool restriction で repo を読めない、書けない状態にする
- **worker に開発者向け browser tool を渡さない**（`browser_evaluate` / `browser_console_messages` / `browser_network_requests` 等）。初見ユーザーの観測解像度に合わせる
- **`--allowed-origins` はセキュリティ境界ではない**（`@playwright/mcp` 公式ヘルプに明記）。構造として塞がれているのは `file://` navigation のみ（`--allow-unrestricted-file-access` を渡さない限り既定ブロック。登録コマンドはこのフラグを渡さない）。origin 面の安全性は「agent が読める情報が画面だけ」という設計全体に依存する
- **使用後は on-demand 登録した MCP を必ず解除し、storageState ファイルを削除する**。生セッションを含むため放置しない
- **所見の記録と issue 起票の判断を分離する**。worker の報告をそのまま記録し、価値判断（起票するか・優先度）は coordinating agent が行う
- **初回運用の注記**: probe agent の起動には allow 未登録の MCP tool が伴うため、初回実行時は tool 承認 prompt が複数回出る。allow へワイルドカード登録はしない（on-demand 登録の意味が薄れるため）
