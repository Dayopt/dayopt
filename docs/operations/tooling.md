---
status: current
last_verified: 2026-09-22
---

# 運用ツール（Eagle / ライセンスコンプライアンス / AI協働ハーネス / 管理者スクリプト）

Eagle デザインアセット管理設計、OSSライセンスコンプライアンスガイド、provider-neutral な AI 協働ハーネス、管理者向け運用スクリプトの記録を集約する。

---

# 第1部: Eagle デザインアセット運用

> Eagle の役割と、何を入れて何を入れないかの規約。エージェント側の invoke 条件は `mcp-usage` skill の Eagle 節を正とする。
> 2026-07-23 に v2 へ全面改訂。旧版（Storybook スナップショット自動同期パイプライン）を廃止した経緯は 2026-07-23-eagle-content-strategy.md（削除済み、git 履歴参照） を参照。

## 1. 役割

**Eagle = 「目で見て判断する素材」の視覚検索ライブラリ。** バックアップ用の保管庫ではなく、日常的に開いて探す場所とする。

原則は 3 つ。

1. **カテゴリごとに「正」を 1 つに決める** — repo から再生成できるものは Eagle に置かない。手作りで再生成できないブランドクリエイティブは Eagle が正
2. **収集物に意味づけを先回りしない** — 集めた参考 UI に一括で意味的なタグを付けない。分類は収集元アプリという機械的な事実だけに留め、横断検索は AI セマンティック検索に任せる。curation（★と pattern タグ）は使う瞬間にだけ行う
3. **repo に Eagle 用コードを持たない** — 接点は Eagle アプリ（人）と Eagle MCP（エージェント）の 2 つだけ

## 2. 何を入れて、何を入れないか

| 入れる                             | 正がどちらか | 理由                                                 |
| ---------------------------------- | ------------ | ---------------------------------------------------- |
| 参考 UI（競合・インスピ）          | Eagle        | 視覚で探して比べるもの。repo に存在しない            |
| ブランドクリエイティブ             | Eagle        | 手作りの一点物。master と variant は repo に入らない |
| 作業用素材（font / icon / illust） | Eagle        | 視覚で選ぶもの                                       |
| リリース節目の製品スクショ         | Eagle        | 過去の姿は再生成できない                             |

| 入れない                   | 正がどちらか           | 理由                                                           |
| -------------------------- | ---------------------- | -------------------------------------------------------------- |
| Storybook スナップショット | Storybook 本体         | 実装カタログは常に最新の本体を見る。構造化情報は Storybook MCP |
| design token の画像        | `packages/foundations` | コードが正。画像化すると二重管理になる                         |
| repo 内アセットの複製      | repo                   | 配信されるファイルは repo が持つ                               |
| 「見ないが念のため」の保管 | git / クラウド         | バックアップは Eagle の仕事ではない                            |

## 3. ライブラリ構造

| フォルダ   | 中身                                                                                                  |
| ---------- | ----------------------------------------------------------------------------------------------------- |
| `Refs/`    | 参考 UI。収集元アプリごとにサブフォルダを分ける（`TickTick` `Tiimo` …）。判別できないものは `_triage` |
| `Assets/`  | 作業用素材。`Icons` / `Fonts` / `Packs`                                                               |
| `Brand/`   | ブランドクリエイティブの正（§5）                                                                      |
| `Product/` | リリース節目のキー画面。手動・少数。ツール化しない                                                    |
| `Archive/` | 旧世代・ボツ案・方針上ここに置かないと判断したもの                                                    |

curated（★4 以上）は横断ビューとして見たいので、Eagle アプリ上でスマートフォルダ `⭐ Picks`（rating ≥ 4）を作る。**スマートフォルダは MCP から作成できない**（この Eagle ビルドに `smart_folder_*` ツールが無い）ため、アプリ上での手作業になる。

新しい参考 UI を保存する時は、browser extension の保存ダイアログで `Refs/{アプリ名}` を選ぶ。該当フォルダが無ければ作る。

## 4. タグと★

**全量タグ付けはしない。** raw の横断検索は AI セマンティック検索（`ai_search_by_text`）が担う。タグは curated だけに付ける。

> AI 検索はプラグイン側のインデックス構築が前提。未構築だと `ai_search_by_text` はエラーを返す。`ai_search_status` の `totalSyncedItems` で確認し、構築は Eagle アプリの AI Search プラグイン画面から行う。

**pattern タグ（12 語彙）**: `onboarding` / `paywall` / `empty-state` / `calendar` / `timer` / `stats` / `settings` / `navigation` / `bottom-sheet` / `list` / `widget` / `notification`

語彙を増やす前に、既存語彙で表現できないかを先に確認する。増やすほど付ける手が重くなり、curation が止まる。

**★の意味**:

| ★   | 意味                            |
| --- | ------------------------------- |
| ★5  | Dayopt で実際に参照して採用した |
| ★4  | 良い参考。見返す価値がある      |
| 無  | 未評価（大多数はこれで正常）    |

## 5. Brand/ — 一枚系クリエイティブ

OGP・SNS 画像・Product Hunt ギャラリー・LP ヒーローなど。手作りの一点物で再生成できないため、**Eagle が正となる唯一のカテゴリ**。

全チャンネルで一貫したブランドを保つ鍵は、完成品ではなく **共通素材の層を分離すること**。OGP も SNS も PH も同じ素材プールから作られる状態にする。

```
Brand/
├── Logo/            ← ロゴ・ロックアップ・アイコンの全 variant（全チャンネル共通の源泉）
├── ProductShots/    ← クリーンに撮った製品スクショの canonical 版（創作の共通材料）
├── OGP/             ← OGP 完成品の master export
├── SNS/             ← SNS 投稿画像の完成品
├── ProductHunt/     ← PH ギャラリー・サムネイル
├── LP/              ← LP / blog 用画像の master
└── Inspiration/     ← 他社の OGP / SNS / バナーの参考
```

運用ルールは 3 つ。

1. **命名**: `{YYYY-MM-DD}_{用途}`（例: `2026-08-01_v0.28-release-ogp`）。時系列で並び、過去の告知が辿れる
2. **出所を annotation に残す**: 元データへのリンク（Figma URL 等）と掲載先（repo path / 投稿 URL）。「あの画像の元データどれ?」を構造的に潰す
3. **タグは campaign + 状態**: `v0.28` / `launch` などの campaign タグ + `shipped` / `draft`。スマートフォルダ `Brand: shipped` が「世に出た創作物の全量」になり、次の制作時にトーンを揃える参照点になる

`ProductShots/` を撮り直したら、旧版に `deprecated` を付けて残す。過去の姿は再生成できない。

## 6. 運用

