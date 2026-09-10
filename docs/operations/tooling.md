---
status: current
last_verified: 2026-09-07
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

特定 provider の model tier や「coordinator は実装しない」という役割固定は持たない。作業ごとに次を順に決める。

1. ユーザーが確認できる成功条件、対象範囲、検証方法を固定する
2. repo / docs / issue / command output で確認した事実と、未実測の仮説を分ける
3. 決定的な script / CLI、担当 agent の直接実行、scoped delegation、別 provider の反証を意味のある選択肢として比較する
4. 委譲は bounded scope と独立検証が可能で、引き渡し・待ち・統合の費用を上回る時だけ行う
5. diff、実行結果、必要な UI / API / data flow を成功条件と突き合わせる
6. issue / PR がある作業は、判断・進捗・ブロック・検証をそこへ残す

OpenAI / Codex は実装を含む primary provider として使う。他 provider は auth / RLS / billing / migration / 公開契約などで、独立した反証の便益が費用を上回る時に任意で追加する。外部 provider の可用性は merge gate にしない。

## 3. Hook の共有と保証境界

判定ロジックは `scripts/hooks/pre-tool-guard-rules.mjs` に置き、provider adapter は runtime の tool-call payload を共有形式へ変換する薄い入口にする。Claude Code は `scripts/hooks/pre-tool-guard.mjs`、Codex は `scripts/hooks/codex-pre-tool-guard.mjs` を入口とする。

adapter の script が存在するだけでは tool call は止まらない。runtime 側で adapter が実行前 hook として登録・起動され、block 結果を尊重する必要がある。repo は user-global 設定、直接 shell、User 自身の UI 操作、未知の tool surface を強制できない。具体的な secret 境界と残余リスクは [secrets.md](./secrets.md) を正本とする。

Codex でこの project を初めて開く時は、project trust を確認し、`/hooks` で `.codex/hooks.json` の command と有効状態を User が 1 回レビューする。repo の `.codex/config.toml` に `hooks = true` があっても、runtime が project を trust して hook を読み込んだ証拠にはならない。`pnpm agent:preflight`（機械利用は `pnpm agent:preflight --json`）は依存、Git hooks、CLI、skills、Codex hook 設定ファイルの存在を確認するが、runtime の trust や実際の hook 発火は判定できない。user-global 設定はこの onboarding で変更しない。

### 実行経路ごとの保護範囲

「機械」は該当 hook が信頼・発火した場合の判定を指す。現時点の native Codex 発火は未確認である。

| 分類・操作                                  | Claude Code                                           | Codex                                                                            | Antigravity                                |
| ------------------------------------------- | ----------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------ |
| 秘密情報: envファイル、vault参照            | Read/Write/Edit と Bash の個別パターンを機械検査      | apply_patch の全対象・shell の個別パターンを機械検査。汎用read toolはsurface依存 | repo hook接続なし。指示で制御、実動未確認  |
| 破壊的操作: 既存migration・他worktreeの編集 | Write/Editで機械検査。任意shell編集は保証外           | apply_patch の変更元/先・symlinkを機械検査。任意shell編集は保証外                | 指示で制御、機械保護は未対応               |
| Git運用: force push、no-verify、直接merge等 | Bashの列挙パターンを機械検査                          | 共通Bash判定を再利用                                                             | 共通Git hookのみ。tool実行前の検査は未対応 |
| コスト・利便性                              | モデル名に基づく委任制限は撤去。起動確認は共通command | 同左                                                                             | 共通commandを手動利用可能、実動未確認      |

**shell の任意編集は機械的に閉じていない**。`sed -i`、`perl -pi`、`cp`、`mv`、`tee`、出力redirect、任意scriptによる既存migration・他worktreeへの書き込みを、このadapterは一般には検出しない。Codexのファイル変更は原則 `apply_patch` を使い、shell編集へ切り替えてこの検査を迂回しない（指示による制御）。hookに到達しただけで全操作が保護されるわけではない。write_stdin、hosted/specialized tool、wrapper内部の処理も同じ保証を持たない。

この境界はshell interpreterの自作で埋めず、runtimeの書き込み範囲・Git hooks/CI・最小権限の資格情報で補う。本番は既存の明示権限・独立レビュー・dry-run/backupを維持する。上記が不足する操作は未対応として扱い、通常開発の実動試行でも境界を確認する。

## 4. Skill 設計

新規・更新時は `.agents/skills/skill-design/SKILL.md` に従う。description / When to Use は provider-neutral にし、特定 model の名前を発火条件や必須 tier にしない。provider 固有の adapter は capability、scope、出力契約、generic fallback、実際の保証境界を併記する。

## 5. Portable review interface

クロスレビューの一次情報は provider の session ではなく immutable review pack に固定する。

