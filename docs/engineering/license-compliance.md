---
status: current
last_verified: 2026-10-09
code:
  - apps/product/.licensrc.json
  - scripts/tasks/check-license-risks.ts
---

# OSS ライセンスのコンプライアンス

依存を追加・更新する時のライセンス確認の手順。公開用クレジットは `@dayopt/product` の production dependency tree を対象に生成する。

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

## ワークフロー

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

機械が消費する式・識別子は末尾の生成領域で読む。許可式、禁止識別子、警告設定を別々に表示し、矛盾もそのまま残す。許可と禁止の双方に現れる設定の解消は法務判断が必要で、生成器は採否を決めない。[risk checker](../../scripts/tasks/check-license-risks.ts) の判定も併せて確認する。

## トラブルシューティング

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

## 統計情報の見方

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

## 関連リンク

### 外部リソース

- [SPDX License List](https://spdx.org/licenses/) - 公式ライセンス一覧
- [Choose a License](https://choosealicense.com/) - ライセンス選択ガイド
- [TL;DR Legal](https://tldrlegal.com/) - ライセンス要約サイト
- [Open Source Initiative](https://opensource.org/licenses) - OSI承認ライセンス

## 機械取得する現状

<!-- docs-live:facts:start -->

抽出対象の登録は [scripts/lib/docs-live/facts.ts](../../scripts/lib/docs-live/facts.ts)。現在の一覧は `pnpm docs:read docs/engineering/license-compliance.md` で生成して読む。

<!-- docs-live:facts:end -->