定常メンテナンス作業は無い。以下の 2 つだけを習慣にする。

- 良い参考 UI を見つけたら Eagle browser extension で保存する（タグ付けは任意）
- 一枚系クリエイティブを作ったら `Brand/` の該当フォルダへ保存し、命名と annotation を書く

curation（★と pattern タグ）は義務ではなく、検索して実際に使った瞬間にだけ行う。サボってもアプリ別ビューと AI 検索は機能し続ける。

新規セットアップは 2 つに分かれる。

- **MCP で作れるもの**: §3 の実フォルダ（`folder_create`）と §4 のタググループ（`tag_group_create`）。エージェントに依頼できる
- **Eagle アプリ上の手作業**: スマートフォルダ（`⭐ Picks` など）。このビルドの MCP に `smart_folder_*` tool は無いため、エージェントからは作成できない

## 変更履歴（Eagle）

| 日付       | 内容                                                                    |
| ---------- | ----------------------------------------------------------------------- |
| 2026-04-08 | 初版作成（Storybook スナップショット自動同期パイプラインとして設計）    |
| 2026-07-23 | v2 へ全面改訂。同期パイプラインを廃止し、視覚参照ライブラリとして再定義 |

---

# 第2部: License Compliance Guide - 開発者向け

Dayopt OSS License Compliance System の使い方ガイド。

このリポジトリは pnpm workspace 形式の monorepo。公開用クレジットは `@dayopt/product` の
production dependency tree を対象に生成する。

## クイックスタート

### 依存関係追加時のチェックフロー

```bash
# 1. 新しいパッケージをインストール
pnpm --filter @dayopt/product add <package-name>

# 2. ライセンス情報を生成
pnpm generate-licenses

# 3. コンプライアンスチェック
pnpm license:check

# 4. リスク分類チェック（GPL/AGPL/LGPL・Dual License・不明ライセンスの検出）
pnpm license:check-risks

# ✅ 合格なら完了
# ❌ 違反があればパッケージを削除して代替を探す
```

### よくある質問（ライセンス）

**Q: MIT、Apache-2.0、ISCライセンスは使える？**
A: はい、すべて承認済みライセンスです。

**Q: GPLライセンスは使える？**
A: いいえ。GPL/AGPLはコピーレフト条項により商用アプリで使用できません。

**Q: ライセンスが不明なパッケージは？**
A: 使用禁止です。法的リスクがあるため、必ず代替パッケージを探してください。

## VS Code統合

### タスクランナー

`Cmd+Shift+P` → `Tasks: Run Task` でライセンス関連タスクを実行:

| タスク名                            | 説明                       | ショートカット |
| ----------------------------------- | -------------------------- | -------------- |
| **📄 Generate License Information** | ライセンス情報を生成       | -              |
| **🔒 License Compliance Check**     | コンプライアンスチェック   | -              |
| **📊 License Statistics**           | ライセンス統計表示         | -              |
| **🔍 View License Policy**          | ポリシー表示               | -              |
| **📋 Full License Audit**           | 完全監査（生成+チェック）  | -              |
| **⚠️ License Check (Strict Mode)**  | 厳格モード（警告もエラー） | -              |

### キーボードショートカット設定（オプション）

`.vscode/keybindings.json` に追加:

```json
[
  {
    "key": "cmd+shift+l",
    "command": "workbench.action.tasks.runTask",
    "args": "🔒 License Compliance Check"
  }
]
```

## CLIコマンド

### ライセンス情報生成

```bash
pnpm generate-licenses
```

**出力**:

- `apps/product/public/legal/oss-credits.json` - Web表示用データ
- `apps/product/public/legal/THIRD_PARTY_NOTICES.txt` - Apache-2.0 NOTICE集約

**実行タイミング**:

- `apps/product/package.json` / `pnpm-lock.yaml` 変更時
- 手動でライセンス情報を更新したい時

**生成対象**:

- `pnpm --filter @dayopt/product licenses list --prod --json --long` の結果
- production dependencies とその transitive dependencies
- private workspace package 自体は除外され、外部 package の license だけを列挙

### 生成物の鮮度チェック

```bash
pnpm license:credits:check
```

`pnpm generate-licenses` の結果と committed file が一致するかを検証する。CI では drift 検出として実行する。

### コンプライアンスチェック

```bash
# 通常チェック（.licensrc.json のルールを適用）
pnpm license:check
```

**チェック項目**:

- ✅ 許可ライセンス: 16種類（MIT, Apache-2.0, ISC等）
- ❌ 制限ライセンス: 自動検出（.licensrc.json の onlyAllow に含まれないライセンス）

### リスク分類チェック

```bash
pnpm license:check-risks
```

`license:check` の allowlist 判定とは別軸の検出（`scripts/tasks/check-license-risks.ts`。CI では未実行、依存追加時の手動実行を想定）:

- **禁止ライセンスパターン**: GPL / AGPL / LGPL / EUPL / CDDL / EPL のバージョン表記を正規表現で検出
- **Dual License のリスクパターン**: `(MIT OR GPL)` のような表記は文字列に `MIT` を含むため allowlist の部分一致だけでは見逃しうる。括弧内に禁止ライセンス名を含む dual license 表記を個別に検出する
- **MIT\* ワイルドカードの詳細**: `MIT*` のような曖昧な表記を明示的にフラグする
- **ライセンス不明パッケージ**: license フィールドが取得できないパッケージを列挙する

`license:check` が通っていても、上記のパターンは allowlist の設計次第ですり抜ける可能性があるため、依存追加時は両方を実行する。

**既知のノイズ**: `[4] Unknown Licenses` は workspace 内部パッケージ（`@dayopt/*`、`UNLICENSED`）を毎回検出し、非ゼロ終了する。これは private package の性質上正しい判定で、新規依存の追加有無に関わらず出続ける。実際に確認すべきは新規追加した外部パッケージがこのリストに現れていないかであり、`@dayopt/*` の行は無視してよい。

### ライセンス統計表示

```bash
# 統計サマリー
pnpm license:audit

# 全パッケージ詳細（JSON形式）
pnpm --filter @dayopt/product licenses list --prod --json --long
```

**例: 統計サマリー出力**:

```
├─ MIT: 719
├─ Apache-2.0: 75
├─ ISC: 63
├─ BSD-3-Clause: 16
└─ BSD-2-Clause: 12
```

## ワークフロー（ライセンス）

### 1. 新規パッケージ追加時