```bash
pnpm review:pack --base <ref> --head <ref> \
  --context <context-markdown-path> --verification <verification-markdown-path> \
  --source <repo-relative-file> --out <new-directory>
```

pack は exact base / head SHA、pack ID、base から head への直接 diff、変更 path の before / after source、関連 source、role ごとの prompt と result-body schema を持つ。`--source` は繰り返せる。binary、欠落、1 MiB 超の source は omission として記録される。context と verification は非空、出力先は新規 directory とする。

reviewer は read-only sandbox で provider 固有の tool を使い、同じ pack を読む。資料確認の `cat` / `rg` / `git show` 相当は許可するが、test や package install を含むコード実行、状態変更、nested agent は許可しない。result body を schema に合わせ、その外側に `packId`、`baseSha`、`headSha`、`provider`、`model`、`modelFamily`、`sessionId`、`independence`、`role` を持つ JSON envelope を付ける。`independence` は実態に応じて `separate-session` または `different-model-family` を記録する。固定 model、Claude Workflow、provider の多数決は共通契約に含めない。

```bash
pnpm review:validate --pack <directory> --result <result.json>
```

validator は `not-run`、`stale`、`partial`、`reviewed`、`invalid` を区別する。`invalid` は envelope / result の schema 違反で、必須 string が空白だけの場合も含む。`not-run` / `stale` / `partial` / `invalid` は非 0 exit、`reviewed` は findings の件数に関係なく 0 exit である。これは transport と provenance の検証であり、レビュー品質や merge 可否の判定ではない。`not-run`、`partial`、未収集 provider を指摘 0 件として集計しない。

OpenAI / Codex を primary reviewer とする。auth / RLS / billing / migration / 公開契約などで独立した反証の価値がある時は、Claude Code や Antigravity を optional counterreview として追加できる。各 provider の所見は個別に failure scenario と一次情報を照合し、多数決で棄却しない。role の選択と投稿手順は `.agents/skills/pr-cross-review/SKILL.md` を正本とする。

### pack の種別と契約 version

pack は `kind`（`pr` / `sweep`）と `contractVersion` を manifest に持ち、artifact 集合はその組から literal registry で決まる。**role 一覧から artifact 名を導出しない** — 導出していた頃は role を 1 つ足すだけで生成済み pack が一斉に `invalid` になった。`kind` を持たない manifest は `pr` / version 1 として読み、未知の kind / version は fail closed で `invalid` にする。契約変更前に生成した PR pack を `scripts/__tests__/fixtures/review-pack-pr-v1/` に凍結してあり、整形するとバイト列が変わって pack の破損になるため `.prettierignore` の対象にしている。

`sweep` は PR の差分ではなく 1 つの SHA における scope を読む（`security-sweep` skill）。`baseSha` / `headSha` を持たず `targetSha` 1 本と `scopePaths` を持ち、`diff.patch` と `verification.md` は作らない。envelope に `baseSha` / `headSha` が入っていれば PR envelope の流用として `invalid` にする。

```bash
pnpm review:sweep --at <commit-ish> --scope <repo 相対 path（繰り返し可）> \
  --context <context-markdown-path> --threat-model <threat-model-path> --out <new-directory>
```

sweep の後段（`security-critic` / `security-reproducer`）は候補集合と突き合わせる。`--result` は繰り返せ、上限や中断で分割した同一 role の結果を 1 回の検証で合流させる。

```bash
pnpm review:validate --pack <directory> --result <result.json> [--result <result2.json>] \
  [--candidates <candidates.json>] [--emit-candidates <new-path>]
```

- `candidateId` / `signature` / `candidateSetHash` は**生成側が導出**し、reviewer の申告を採らない
- 判定が返っていない候補、候補集合に無い id への判定、食い違う判定、別 run の候補集合を**別々の理由で**検出する
- `undetermined`（critic）と `not-run` / `environment-missing`（reproducer）は裁定が決まっていないものとして `partial` に留める。id が入っていることを「判定済み」と数えない
- `--emit-candidates` は既存ファイルへ上書きしない。分割実行は `--result` を並べて 1 回で検証する。critic の検証は `needs-execution` の部分集合を emit し、reproducer はそれを母集合にする
- `reproduced` / `failed-to-reproduce` は実行した `command` と `testPath` の提示を要求する。到達証拠のない失敗は `not-run` / `environment-missing` へ落とす

## 6. Migration acceptance と handoff

native worktree root の fresh Codex session による共通指示・skills の発見と、サブディレクトリ起動の別 Codex session への review pack 引き継ぎを確認した。Codex の project trust と実 hook 発火、Antigravity の skill discovery と review adapter は未検証であり、設定ファイルの存在を有効化の証拠にしない。

