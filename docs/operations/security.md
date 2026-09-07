---
status: current
last_verified: 2026-07-30
---

# セキュリティ方針

GitHub Actionsのセキュリティ設定、OWASP準拠のセキュリティ監視・レポート、環境変数/Secrets管理の運用を集約する。Secretsの値そのものの管理手順は [secrets.md](./secrets.md) を参照。

---

# 第1部: GitHub Actions セキュリティ設定ガイド

**参考**: [GitHub Actions Security Hardening](https://docs.github.com/en/actions/security-guides/security-hardening-for-github-actions)

## ワークフロー構成

```
.github/
  dependabot.yml              # 依存関係自動更新
  workflows/
    ci.yml                    # impact（affected 判定）→ static（gitleaks + secrets:check + docs:check + lint/typecheck/knip）∥ unit（+ migration safety）∥ integration（affected 時の RLS/integration）の並列 4 job
    production-config-audit.yml  # Vercel environment metadata 監査
    nightly.yml               # status-label-sweep + replica-check + storage-backup-export の 3 job（#2483 で旧ファイルから統合。night-watch job は 2026-09-02、層 3 と integration は 2026-09-03 に撤去）
    create-release.yml        # GitHub Release 作成
    promote.yml               # main merge 連動の promote。impact → 層 3（E2E / Web Build & E2E）→ release の 3 job
```

## 権限設計

全ワークフローで最小権限の原則を適用。`pull-requests: write` を持つワークフローは無い
（唯一持っていた `ai-review.yml` は 2026-08-03 に撤去した）。

### ワークフロー別 permissions

| ワークフロー                                        | permissions                                                  | 理由                                                                                          |
| --------------------------------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| `ci.yml`（impact job）                              | `contents: read` / `pull-requests: read`                     | PR の変更ファイル一覧の取得（gh api）を行う唯一の job                                         |
| `ci.yml`（static job）                              | `contents: read` / `pull-requests: read`                     | コード読み取りのみ（gh を呼ばないため step env に `GH_TOKEN` を渡さない）                     |
| `ci.yml`（unit job）                                | `contents: read` / `pull-requests: write` / `issues: write`  | migration safety の通知                                                                       |
| `ci.yml`（integration job）                         | `contents: read`                                             | gh を呼ばないため job 単位で最小へ絞る（PR コードを実行する job に書き込み token を置かない） |
| `nightly.yml`（replica-check / storage-backup job） | `contents: read`                                             | コード読み取りのみ                                                                            |
| `nightly.yml`（status-label-sweep job）             | `issues: write` / `contents: read`                           | ラベル一括剥がし                                                                              |
| `production-config-audit.yml`                       | `contents: read` / `pull-requests: read` / `statuses: write` | 固定 context 名での status 発行                                                               |
| `promote.yml`（impact / 層 3 job）                  | `contents: read`                                             | コード読み取りのみ（層 3 は local Supabase で完結し secret を読まない）                       |
| `promote.yml`（release job）                        | `contents: read` / `statuses: write`                         | `Production Release` context の status 発行。workflow レベルには置かない                      |
| `create-release.yml`                                | `contents: write`                                            | タグからリリース作成                                                                          |

`production-config-audit.yml` は `pull_request_target` で走るが、
**`pull_request_target` でも job の check run は PR の `statusCheckRollup` に出る**
（2026-07-30 に PR #1760 で実測。詳細は [infra.md §merge gate の required checks](../engineering/infra.md#merge-gate-の-required-checks)）。
それでも `statuses: write` を持つのは、job 名から独立した固定 context
（`Production Config Audit`）を `finish-branch.sh` の trusted dispatch 免除が照合するため。
**この context を ruleset の required 指定に使ってはいけない**（2026-09-03、#2571。PR で
publish されるのは `paths` に一致する contract 変更 PR だけなので、required にすると
それ以外の PR が永久に `expected` で止まる。詳細は
[infra.md §merge gate の required checks](../engineering/infra.md#merge-gate-の-required-checks)）。

`contents: write` は持たない（外部 API の結果を受けて動く job に書き込み権限を与えない）。

## リポジトリ設定

### Workflow Permissions

**設定場所**: `Settings` → `Actions` → `General` → `Workflow permissions`

```
✅ Read repository contents and packages permissions
□ Allow GitHub Actions to create and approve pull requests
```

### Actions Permissions

**設定場所**: `Settings` → `Actions` → `General` → `Actions permissions`

```
✅ Allow enterprise, and select non-enterprise, actions and reusable workflows

  Allow actions created by GitHub: ✅
  Allow actions by Marketplace verified creators: ✅

  Allow specified actions and reusable workflows:
    actions/*,
    github/*,
    supabase/setup-cli@*,
    softprops/action-gh-release@*
```

### Branch Protection（Required Checks）

**設定場所**: `Settings` → `Branches` → `main` → `Require status checks`

どの context を required にするかは [infra.md §merge gate の required checks](../engineering/infra.md#merge-gate-の-required-checks) を正本とする。ここには複製しない（job 名を変えるたびに 2 箇所が乖離するため）。

private + Free plan では GitHub 側の required check 強制自体が効かず、マージ可否は `scripts/tasks/finish-branch.sh` が判定する。ruleset の実状は API から確認できない（`gh api repos/Dayopt/dayopt/rulesets` は 403 `Upgrade to GitHub Pro` を返す）ため、この画面の設定は手動確認に依存する。

### Fork Pull Request

**設定場所**: `Settings` → `Actions` → `General` → `Fork pull request workflows`

```
✅ Require approval for first-time contributors
```

## Supply Chain 対策

### Actions の SHA 固定

全ワークフローで SHA 固定 + バージョンコメントを使用:

```yaml
uses: actions/checkout@b4ffde65f46336ab88eb53be808477a3936bae11 # v4.1.1
uses: actions/setup-node@2028fbc5c25fe9cf00d9f06a71cc4710d4507903 # v6.0.0
uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4.6.2
```

Dependabot が SHA 固定でも自動更新 PR を作成する。

### SHA 固定の一括変換

```bash
npm install -g pin-github-action
pin-github-action .github/workflows/*.yml
```

## Secrets 管理（GitHub Actions）

### 使用中の Secrets

| Secret                          | 用途              | ワークフロー                   |
| ------------------------------- | ----------------- | ------------------------------ |
| `NEXT_PUBLIC_SUPABASE_URL`      | Supabase 接続     | ci, e2e                        |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase 匿名キー | ci, e2e                        |
| `NEXT_PUBLIC_APP_URL`           | アプリ URL        | ci, e2e                        |
| `SUPABASE_ACCESS_TOKEN`         | Supabase CLI 認証 | emergency only / local scripts |
| `VERCEL_TOKEN`                  | Vercel API 監査   | production-config-audit        |
| `VERCEL_ORG_ID`                 | Vercel team 特定  | production-config-audit        |

`GEMINI_API_KEY` は外部モデル diff レビュー（ai-review）専用だったが、2026-08-03 の撤去に
合わせて **key 自体を失効させた**。GitHub repo secret の削除に加え、Google AI Studio 側の
project と API key を削除済みで、1Password の項目もアーカイブした。**再導入する場合は
key の再発行から必要**で、既存の参照を復元する経路は残っていない。

Migration は Supabase GitHub integration が担当する。GitHub Actions から `supabase db push` は通常実行しない。

### ベストプラクティス（GitHub Actions Secrets）

- 環境変数経由で使用（自動マスキング）
- `echo` で Secrets を出力しない
- フォールバック値はビルド用プレースホルダーのみ

## 監査（GitHub Actions）

```bash
# Secrets 一覧確認
gh secret list

# 最近の失敗確認
gh run list --limit 20 --status failure

# Actions バージョン確認
grep -r "uses:" .github/workflows/ | grep -v "^#" | sort | uniq
```

## 参考リンク（GitHub Actions）

- [Security Hardening for GitHub Actions](https://docs.github.com/en/actions/security-guides/security-hardening-for-github-actions)
- [Automatic token authentication](https://docs.github.com/en/actions/security-guides/automatic-token-authentication)
- [pin-github-action](https://github.com/mheap/pin-github-action)
- [actionlint](https://github.com/rhysd/actionlint)

---

# 第2部: セキュリティ監視・レポート

OWASP準拠のセキュリティ監視の全体像と、定期検査の cadence を定義する。

**関連Issue**: [#487 - OWASP準拠のセキュリティ強化](https://github.com/Dayopt/dayopt/issues/487)

## レビュー体制の層マップ

セキュリティレビューは 4 層で構成する。どの層も単独では完全でなく、コード変更起点（1・2）と時間経過起点（3・4）を組み合わせて成立させる。

| 層         | タイミング               | 実体                                                                                                                                                                                                                                                                                                                  |
| ---------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 実装中     | コード変更ごと           | `security` skill（OWASP 観点のガイド）/ `risk-reviewer` の自動委任（`AGENTS.md §委任・報告の作法` §Read-only delegation）                                                                                                                                                                                             |
| PR ごと    | CI（ready 後）+ merge 前 | `ci.yml` static job の secret scan（gitleaks + `secrets:check`）/ integration job（affected 時）の RLS snapshot drift 検査 / Vercel build の client bundle secret 検査（`verify:bundle`）/ `production-config-audit.yml` / 内製クロスレビュー（`pr-cross-review` skill、外部レビュー廃止後は merge 前に指揮台が発火） |
| 継続       | 常時・自動               | Dependabot alerts（security update は schedule と無関係に即時 PR）/ Actions の SHA 固定 / Sentry / CSP 違反モニタリング / rate limit                                                                                                                                                                                  |
| 定期・随時 | 月次 + オンデマンド      | `/gardening` §5.7 のセキュリティ sweep（advisors + `pnpm security:check` + `/claude-security` 提案）/ `/security-review` / `/code-review`                                                                                                                                                                             |

**束ねた PR のレビュー**: 複数 issue / Step を束ねた PR は merge 前に read-only subagent のクロスレビューを必須とする（`AGENTS.md §PR / git 運用` §PR 粒度）。

## 定期検査の cadence

定期検査の正本は `/gardening` §5.7（月次セキュリティ sweep）とする。実施内容:

1. Supabase security advisors の確認（`mcp__supabase__get_advisors`、read-only）
2. `pnpm security:check`（= `pnpm audit --audit-level=moderate`。後述のローカルパッチ済み advisory は `auditConfig` で除く）
3. `/claude-security` の全体スキャン実行をユーザーへ提案

2 は **CI では実行しない**。依存脆弱性の継続検知は Dependabot alerts が担当し（security update は schedule と無関係に即時 PR が出る）、CI に `pnpm audit` を足すと新しい advisory が公開された瞬間に無関係な PR まで落ちる。Actions 課金が PR 本数に比例する構造（`AGENTS.md §PR / git 運用` §PR 粒度）でもあるため、月次の手動実行に留める。

`image-size@2.0.2` の
`GHSA-w3rx-r6r6-pgpr` と `GHSA-5p2g-fcmc-qvqq` は修正版が未リリースのため、
`pnpm-workspace.yaml` の `patchedDependencies` で上流修正を固定している。
`security:check` は `pnpm-workspace.yaml` の `auditConfig.ignoreGhsas` で
この 2 件だけを除外し、局所パッチの回帰は
`scripts/__tests__/image-size-security-patch.test.ts` で検査する。

secret 検出はこれとは別で、**ready 後の PR で自動実行される**（#2483 で docs-guard.yml から `ci.yml` の static job（`scripts/ci/check.mjs`）へ移設。draft 中は走らず pre-commit hook の gitleaks が一次防衛を担う）。`check.mjs` が gitleaks で base ref からの差分を、`pnpm secrets:check` で tracked tree 全体を見る。加えて Vercel build がビルド後の client bundle への混入を grep する。ローカルでは `pnpm check` に `secrets:check` が含まれる（CI 側は static job の 1 回のみで、二重実行はしない）。

**2026-08-24 以降、`.husky/pre-commit` も gitleaks で staged 差分をスキャンする**（`gitleaks protect --staged`、CI より前に無料で落とす層）。前提として `brew install gitleaks` が必要（`op`/`gh` と同じ host 常駐 CLI 前提、`mcp-usage` skill と同じ運用）。対話環境で未インストールだと commit が hard fail する。**ローカルの gitleaks バージョンは brew の floating latest（本記述時点で 8.30.1）、CI は `scripts/ci/check.mjs` の `GITLEAKS_VERSION`（#2483 で docs-guard.yml から移設。本記述時点で 8.30.1、#2379 で 8.9.0 から更新）に sha256 で pin している。この 2 つは今も意図的に同期させていない**（ローカルはあくまで pre-CI の高速フィルタで、CI が最終網であるため。バージョン固定を hook に持たせると `brew upgrade` のたびに壊れるブリトルさの方が割に合わないと判断した）。**現在バージョン番号が一致しているのは偶然で、今後 `brew upgrade` によりローカルだけ先行する**（CI 側は次に手動で version bump するまで固定のまま）。**非対話環境（`CI` 変数設定 or TTY 無し、例: 月次 gardening 自動パートの cloud Routine）で gitleaks が無い場合は hard fail せず warning のみで commit を続行する**（brew の無い実行環境で全 commit が回復不能に詰まるのを避けるため。secret 検出は ready 後の CI（`ci.yml` static job）が最終網として残るため失われない）。

**`.gitleaks.toml`（repo root）が false positive の抑止設定を持つ**（#2379、gitleaks **8.25.0 以上**が `[[allowlists]]` 構文の前提。ローカルの brew floating latest・CI の pin 版 8.30.1 はどちらも満たす）。`gitleaks detect` / `gitleaks protect` はどちらも明示 `--config` 無しで repo root の `.gitleaks.toml` を自動探索するが、`scripts/ci/check.mjs`（#2483 で docs-guard.yml から移設）は guardrail 実行のため `--config .gitleaks.toml` を明示している。`[extend].useDefault = true` で default ruleset を継承しつつ、Dayopt 固有の既知 false positive だけを追加する。新しい false positive を見つけたら:

1. **値ベースの抑止を第一選択にする**（`regexes` + `regexTarget = "secret"`）。commit / line 番号に依存しないため、将来そのファイルを touch する PR でも再検出されない
2. **path だけで 1 ファイルを丸ごと免除しない**。path で絞る場合も必ず `regexes` と `condition = "AND"` を併用し、値パターンも一致した時だけ抑止する（さもないと、そのファイルへ本物の secret が紛れ込んでも二度と検出されなくなる。`useCalendarKeyboard.ts` の shortcut 文字列がこの形の実例）
3. `regexTarget` は既定の `"match"`（rule の一致範囲全体、例: `key: 'value'` の周辺文字列ごと）ではなく `"secret"`（抽出された値そのもの）を使う。`^...$` の anchored regex を `"match"` に対して書くと、周辺文字列のせいで意図せず不一致になる（#2379 で実際に踏んだ）
4. `targetRules` は必ず実際のスキャン結果（`gitleaks detect --report-format json` の `RuleID`）から取る。推測で書かない

全履歴棚卸しの結果と個々の判定根拠は 決定ログ（削除済み、git 履歴参照） を参照。

3 は `disable-model-invocation: true` のため **モデルが自発的には起動できない**。通常はユーザーが `/claude-security` を叩く。結果は `CLAUDE-SECURITY-<timestamp>/` に出力され、`.gitignore` を同梱するため誤って commit されない。

**cloud session（Claude Code on the web）からの実行**は 2026-09-06 に実測した。`/plugin` の対話 UI は terminal 専用だが、`claude plugin marketplace add anthropics/claude-plugins-official` と `claude plugin install claude-security@claude-plugins-official` の CLI サブコマンドは cloud でも通る。plugin が提供する `claude-security:scan` workflow は**セッション開始時にしか登録されない**ため、導入したセッションからは呼べず、次のセッション以降に使える。

**スキャンの規模はセッションの利用上限で決まる。この repo では 1 回で全体は通らない**（2026-09-06 実測、#2617）。

| 実行                | 規模                    | 結果                                                                                                     |
| ------------------- | ----------------------- | -------------------------------------------------------------------------------------------------------- |
| 全体                | 2,634 ファイル / medium | 約 3 時間走り researcher 98 体・verifier 約 160 体まで進んだが、**レポート生成の直前に上限**。成果物ゼロ |
| 攻撃面へ scope 絞り | 220 ファイル / medium   | researcher 29 体は完走。候補 10 件を得たが**検証パネルの途中で上限**。パネルを通ったのは 2 件のみ        |
| 上記を**再開**      | 同上                    | エージェント 63 体すべて成功、エラーゼロ。確定 5 件 / 却下 3 件、`verification.status: verified`         |

**上限に当たっても捨てなくてよい。`resumeFromRunId` で途中から再開でき、完了済みエージェントはキャッシュから復元される**（実測: researcher 29 体は 1 体も再実行されず、検証パネルだけが走り直した）。手順は run dir を同じパスに作り直して `write_scan_meta.py` を実行し、`Workflow({scriptPath, resumeFromRunId, args})` を同じ args で呼ぶ。plugin は途中結果を run dir へ永続化しないので、run dir を消していても workflow の journal から再開できる。

**ただし再開のたびに候補集合は変わりうる。** 今回、中断時の候補にあった 4 件（auth メールの `redirect_to`、redirect allowlist の wildcard、CSRF の origin 正規表現、`supabase/server.ts` の no-store）は再出現せず、代わりに 3 件（永続化キャッシュのユーザー非分離、`disconnect()` の revoke 漏れ、cron secret の長さ下限）が新たに上がった。researcher の結果がキャッシュ復元されても後段が走り直すためで、**中断時の候補を「所見」として扱ってはいけない**根拠がこれ（#2616 / #2617）。

候補は researcher の主張であって所見ではない。**パネルを通らなかった候補をそのまま修正に着手しない。** 逆に、パネルの却下も所見と同じだけ価値がある（今回 3 件が全会一致で却下され、いずれもコードの該当箇所を引いた反証が付いた）。

**scope から外した領域は「見て問題なし」ではない。** 今回は `apps/product` の 8 ディレクトリに絞ったため、`supabase/`（migration・RLS・Edge Functions の全部）と `scripts/ci` は読まれていない。レポートの Coverage 節が除外領域を明示するので、所見ゼロを clean と読む前にそこを見る。

所見が出た場合は issue に記録し、修正が必要なものは `dispatch` skill の intake で起票する（sweep と同じセッション内で起票まで行う）。

### 前提: `claude-security` plugin

3 の深掘りスキャンは Claude Code の plugin に依存する。MCP サーバー（`mcp-usage` skill）と同じく **user scope の設定に置き、repo には定義を持たない**。新しいマシン / 別プロファイルでは次を実行して導入する。

```bash
claude plugin install claude-security@claude-plugins-official
```

marketplace が見つからない場合は先に `claude plugin marketplace add anthropics/claude-plugins-official` を実行する。Python 3.9 以上が `PATH` に必要（差分スキャンと patch 生成には git checkout も要る）。

**plugin が入っていない環境でも 1・2 は実行できる**。1 は Supabase MCP、2 は repo の `package.json` script で完結するため、深掘りスキャンだけが欠ける状態になる。sweep 時に plugin が未導入なら、上記コマンドを案内した上で 1・2 を実施する。

> 2026-07-27 以前は週次自動レポート（`security-report.yml` / `npm run security:report` / `reports/security/`）を定義していたが、workflow は PR #957 で削除済みで実体が無かった。上記の月次 sweep がその後継。

## 監査ログ（Audit Logging）

アプリ側の独自監査ログテーブルは持たない。`login_attempts` / `auth_audit_logs` は Supabase Auth の `auth.audit_log` との二重管理でありアプリコードからの参照も無かったため、`20260414150000_drop_login_attempts_and_auth_audit_logs.sql` で削除済み。

現在の記録先:

| 対象                             | 記録先                                                                                                                |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| 認証イベント（ログイン・失敗等） | Supabase Auth の `auth.audit_log`（Supabase 側が管理。Dashboard / Auth log で参照）                                   |
| MCP tool call                    | `public.oauth_audit_log` テーブル（`tool_name` / `called_at` を記録。**現状 production からの insert 経路は未実装**） |
| アプリ例外・セキュリティイベント | Sentry（CSP 違反は `csp-violation` として directive 単位の固定 fingerprint で送信）                                   |
| rate limit 超過                  | **専用の記録なし**（下記参照）                                                                                        |

**OAuth token のライフサイクル（発行・更新・失効）を記録するテーブルは存在しない。** `oauth_audit_log` は名前に反して MCP tool call 用のスキーマ（`supabase/schemas/017_tables_oauth.sql`）で、token 操作の記録には使えない。インシデント対応時に「記録が残っているはず」と仮定しない。

**rate limit の超過も記録されない。** `Ratelimit` は product / web とも `analytics: false` で構築しており（raw identifier を保存しないための意図的な設定）、Upstash の request metrics からは拒否されたリクエストを判別できない。

したがって認証攻撃の調査は **Supabase Auth log を主 signal とする**（[monitoring](./monitoring.md) / [runbook](./runbook.md)）。rate limit の効き具合を継続的に見たい場合は、analytics 有効化か 429 応答の計測を別途設計する必要がある。

## レート制限統計

### Upstash Redis

**現在の状態**: Production で稼働中。`@upstash/ratelimit` / `@upstash/redis` は導入済みで、実装は [`apps/product/src/lib/rate-limit/upstash.ts`](../../apps/product/src/lib/rate-limit/upstash.ts)。

`UPSTASH_REDIS_REST_URL` と `UPSTASH_REDIS_REST_TOKEN` が両方設定されている場合のみ有効になる（`isUpstashEnabled`）。未設定の環境ではインメモリ実装にフォールバックする。値の注入は 1Password 経由で、手順は [secrets.md](./secrets.md) を正本とする。

**コスト**:

- 無料枠: 10,000リクエスト/日
- Dayopt想定: 3,000,000リクエスト/月
- 月額コスト: 約$6

## CSP違反モニタリング

Product / WebのCSPは各appのsecurity header設定で強制し、違反は各appの`/api/csp-report`へ送る。report endpointは公開入力境界として次を適用する。

- JSON bodyは16 KiBを上限とし、Zod schemaに合わないreportを400、上限超過を413で拒否する
- ProductionではSHA-256化したIP単位20/分と全体120/分のUpstash rate limitを適用し、超過時は429、backend unavailable時はbodyを読まず503を返す
- `application/csp-report`以外とProduct origin以外のdocument URIを拒否し、未知のdirectiveは`unknown`へ固定する
- document / blocked / source URLからqueryとfragmentを除去し、ブラウザ拡張由来の違反はSentryへ送らない
- WebではVercel Toolbarの`font-src`だけを、directive、blocked origin、既知font path（`/geist.woff2` / `/geist_mono.woff2`）で照合する。`source-file`がある場合はそのoriginも`https://vercel.live`に限定し、`source-file`が省略された場合だけmissingを許容する。未知font path、source origin不一致、lookalike originなどのnear-missは送信する
- 有効な違反だけを`csp-violation`として、directive単位の固定fingerprintでSentryへ送る

### 違反レポート確認

Sentry Issuesで`type:csp-violation`を指定し、directive、正規化済みblocked URI、releaseを確認する。生のURL queryやreport bodyをissue、docs、chatへ転記しない。

## セキュリティメトリクス

### 成功基準（KPI）

- HSTSとCSP enforcementがproduction responseに付くこと
- `/api/csp-report`のinvalid / oversized / rate-limited inputがSentry quotaを消費しないこと
- `pnpm security:check`とCIのsecurity checkが継続して成功すること
- SentryのCSP IssueにURL query、cookie、authorization、user contentが含まれないこと

### ダッシュボード（セキュリティ）

- 月次セキュリティ sweep の結果（`/gardening` §5.7）
- `pnpm security:check` 結果（CI では実行しない。月次 sweep で手動実行する）
- Dependabot alerts（依存脆弱性の継続検知はこちらが担当）/ Supabase security advisors
- Upstash Redis request / latency / error metrics（Ratelimit Analyticsとraw identifier保存は無効）
- Sentry Issues / quota / discarded event

## アラート（セキュリティ）

Sentryの高優先度Issue通知はemailを正規channelとする。認証失敗やvalidation errorなどのexpected errorはIssue化せず、認証攻撃の調査はSupabase Auth logを主signalとする（rate limit analyticsは無効のため使えない。§監査ログ 参照）。閾値と対応手順は[monitoring](./monitoring.md)と[runbook](./runbook.md)を正とする。

## 関連ドキュメント（セキュリティ監視）

- [Error Handling](../../apps/product/src/lib/trpc/errors.ts)
- [Rate Limiting](../../apps/product/src/lib/rate-limit/upstash.ts)
- [Issue #487](https://github.com/Dayopt/dayopt/issues/487)

## 外部リソース（セキュリティ監視）

- [OWASP Top 10:2021](https://owasp.org/Top10/)
- [OWASP Logging Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html)
- [Upstash Rate Limiting](https://upstash.com/docs/redis/features/ratelimiting)
- [Mozilla Observatory](https://observatory.mozilla.org/)
- [SecurityHeaders.com](https://securityheaders.com/)

---

# 第3部: 環境変数・Secrets 運用

環境変数と Secrets の値そのものの管理（1Password 経由の注入、schema、ローテーション手順）は [secrets.md](./secrets.md) を正本とする。本ファイルでは重複を避けるため、GitHub Actions 側の利用箇所（第1部）とセキュリティ監視の対象範囲（第2部）のみを扱う。

GitHub / Vercel / Supabase側のreplicaとenvironment scopeは[environment-secrets.md](./security/environment-secrets.md)に分冊する。AIも値を出力せず、通常のrepo fileとして両文書を参照する。

---

# 第4部: Supabase RPC 権限

Issue #1564 で、Production Security Advisorの
`authenticated_security_definer_function_executable` 13件を次の契約へ整理した。

## RPC判断表

| RPC                            | server caller                          | EXECUTE role                    | 実行属性           | 判断                                                                                          |
| ------------------------------ | -------------------------------------- | ------------------------------- | ------------------ | --------------------------------------------------------------------------------------------- |
| `confirm_day_plans_to_records` | なし（drain 待ち。#1893 で撤去）       | `authenticated`, `service_role` | `SECURITY INVOKER` | owner RLSと`p_user_id` guardでPlanをRecordへ確定する                                          |
| `count_unused_recovery_codes`  | `RecoveryService`のuser-scoped client  | `authenticated`, `service_role` | `SECURITY INVOKER` | owner RLSと`p_user_id` guardで件数だけ返す                                                    |
| `update_personalization`       | user-scoped client                     | `authenticated`, `service_role` | `SECURITY INVOKER` | owner RLSと`p_user_id` guardで設定を更新する                                                  |
| `soft_delete_plan`             | なし（drain 待ち。#1893 で撤去）       | `authenticated`, `service_role` | `SECURITY INVOKER` | owner RLSと`p_user_id` guardで論理削除する                                                    |
| `soft_delete_record`           | なし（drain 待ち。#1893 で撤去）       | `authenticated`, `service_role` | `SECURITY INVOKER` | owner RLSと`p_user_id` guardを使い、`auto_migrated`を常に拒否する                             |
| `restore_plan`                 | なし（drain 待ち。#1893 で撤去）       | `service_role`                  | `SECURITY DEFINER` | authenticated SELECTから隠れたdeleted rowを復元するためdefinerを維持する                      |
| `restore_record`               | なし（drain 待ち。#1893 で撤去）       | `service_role`                  | `SECURITY DEFINER` | deleted row復元のためdefinerを維持し、`auto_migrated`を常に拒否する                           |
| `use_recovery_code`            | `RecoveryService`のservice-role client | `service_role`                  | `SECURITY DEFINER` | recovery codeにauthenticated UPDATE policyを追加せず、service-role JWTと`p_user_id`で消費する |

Plan / Record の 5 RPC は **app から呼ばれない**（#1893 で legacy route と、それを
呼んでいた `PlanService` / `RecordService` の write method を削除した）。EXECUTE を
`authenticated` から剥がす REVOKE と DROP は、旧 bundle の drain 完了後に #1894 で行う。

全対象で`PUBLIC`と`anon`の`EXECUTE`を明示的にREVOKEする。service-role-onlyの3 RPCは
`authenticated`もREVOKEし、`search_path = ''`と完全修飾したrelation名を必須とする。
protected routerは入力からuser IDを受けず、`ctx.userId`だけをserviceへ渡す。

## soft-delete時のRLS境界

PlanとRecordの通常SELECTは`deleted_at IS NULL`を維持する。invoker RPCが更新した直後の行にも
SELECT policyが評価されるため、`soft_delete_plan`と`soft_delete_record`はtransaction-localな
`dayopt.soft_delete_user_id`を設定する。SELECT policyはこの値がrow ownerと一致する同一RPC
transaction内だけdeleted rowを許可する。PostgRESTの通常SELECTや次のtransactionには値が残らず、
deleted rowはauthenticated clientへ露出しない。

## tag hierarchy（廃止済み）

`tags` テーブルと `check_tag_hierarchy()` / `check_tag_has_children()` を含む tags 専有
10 関数は #2175（`20260903120000_drop_legacy_tags_model.sql`）で物理削除した。後継の
アクティビティ / カテゴリーは階層を持たず単一所属を列で表すため、cross-user parent の
検査に相当する制約は `activities_category_owner_fkey`（`(category_id, user_id)` の複合 FK）
が構造的に担う。本節は履歴として残す。

## 検証

- LocalとPR PreviewでSecurity Advisorの該当WARNが0件
- 5 invoker RPCのowner成功とcross-user拒否
- 3 definer RPCのauthenticated `42501`とservice-role成功
- `auto_migrated` Recordのdelete/restore拒否
- 別ユーザーのカテゴリーを指すアクティビティのINSERT / UPDATE拒否（`activities_category_owner_fkey`）
- [RLS snapshot](../engineering/data/db/rls-snapshot.md)のdrift check