```bash
# Step 1: インストール
pnpm --filter @dayopt/product add lodash

# Step 2: ライセンス情報更新
pnpm generate-licenses

# Step 3: コンプライアンスチェック
pnpm license:check

# Step 4: リスク分類チェック（GPL/AGPL/LGPL・Dual License・不明ライセンスの検出）
pnpm license:check-risks

# Step 5: ライセンス詳細確認（必要に応じて）
pnpm --filter @dayopt/product licenses list --prod --json --long \
  | jq '.[] | .[] | select(.name | contains("lodash"))'
```

**チェック結果**:

- ✅ 合格 → コミット可能
- ❌ 違反 → パッケージを削除して代替を探す

### 2. 依存関係更新時

```bash
# Step 1: 依存関係更新
pnpm --filter @dayopt/product update

# Step 2: ライセンス情報更新
pnpm generate-licenses

# Step 3: 差分確認
git diff apps/product/public/legal/oss-credits.json

# Step 4: コンプライアンスチェック
pnpm license:check

# Step 5: 生成物の鮮度チェック
pnpm license:credits:check
```

### 3. CI/CDパイプライン（ライセンス）

GitHub Actionsが自動実行:

**トリガー**:

- `package.json` / `pnpm-lock.yaml` 変更時
- PR / main push の CI

**処理内容**:

1. コンプライアンスチェック
2. `oss-credits.json` / `THIRD_PARTY_NOTICES.txt` の drift 検出
3. 違反または drift があれば CI 失敗

## ライセンスポリシー

### 許可ライセンス（全16種類）

| ライセンス   | 商用利用 | 注意点                         |
| ------------ | -------- | ------------------------------ |
| MIT          | ✅       | 著作権表示必須                 |
| Apache-2.0   | ✅       | NOTICE表示必須（自動対応済み） |
| ISC          | ✅       | 著作権表示必須                 |
| BSD-2-Clause | ✅       | 著作権表示必須                 |
| BSD-3-Clause | ✅       | 著作権表示 + 推薦禁止条項      |
| MPL-2.0      | ✅       | ファイル単位のコピーレフト     |
| CC0-1.0      | ✅       | パブリックドメイン             |
| 0BSD         | ✅       | 著作権表示不要                 |
| Unlicense    | ✅       | パブリックドメイン             |

### 制限ライセンス（全10種類）

| ライセンス     | 理由                                         | 代替案                               |
| -------------- | -------------------------------------------- | ------------------------------------ |
| GPL-2.0/3.0    | コピーレフト                                 | MITライセンスのパッケージを探す      |
| AGPL-3.0       | 強力なコピーレフト（ネットワーク経由も適用） | Apache-2.0のパッケージを探す         |
| LGPL-2.1/3.0   | 動的リンクのみ許可                           | 代替パッケージを探す                 |
| SSPL           | サーバーサイド利用でソース公開義務           | 代替パッケージを探す                 |
| Commons Clause | 商用利用禁止                                 | 商用利用可能なパッケージを探す       |
| BUSL-1.1       | ビジネス利用に時間制限                       | 代替パッケージを探す                 |
| UNLICENSED     | ライセンス不明                               | 公式ライセンスがあるパッケージを探す |
| UNKNOWN        | ライセンス情報なし                           | 公式パッケージを探す                 |

### 警告ライセンス（3種類）

| ライセンス   | 注意点                                       | 対応         |
| ------------ | -------------------------------------------- | ------------ |
| CC-BY-SA-4.0 | ShareAlike条項（派生物に同一ライセンス適用） | 使用前に確認 |
| EPL-2.0      | 弱いコピーレフト（ファイル単位）             | 使用前に確認 |
| CDDL-1.0     | 弱いコピーレフト（ファイル単位）             | 使用前に確認 |

## トラブルシューティング（ライセンス）

### エラー: "oss-credits.json が見つかりません"

**原因**: ライセンス情報が未生成

**解決方法**:

```bash
pnpm generate-licenses
```

### エラー: "ライセンス違反が検出されました"

**原因**: 制限ライセンスのパッケージを使用

**解決方法**:

```bash
# 1. 違反パッケージを特定
pnpm license:check

# 2. パッケージの詳細確認（違反ライセンスを持つパッケージを探す）
pnpm --filter @dayopt/product licenses list --prod --json --long \
  | jq '.[] | .[] | select(.license != "MIT" and .license != "Apache-2.0" and .license != "ISC")'

# 3. パッケージを削除
pnpm --filter @dayopt/product remove <package-name>

# 4. 代替パッケージを検索
pnpm search <similar-package-name>

# 5. 代替パッケージをインストール
pnpm --filter @dayopt/product add <alternative-package>

# 6. 再チェック
pnpm generate-licenses && pnpm license:check && pnpm license:credits:check
```

### 警告: "検証済みファクターなし"（MFA関連）

**原因**: 開発環境で無関係な警告が表示される場合がある

**解決方法**: 無視してOK（本番環境のみ必要）

### ビルド失敗: "License compliance check failed"

**原因**: CI/CDで制限ライセンスが検出された

**解決方法**:

1. ローカルで `pnpm license:check` 実行
2. 違反パッケージを削除
3. 代替パッケージをインストール
4. 再度プッシュ

## 統計情報の見方（ライセンス）

### ライセンス分布

```
MIT: 719 packages (80.2%)  ← 最も一般的
Apache-2.0: 75 packages (8.4%)
ISC: 63 packages (7.0%)
BSD-3-Clause: 16 packages (1.8%)
BSD-2-Clause: 12 packages (1.3%)
```

**分析**:

- **80%以上がMIT**: 非常に健全な状態
- **Apache-2.0が8%**: NOTICE要件に自動対応済み
- **その他のライセンス**: すべて許可リスト内

### トップ公開者

```
1. Titus Wormer: 114 packages  ← マークダウン関連
2. Mike Bostock: 38 packages   ← D3.js作者
3. Sindre Sorhus: 29 packages  ← Node.jsユーティリティ
```

**意味**:

- 信頼できる著名な開発者のパッケージを多く使用
- エコシステムの健全性が高い

## 関連リンク（ライセンス）

### 外部リソース