2026-09-07、`scripts/tasks` から新規 Codex read-only セッション（gpt-5.6-sol、session `01a0796e-8943-7303-9bb3-6184e41a9b2f`）を起動し、base `393f432c6` → head `bbdb9510a` の移行差分を pack で手渡した。result envelope は `reviewed`、recommendation は `revise`、指摘 1 件だった。指摘は shell の任意編集に対する保証の過大解釈で、経路別の保護表へ保証外の操作を明記した。これは別 OpenAI セッションの反証であり、別モデル系列の反証や native hook 発火の証拠ではない。旧 SHA の所見を後続 SHA の指摘ゼロとして再利用しない。

次の 3 trial は将来の実 PR で各 1 件行い、証跡はその issue / PR comment に残す。ここに別の常設 tracker は作らない。Antigravity は高リスク変更で独立した反証が有益な時の任意 adapter であり、trial の合格条件にはしない。

| trial                    | 対象                                                 | status  |
| ------------------------ | ---------------------------------------------------- | ------- |
| **通常バグ修正**         | 1 feature 内の再現可能な bug fix 1 件                | pending |
| **複数ファイル変更**     | 複数 file / connection point を含む変更 1 件         | pending |
| **高リスク diff review** | auth / RLS / billing / migration / 公開契約など 1 件 | pending |

各 trial は次の 4 軸で評価する。

1. **成功条件**: issue / PR の受け入れ条件と検証結果を満たしたか
2. **説明し直し救済**: 曖昧さや誤解が生じた時、User が全体を説明し直さず issue / PR / pack の事実から修正できたか
3. **手戻り・見逃し**: review 後の修正 round、revert、見逃した P1 / P2、未解消 unknown を記録できたか
4. **別 session 再開**: fresh separate session が issue / PR / pack だけから対象 SHA と次の一手を復元できたか

`stale` / `partial` / `not-run` / `invalid` の区別と、未完了 result を findings 0 にしない契約は自動 test 24 件で検証済みである。これは実 PR での上記 3 trial や reviewer 品質の代替ではない。

`pnpm ai:usage` と `pnpm trace` の session / token / tool データは Claude Code local transcript のみを収集する。Codex / Antigravity は `null` / unknown であり 0 ではない。GitHub 由来の aggregate PR outcomes は repo 全体の値なので、Claude Code の token や session で割って provider の効率を主張しない。

---

## 履歴: Opus 4.7 Skill Triggers Migration

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

`.op-env.human.example` は `human/supabase` を参照する。**つまりこれらの script の実行は production への操作**であり、実行したら手動作業ログを残す。local の Supabase を対象にしたい場合は `supabase status -o env` の値を `env` で直接渡す。

## スクリプト一覧

| スクリプト                    | 用途                                                      | 必須 env                         |
| ----------------------------- | --------------------------------------------------------- | -------------------------------- |
| `admin-create-user.sh`        | email + password で user を新規作成（即 login 可能）      | `USER_EMAIL`, `PASSWORD_ITEM_ID` |
| `admin-delete-user.sh`        | user を hard delete（関連 row も CASCADE 削除）           | `USER_EMAIL`                     |
| `admin-ensure-profile.sh`     | trigger 未発火時に `profiles` row を手動 upsert           | `USER_EMAIL`                     |
| `admin-generate-magiclink.sh` | captcha / UI form の bug を bypass する magic link を発行 | `USER_EMAIL`                     |
| `admin-set-user-password.sh`  | 既存 user の password を上書き + email 確認済みにする     | `USER_EMAIL`, `PASSWORD_ITEM_ID` |
| `admin-show-user.sh`          | email から `auth.users` の状態を dump（read-only）        | `USER_EMAIL`                     |

`PASSWORD_ITEM_ID` は password を保存した 1Password item の ID。

## 関連スクリプト

| スクリプト            | 用途                                                                                                                                                                                                                                                                                                                                                                           | 必須 env                                                                                      |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| `enable-auth-hook.sh` | Production project の `custom_access_token` hook を有効化する。**現在は実行しない** — production では意図的に無効で（[#1946](https://github.com/Dayopt/dayopt/issues/1946) で決着）、`BILLING_ENFORCED` が未設定の間この hook が消せる DB クエリは無い。実行してよい条件と、同じ変更で `production-auth-config-audit.mjs` の期待値を `true` にする手順は script のヘッダが正本 | `SUPABASE_ACCESS_TOKEN`                                                                       |
| `verify-login.sh`     | email + password の組合せで直接 `/auth/v1/token` を叩き、login 可否を確認する（read-only）                                                                                                                                                                                                                                                                                     | `USER_EMAIL`, `PASSWORD_ITEM_ID`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` |

`verify-login.sh` が成功すれば password 自体は正しい（UI / CSP / form 側の問題）。失敗すれば `admin-set-user-password.sh` で password を再設定する。