- [SPDX License List](https://spdx.org/licenses/) - 公式ライセンス一覧
- [Choose a License](https://choosealicense.com/) - ライセンス選択ガイド
- [TL;DR Legal](https://tldrlegal.com/) - ライセンス要約サイト
- [Open Source Initiative](https://opensource.org/licenses) - OSI承認ライセンス

## 変更履歴（ライセンス）

| 日付       | バージョン | 変更内容                                              |
| ---------- | ---------- | ----------------------------------------------------- |
| 2026-06-29 | 1.1.0      | monorepo / pnpm 前提に更新。生成物 drift check を追加 |
| 2025-10-15 | 1.0.0      | 初版作成（Phase 5完了時）                             |

---

# 第3部: AI 協働ハーネス

**Date**: 2026-09-07
**Scope**: `AGENTS.md`、`.agents/skills/`、provider adapter、共有 hook rules
**Status**: current

## 1. 正本と互換 adapter

- 実装・調査・レビューの共通ガイダンスは `AGENTS.md` を正本とする。OpenAI / Codex が primary harness だが、判断層・Dayopt の不変条件・authority level は provider に依存しない
- project skill の実体は `.agents/skills/*/SKILL.md` に置く。`.claude/skills` は Claude Code が同じ実体を見つけるための相対 symlink で、複製ではない
- `CLAUDE.md` は `@AGENTS.md` を import する互換 adapter。provider 固有の設定を共通ガイダンスへ逆流させない
- runtime / tool 固有の command が必要な skill は、共通の目的・scope・出力契約を先に書き、command を optional provider adapter として示す。別 runtime では同じ契約を満たす generic fallback を使う

## 2. Routing の基準

通常開発は ChatGPT Chat + Codex。短い協働原則は `AGENTS.md`、モデル選択と委譲の詳細は `.agents/skills/routing/SKILL.md` を正本とする。同じ主担当が調査・判断・実装・検証・修正まで完了し、初期の委譲対象は実行時に read-only 境界を検証できる大量調査に限る。

Chat は product / UX・research・仕様整理、Codex は repo に基づく判断と実装を担う。受け渡しが必要な時だけ [Chat 連携手順](./chat-handoff.md) を読む。承認済みの目的・仕様・リスク境界内の技術判断を毎回 Chat に戻さない。

モデル名は難しさ・影響・検証可能性に応じた初期目安であり、実測なしに効率を主張しない。`pnpm ctx` の既存 L0〜L3 / preparation は助言として維持し、別 agent の起動指示にしない。

## 3. Hook の共有と保証境界

判定ロジックは `scripts/hooks/pre-tool-guard-rules.mjs` に置き、provider adapter は runtime の tool-call payload を共有形式へ変換する薄い入口にする。Claude Code は `scripts/hooks/pre-tool-guard.mjs`、Codex は `scripts/hooks/codex-pre-tool-guard.mjs` を入口とする。

adapter の script が存在するだけでは tool call は止まらない。runtime 側で adapter が実行前 hook として登録・起動され、block 結果を尊重する必要がある。repo は user-global 設定、直接 shell、User 自身の UI 操作、未知の tool surface を強制できない。具体的な secret 境界と残余リスクは [secrets.md](./secrets.md) を正本とする。

Codex でこの project を初めて開く時は、project trust を確認し、`/hooks` で `.codex/hooks.json` の command と有効状態を User が 1 回レビューする。repo の `.codex/config.toml` に `hooks = true` があっても、runtime が project を trust して hook を読み込んだ証拠にはならない。`pnpm agent:preflight`（機械利用は `pnpm agent:preflight --json`）は依存、Git hooks、CLI、skills、Codex hook 設定ファイル、read-only delegation の状態を確認するが、runtime の trust や実際の hook 発火は判定できない。read-only delegation は scope を runtime で強制できないため unsupported と表示され、bulk read の経路に使わない。user-global 設定はこの onboarding で変更しない。

### Local / Codex Cloud の実行環境

Node.js と package manager は実行場所ごとに暗黙で選ばせず、repository contract に揃える。

- `.nvmrc` と `package.json#packageManager` が runtime の正本。`pnpm agent:preflight` は Node.js の major、pnpm の version、依存、hook を表示し、不一致なら exit 1 にする
- Codex Cloud の Dayopt 環境は自動 package-manager detection を使わず、setup / maintenance script で `nvm` から `.nvmrc` の Node.js を選び、標準の [`scripts/runbook/codex-cloud-setup.sh`](../../scripts/runbook/codex-cloud-setup.sh) で `packageManager` の pnpm を検証して `pnpm install --frozen-lockfile` を一度だけ実行する
- Cloud の setup / maintenance はネットワークが有効な setup phase で実行し、agent phase のインターネットアクセスは無効のままにする。自動検出が各 workspace へ npm を実行して `catalog:` / `workspace:` を壊す経路を作らない
- Cloud で Docker・local Supabase・実ブラウザ・vault が必要な検証は完了扱いにせず、対応する local または CI の証跡を別に残す

### 実行経路ごとの保護範囲

「機械」は該当 hook が信頼・発火した場合の判定を指す。現時点の native Codex 発火は未確認である。

| 分類・操作                                  | Claude Code                                           | Codex                                                                            | Antigravity                                |
| ------------------------------------------- | ----------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------ |
| 秘密情報: envファイル、vault参照            | Read/Write/Edit と Bash の個別パターンを機械検査      | apply_patch の全対象・shell の個別パターンを機械検査。汎用read toolはsurface依存 | repo hook接続なし。指示で制御、実動未確認  |
| 破壊的操作: 既存migration・他worktreeの編集 | Write/Editで機械検査。任意shell編集は保証外           | apply_patch の変更元/先・symlinkを機械検査。任意shell編集は保証外                | 指示で制御、機械保護は未対応               |
| Git運用: force push、no-verify、直接merge等 | Bashの列挙パターンを機械検査                          | 共通Bash判定を再利用                                                             | 共通Git hookのみ。tool実行前の検査は未対応 |
| 大量の読み取り調査                          | scope を runtime で強制できないため委譲しない         | scope を runtime で強制できないため委譲しない                                    | read-only 境界を確認できないため委譲しない |
| コスト・利便性                              | モデル名に基づく委任制限は撤去。起動確認は共通command | 同左                                                                             | 共通commandを手動利用可能、実動未確認      |

**shell の任意編集は機械的に閉じていない**。`sed -i`、`perl -pi`、`cp`、`mv`、`tee`、出力redirect、任意scriptによる既存migration・他worktreeへの書き込みを、このadapterは一般には検出しない。Codexのファイル変更は原則 `apply_patch` を使い、shell編集へ切り替えてこの検査を迂回しない（指示による制御）。hookに到達しただけで全操作が保護されるわけではない。write_stdin、hosted/specialized tool、wrapper内部の処理も同じ保証を持たない。

この境界はshell interpreterの自作で埋めず、runtimeの書き込み範囲・Git hooks/CI・最小権限の資格情報で補う。本番は既存の明示権限・独立レビュー・dry-run/backupを維持する。上記が不足する操作は未対応として扱い、通常開発の実動試行でも境界を確認する。

### 実測で分かった罠（guard / hook / scripts）

2026-09-22 に Claude Code の memory から昇格。判定ロジックは共有なので Codex の adapter でも同じ形で起きる。

- **guard は「言及」でも止まる**。判定は tool call の command 文字列全体を見るので、禁止コマンド名を説明する commit message / issue コメント / review reply の heredoc も同じ文字列一致で止まる（2026-08-24 #2293 で 4 回）。これは意図した trade-off で guard 側を緩めない。本文はファイルへ書いてから `gh ... --body-file` / `git commit -F` で渡し、言い回しを変えて該当句の連続を崩す
- **textual guard は shell 展開を捕まえられない**。quote 剥がしで allowlist を補強しても `$'\x2d\x2d...'` や `${IFS}` は素通りする（#2291 PR #2309）。動的引数のコマンドを許す時は「値をコマンドラインに載せない」方向へ寄せる（body は固定パスの `--body-file`、`--repo` は値ごと固定）。展開形を 1 つずつ追いかけない
- **壊れると自分の編集まで止まるファイル（hook script / `.claude/settings.json` / `.codex/hooks.json`）は scratch 先行で触る**。構文エラーでも exit 2 が「止める」と解釈され、直す編集自体ができなくなる（2026-08-12）。scratch に候補を書き `bash -n` と実挙動を通してから `cp` で設置する。復旧は別 session か User に `git -C <worktree> checkout -- <path>` を 1 コマンド依頼する
- **migration guard は `refs/remotes/origin/main` の tree に載っているファイルだけを止める**（#2185 PR #2714）。未 merge の PR にしか無い migration は push 済みでも編集できる。止まったのに未 merge のはずなら `git fetch origin main`。判定不能（ref 不在 / git 不動）は全部止める
- **root `package.json` の script を改名・統合する時は permission allowlist を両方向で見る**。消す側が wildcard に一致して許可され、残す側が漏れて prompt に落ちる向きが本当の failure（2026-08-18）。統合後の名前を実際に叩いて prompt が出ないか確認し、消した名前の pattern は同時に削る（許可範囲は広げない）
- **`scripts/` に新規ファイルを足して docs から名指しすると taxonomy test が `runbook` 判定にする**（`classifyHits` は docs の言及を importedBy より先に見る）。`scripts/lib/` の純粋な lib でも落ちるので、`scripts/__tests__/scripts-taxonomy.test.ts` の `KNOWN_PLACEMENT_EXCEPTIONS` へ理由つきで追記する（2026-09-16 #2775 で 2 回）
- **skill の効果は発動条件と揃えた依頼でしか測れない**。既存 migration の「レビュー」依頼では両条件とも `supabase` skill を読まず「効果なし」と誤判定しかけた（#2810）。どの skill が読まれたかは `codex exec --json` の `exec_command_begin` から `.agents/skills/<name>/` を grep して機械的に取る。自己申告は根拠にしない
- **`codex exec` の隔離と model**: `--cd <pack-dir> --sandbox read-only --skip-git-repo-check` は cwd を pack へ固定し書き込みを禁じるだけで、agent は `..` や絶対パスから repo を読める。**読み取りの隔離にはならない**ので、比較実験で正解データや現在の修正が漏れてはいけない時は、container / chroot / 読み取り許可 root の制限のように repo を実際に不可視にする境界を使う。`-m` を省くと config の既定 model が 400 で落ちることがある。応答が名乗る model 名は run ごとにぶれるので、証拠は起動コマンド側に残す（2026-09-10 実測）
- **usage limit は turn 途中で run を落とす**。`turn.failed` で `token_count` が出ず tokens が null になるのが機械的な見分け方。比較実験は条件ペアで交互に回さず 1 条件を全ケース終えてから次へ行き、欠損を片側に寄せる。中断を「効果なし」と書かない（2026-09-17 #2810）

## 4. Skill 設計

新規・更新時は `.agents/skills/skill-design/SKILL.md` に従う。description / When to Use は provider-neutral にし、特定 model の名前を発火条件や必須 tier にしない。provider 固有の adapter は capability、scope、出力契約、generic fallback、実際の保証境界を併記する。

## 5. 外部 skill の導入一覧

外部 skill は **Dayopt 向けの調整版**として取り込む。公式原文そのままではなく、上流を fork した配布物でもない。runtime にリモートを取得する構成（上流の `web-design-guidelines` が `main/command.md` を毎回 fetch する形）は採らず、下表の commit SHA で固定したスナップショットを正本にする。

| Dayopt skill             | 上流                                                                                                         | 固定 commit SHA                            | 取得日     | License / 表示                                                                                           | 取り込んだファイル                                                               |
| ------------------------ | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------ | ---------- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `react-performance`      | [vercel-labs/agent-skills](https://github.com/vercel-labs/agent-skills) `skills/react-best-practices/rules/` | `063bee94c3f4df8453406c830b0a7df0f2860278` | 2026-09-17 | LICENSE ファイル無し。README と SKILL.md frontmatter が MIT を宣言。**転記すべき著作権表示は存在しない** | `references/async.md`（async 系 6 本）、`references/bundle.md`（bundle 系 6 本） |
| `ui-audit`               | [vercel-labs/web-interface-guidelines](https://github.com/vercel-labs/web-interface-guidelines) `command.md` | `e3d624baaf29dc1fc645aff3e38f03e564d2d6b1` | 2026-09-17 | MIT, Copyright (c) 2025 Vercel Labs（表示を各ファイル冒頭に保持）                                        | `references/web-interface-guidelines.md`                                         |
| `diagnosing-bugs`        | [mattpocock/skills](https://github.com/mattpocock/skills) `skills/engineering/diagnosing-bugs/`              | `959a8e9f1edc3adbe2f7e3054bb6fbefa6696260` | 2026-09-17 | MIT, Copyright (c) 2026 Matt Pocock                                                                      | 骨格のみ（ファイル転記なし。`SKILL.md` に出典を記載）                            |
| `test`（既存へ統合）     | [mattpocock/skills](https://github.com/mattpocock/skills) `skills/engineering/tdd/`                          | `959a8e9f1edc3adbe2f7e3054bb6fbefa6696260` | 2026-09-17 | MIT, Copyright (c) 2026 Matt Pocock（表示を各ファイル冒頭に保持）                                        | `references/tdd-loop.md`（`tests.md` / `mocking.md` の抜粋）                     |
| `supabase`（**見送り**） | [supabase/agent-skills](https://github.com/supabase/agent-skills) `skills/supabase-postgres-best-practices/` | `8331f910845103c08d51f6ca1d86ebb7d1f745e3` | 2026-09-17 | MIT, Copyright (c) 2026 Supabase                                                                         | 取り込んだが 2026-09-17 に撤去（比較で便益を確認できず。下記の理由）             |

### 適用除外（上流をそのまま適用しない点）

| 対象                                                       | 除外した理由                                                                                                                                                                                                                    |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bundle-barrel-imports` を内部 import へ適用すること       | Dayopt は feature 間の barrel 経由が必須で、`pnpm lint:boundaries` が deep import を機械的に禁止する。第三者 package のみ対象                                                                                                   |
| `client-swr-dedup` ほか SWR 前提の規則                     | 新規 API は tRPC が正本。SWR を新規依存として足さない                                                                                                                                                                           |
| `server-cache-lru` / `js-cache-function-results`           | ユーザーをキーに含めない module cache はユーザー間でデータが混ざる（REVIEW-1）。cache は認可・request 境界を確認して設計する                                                                                                    |
| React の server / client / rerender / js 系 70 本の全量    | 上流 `AGENTS.md` は 3810 行。索引と全量 vendoring は読む量に見合わない。必要時は固定 SHA から読む                                                                                                                               |
| UI guidelines の runtime fetch（`WebFetch`）               | 規則が固定されず再現しない。スナップショットを正本にする                                                                                                                                                                        |
| UI guidelines の Title Case / カーリークォート規則         | 英語だけに効く copy 規則。ja / en の文言は用語集と `pnpm copy:check:strict` が正本                                                                                                                                              |
| `nuqs` / `virtua` などの library 提案                      | 既存の state 管理・描画で解く。依存追加は AGENTS.md の基準で別途判断する                                                                                                                                                        |
| `diagnosing-bugs` の仮説 3〜5 個・100x / 1000 入力の固定値 | 反復回数と仮説数は症状ごとに決める。一律の下限を全バグへ課さない                                                                                                                                                                |
| `tdd` の「seam をテスト前にユーザーへ確認する」規則        | 可逆な作業で不要な停止を作る（AGENTS.md の AUTONOMOUS）。境界の判断は実装者が持つ                                                                                                                                               |
| Postgres の conn / data / monitor / partitioning 系        | Supavisor は Supabase が管理し、現状の規模で判断材料にならない                                                                                                                                                                  |
| Postgres 参照資料そのもの（撤去済み）                      | index / RLS / lock の 3 本を `supabase` skill へ置いたが、migration 追加ケースの比較で **baseline と同じ index 定義**にしか到達せず、候補だけ lock ガードを落とした。便益を確認できないものは常設しない（#2810 の受け入れ条件） |
| 上流 skill の `scripts/` `agents/*.yaml`                   | `.agents/skills/**` の `.md` 以外は CI の docs-only 判定を外す（`scripts/ci/impact.test.ts`）。現状不要                                                                                                                         |

### 更新方法

1. 上表の固定 SHA と上流の最新 SHA の差分を読む（例: `gh api repos/vercel-labs/agent-skills/compare/<固定SHA>...main`）
2. Dayopt の境界（依存方向、tRPC、ユーザー分離、migration 運用）と衝突しないか判断する
3. 取り込む差分だけを手で反映し、上表の SHA と取得日を同じ変更で更新する

比較検証の記録と採否は [外部 skill 導入の比較検証（#2810）](./ai-skills-trials-2810.md)。**入口から参照資料へ到達することと、その資料が結果を良くすることは別**で、Postgres 参照資料は前者だけを満たしたため撤去した。

**自動更新、未監査スクリプトの実行、runtime のリモート取得は行わない。** UI guidelines の `command.md` は skill 本体（vercel-labs/agent-skills）とは別 repo の依存であり、上表で別行として固定する。

## 6. Independent PR Review

GitHub の `@codex review` は `protected-path-gate.mjs` が判定する外部契約・不可逆・ガードレール変更だけで使う。依頼時点、対象 SHA の照合、所見の裁定は `.agents/skills/pr-cross-review/SKILL.md` を正本とし、通常 PR や実装途中では起動しない。未応答・古い結果・未実行は指摘0とは異なる。

高リスク変更の immutable pack / role / envelope / validation（`pnpm review:pack` / `review:sweep` / `review:validate` と固定差分レビュー手順）は 2026-09-20 に撤去した。追加 reviewer の停止から 3 日で一度も再開されず、pack を通した証跡も残っていなかったため、読むためだけの実装を維持しない。再開する時は git history から読む。既存の `[review-summary]` は読み取り互換だけを残す。不可逆操作の独立レビュー条件は通常レビューで置き換えない。

read-only と repository scope を runtime で同時に強制できる delegate は現在ないため、大量の repository 読み取り調査は親担当が行う。現行 native delegation は実際の入力に read-only / write を区別する型がなく、判別不能な経路として read-only を含めて拒否する。runtime が別名の typed write / browser tool を提供した時だけ、User が明示した非重複 scope と既存の authority 契約に従って扱う。将来、両方を実測できる adapter が追加された場合だけ、Luna / Haiku の候補と env・timeout・fallback 契約を再評価する。

## 7. Migration acceptance と handoff

native worktree root の fresh Codex session による共通指示・skills の発見と、サブディレクトリ起動の別 Codex session への review pack 引き継ぎを確認した。Codex の project trust と実 hook 発火、Antigravity の skill discovery と review adapter は未検証であり、設定ファイルの存在を有効化の証拠にしない。

2026-09-07、`scripts/tasks` から新規 Codex read-only セッション（gpt-5.6-sol、session `01a0796e-8943-7303-9bb3-6184e41a9b2f`）を起動し、base `393f432c6` → head `bbdb9510a` の移行差分を pack で手渡した。result envelope は `reviewed`、recommendation は `revise`、指摘 1 件だった。指摘は shell の任意編集に対する保証の過大解釈で、経路別の保護表へ保証外の操作を明記した。これは別 OpenAI セッションの反証であり、別モデル系列の反証や native hook 発火の証拠ではない。旧 SHA の所見を後続 SHA の指摘ゼロとして再利用しない。

次の 3 trial は過去の移行計画として記録したもので、2026-09-17 の User 指示により追加 reviewer の試行は行わない。ここに別の常設 tracker は作らない。

| trial                    | 対象                                                 | status  |
| ------------------------ | ---------------------------------------------------- | ------- |
| **通常バグ修正**         | 1 feature 内の再現可能な bug fix 1 件                | stopped |
| **複数ファイル変更**     | 複数 file / connection point を含む変更 1 件         | stopped |
| **高リスク diff review** | auth / RLS / billing / migration / 公開契約など 1 件 | stopped |

各 trial は次の 4 軸で評価する。

1. **成功条件**: issue / PR の受け入れ条件と検証結果を満たしたか
2. **説明し直し救済**: 曖昧さや誤解が生じた時、User が全体を説明し直さず issue / PR / pack の事実から修正できたか
3. **手戻り・見逃し**: review 後の修正 round、revert、見逃した P1 / P2、未解消 unknown を記録できたか
4. **別 session 再開**: fresh separate session が issue / PR / pack だけから対象 SHA と次の一手を復元できたか

`stale` / `partial` / `not-run` / `invalid` の区別と、未完了 result を findings 0 にしない契約は自動 test 24 件で検証済みである。これは実 PR での上記 3 trial や reviewer 品質の代替ではない。

`pnpm ai:usage` と `pnpm trace` の session / token / tool データは Claude Code local transcript のみを収集する。Codex / Antigravity は `null` / unknown であり 0 ではない。GitHub 由来の aggregate PR outcomes は repo 全体の値なので、Claude Code の token や session で割って provider の効率を主張しない。

---

## 履歴: Opus 4.7 Skill Triggers Migration

以下は当時の移行記録であり、現在の発火規約ではない。旧モデル向けの要素数・形式・自動起動の推奨を現在のモデルへ自動適用しない。現行の正本は `skill-design` と各 skill。

**Date**: 2026-04-17
**Scope**: 現在の `.agents/skills/` に移行済みの project skills 12 個
**Status**: 完了

## 1. 背景

Claude Opus 4.7 は Opus 4.6 より **subagent / skill の自動起動が控えめ** になった。delegation 判断が厳しくなり、曖昧な description では skill が invoke されなくなるケースが増えた。

skill invocation は description を読んで判断される仕様上、**description が invocation 判断の主戦場、本文は invoke 後の行動強化**という役割分担を前提にチューニングが必要になった。

## 2. 対象と範囲

**対象**: project skills 12 個（現在は `.agents/skills/` 配下、repo commit される）

- `storybook` / `security` / `test` / `optimistic-update`
- `trpc-router-creating` / `store-creating` / `i18n` / `error-handling`
- `supabase` / `docs-writing` / `releasing` / `eagle-dayopt`

**スコープ外（別タスク）**:

- user-global skills（`~/.claude/skills/` 配下、個人設定）の 4.7 チューニング
- adversarial review 等の subagent 設計（`.claude/agents/` ディレクトリ自体が現状存在しない）

**実施内容**:

- 各 skill の description をリライト（先頭句に具体トリガー列挙を埋め込む）
- `## When to Use` / `## When NOT to Use` セクションを新設または更新
- skill 間の境界を NOT 条件の括弧明記で self-documenting 化
- `supabase` skill で invocation トリガーと実行時ルールを別セクションに分離

## 3. 展開プロセス（参考）

将来類似の migration（4.8 対応、skill 群一括追加など）で再利用できるメタパターンとして記録する。方法論として独立させるほどの蓄積はまだないため、本節内に「参考」として置く。

### Phase A: 型安定性検証（pilot + 高標準度）

- Pilot: `storybook`（新設パターン）+ `security`（リライトパターン）を同時に仕上げ、**「新設」と「リライト」の両方の型**を 1 バッチで固める
- 検証: `test` + `optimistic-update` で pilot の型が他 skill でも機能するか本番検証

判断基準: 1 skill だけの pilot だと「既存 When to Use あり / なし」のどちらか一方しかカバーできない。2 skill 同時だと型の両側が固まる。

### Phase B: 標準型で機械展開

- B-1: `trpc-router-creating` + `store-creating`（作成系）
- B-2: `i18n` + `error-handling`（予防系）

判断基準: Phase A で型確定後は機械的に処理できる skill を先に。境界の括弧明記ルールが自然に適用される。

### Phase C: 例外系（型拡張しながら個別対応）

- `supabase`（字数 250 字拡張、軸混在特例）
- `docs-writing`（副次トリガー型、見出しラベル変更、要素数 7 まで許容）

判断基準: 標準型から外れる skill は Phase A/B と混ぜると型が揺らぐ。まとめて Phase C で拡張ルールを決めながら書く。

### Phase D: 単独扱い

- `releasing`（明示発動型、NOT=該当なし + 近接ケース列挙）
- `eagle-dayopt`（ライフサイクル型、パイプラインステージ分割、要素数 8 まで許容）

判断基準: 型が質的に異なる skill は並行処理しない。1 skill ずつ慎重に。

### Gate の設計

各 Phase 完了時に **型の再利用性チェック** を 1 ターン挟んだ。pilot → 4 skill 横断チェック → 6 skill 横断チェック → 最終 12 skill cross-check。「型が崩れた瞬間」を早期に検知できた。

## 4. 12 skill の類型マッピング

各 skill の類型定義と書式詳細は [`skill-design` skill](../../.agents/skills/skill-design/SKILL.md) を参照。

| #   | skill                  | 類型             |
| --- | ---------------------- | ---------------- |
| 1   | `storybook`            | 作成系           |
| 2   | `security`             | 予防系           |
| 3   | `test`                 | 予防系           |
| 4   | `optimistic-update`    | 予防系           |
| 5   | `trpc-router-creating` | 作成系           |
| 6   | `store-creating`       | 作成系           |
| 7   | `i18n`                 | 予防系           |
| 8   | `error-handling`       | 予防系           |
| 9   | `supabase`             | 運用系           |
| 10  | `docs-writing`         | 副次トリガー型   |
| 11  | `releasing`            | 明示発動型       |
| 12  | `eagle-dayopt`         | ライフサイクル型 |

6 類型を 12 skill でカバーしており、類型定義の網羅性として十分。

## 5. 例外運用と特例記録

### `supabase`: 軸混在特例

description に「DB 変更系 / Realtime 系 / Edge Functions 系 / 3 環境運用」の 4 束が混在する。通常型の単一軸構造では収まらず、字数 244 字で 6 要素を配置している（250 字枠の特例）。将来 supabase を触る時は、この軸混在を前提に読む。

### `docs-writing`: 副次トリガー型、7 要素

「コード変化」ではなく「上位イベント確定」が発動契機。通常型の 5-6 要素上限を超える 7 要素を許容している。見出しも「上位イベント起点 / 診断起点」のサブ見出しで分割。

### `error-handling`: 6 要素上限到達

責務が「try/catch / onError / ErrorBoundary / Sentry / AppError 正規化 / ユーザー通知」の 6 軸に広がっており、When to Use 要素数が通常型の上限 6 に到達している。今後新しい責務（例: observability 連携拡張）が加わる場合は、**別 skill 分離を検討**すべき境界に既に来ている。

### `releasing`: NOT=「該当なし」+ 近接ケース列挙

明示発動型は暗黙発動ケースが存在しないため、NOT を「該当なし」だけで終えると情報密度ゼロになる。代わりに近接ケース 3 件を矢印記法で列挙し、遷移先を明記している（例: `→ docs-writing skill で ADR / 技術ドキュメント更新を先行`）。

### `eagle-dayopt`: ライフサイクル型、要素数 8

パイプラインの各ステージ（撮影 → 同期 → レビュー → 整理）で最低 1-2 要素必要なため、要素数が通常型を超える。[`skill-design` skill](../../.agents/skills/skill-design/SKILL.md) の類型表で 8 まで許容と明記済み。

## 6. 設計原則の確立

この migration 中に確立した skill 設計の恒常ルールは **[`skill-design` skill](../../.agents/skills/skill-design/SKILL.md)** に分離した。主要原則:

- **6 類型の定義**（作成系 / 予防系 / 運用系 / 副次トリガー型 / 明示発動型 / ライフサイクル型）
- **description の書式**（字数、先頭句、構造）
- **When to Use の書式**（並び順、要素数、診断起点数の判断基準、外部起点の扱い）
- **When NOT to Use の書式**（括弧明記ルール、明示発動型の矢印記法）
- **境界設計原則**（skill 間 handoff、skill 層と rules 層の境界、自動生成 artifact の扱い、invocation トリガーと実行時ルールの分離、self-contained 原則）
- **空白領域 flag**（URL state の将来 skill 化余地）

本節は **1 回性のイベント記録**であり、skill 設計の source of truth は `skill-design` skill 側。将来 skill を追加・修正する際は `.agents/skills/skill-design/SKILL.md` を参照する。

## 7. スコープ境界（未着手タスク）

### 7.1 user-global skills の Opus 4.7 チューニング

対象候補: `ask-questions-if-underspecified` / `investigate` / `debug` / `refactor` / `feature-scaffolding`

特に `ask-questions-if-underspecified` は 4.7 の「初回ターンで十分仕様化されていれば質問せず進む」方針と衝突する可能性が高い。repo タスクに混ぜず、個人設定見直しとして別セッションで扱う。

### 7.2 adversarial review subagent 設計

Designer / Critic / User の 3-agent design review を仮に実装する場合、skill ではなく subagent として `.claude/agents/` 配下に設計する。現状ディレクトリ自体存在せず、発生時に別ファイル / 別 note で扱う。命名空間は `subagent-*` とし、本節（`skill-triggers`）と分離する。

---

# 第4部: 管理者向け運用スクリプト（admin-\*.sh）

`scripts/admin-*.sh` は Supabase Auth Admin API を直接叩き、dogfooding / 内部テスト用の account 操作を CLI から行うためのツール群。通常の signup / login flow を bypass したい時のみ使用する。

共通の env チェック・auth header 生成は `scripts/runbook/admin-common.sh` に集約されており、各スクリプトはこれを `source` する。

## 実行方法

```bash
cp .op-env.human.example .op-env.human   # 初回だけ
op run --env-file=.op-env.human -- \
  env USER_EMAIL=foo@example.com \
  bash scripts/runbook/admin-show-user.sh
```

**`.op-env.agent`（通常の local dev 用）ではなく `.op-env.human` を使う。** `pnpm dev` の Supabase 接続先は local 固定で、`.op-env.agent` は Supabase の接続情報を持たない（[secrets.md](./secrets.md) の `agent` 節）。admin script は Supabase Auth Admin API を service role で叩くため、専用の env-file を分けている。

`.op-env.human.example` は `human/supabase` を参照する。**つまりこれらの script の実行は production への操作**であり、実行したら手動作業ログを残す。

**書き換え・削除をする script は対象の打ち返しを要求する**（2026-09-14、Secret / Credential 監査 P2-2）。`admin-delete-user.sh` / `admin-set-user-password.sh` / `enable-auth-hook.sh` / `USE_LINKED_DB=true` の `seed-dev-data.sh` / `pnpm db:reset-linked:unsafe` は、操作対象から導いた Supabase project ref を `DAYOPT_CONFIRM_TARGET` に渡さない限り、ネットワークへ出る前に止まる。止まった時のメッセージに対象 ref が出るので、正しい対象だと確かめてから付けて再実行する。期待値は URL（admin 系・seed）か `supabase/.temp/project-ref`（linked reset）から導くため、別 project を指したまま確認を通すことはできない。正本は `scripts/tasks/confirm-target.sh`、契約は `scripts/__tests__/confirm-target.test.ts`。local の Supabase を対象にしたい場合は `supabase status -o env` の値を `env` で直接渡す。

## スクリプト一覧

| スクリプト                    | 用途                                                      | 必須 env                                                  |
| ----------------------------- | --------------------------------------------------------- | --------------------------------------------------------- |
| `admin-create-user.sh`        | email + password で user を新規作成（即 login 可能）      | `USER_EMAIL`, `PASSWORD_ITEM_ID`                          |
| `admin-delete-user.sh`        | user を hard delete（関連 row も CASCADE 削除）           | `USER_EMAIL`, `DAYOPT_CONFIRM_TARGET`                     |
| `admin-ensure-profile.sh`     | trigger 未発火時に `profiles` row を手動 upsert           | `USER_EMAIL`                                              |
| `admin-generate-magiclink.sh` | captcha / UI form の bug を bypass する magic link を発行 | `USER_EMAIL`                                              |
| `admin-set-user-password.sh`  | 既存 user の password を上書き + email 確認済みにする     | `USER_EMAIL`, `PASSWORD_ITEM_ID`, `DAYOPT_CONFIRM_TARGET` |
| `admin-show-user.sh`          | email から `auth.users` の状態を dump（read-only）        | `USER_EMAIL`                                              |

`PASSWORD_ITEM_ID` は password を保存した 1Password item の ID。

## 関連スクリプト

| スクリプト            | 用途                                                                                                                                                                                                                                                                                                                                                                           | 必須 env                                                                                             |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `enable-auth-hook.sh` | Production project の `custom_access_token` hook を有効化する。**現在は実行しない** — production では意図的に無効で（[#1946](https://github.com/Dayopt/dayopt/issues/1946) で決着）、`BILLING_ENFORCED` が未設定の間この hook が消せる DB クエリは無い。実行してよい条件と、同じ変更で `production-auth-config-audit.mjs` の期待値を `true` にする手順は script のヘッダが正本 | `SUPABASE_ACCESS_TOKEN`, `DAYOPT_CONFIRM_TARGET`                                                     |
| `verify-login.sh`     | email + password の組合せで直接 `/auth/v1/token` を叩き、login 可否を確認する（read-only）                                                                                                                                                                                                                                                                                     | `USER_EMAIL`, `PASSWORD_ITEM_ID`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` |

`verify-login.sh` が成功すれば password 自体は正しい（UI / CSP / form 側の問題）。失敗すれば `admin-set-user-password.sh` で password を再設定する。
