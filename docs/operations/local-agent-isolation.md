---
status: current
last_verified: 2026-09-30
code: scripts/tasks/agent-service-account.mjs
---

# Mac 上のエージェント分離

2026-09-30、User はローカルの分離を先に進め、専用の標準 Mac ユーザーに切り替えて Codex を使う方針を承認した。本ページはその準備手順。ユーザー作成・ACL の適用・移行完了は未確認。SA の権限・起動検証とクラウド側の方針は [Secrets](./secrets.md#service-account) を正本とする。

同じ OS ユーザーで `OP_SERVICE_ACCOUNT_TOKEN` や `OP_CONFIG_DIR` だけを切り替えても、人間の CLI 設定・Keychain・ブラウザー・1Password アプリへ戻る経路は閉じない。本ページは OS ユーザーとファイルアクセス権で分離する一つの方法を示す。同一ユーザーで OS sandbox を使う方法もあるため、専用ユーザーが唯一の方法ではない。sandbox を採る場合は command に加えて MCP / browser / Computer Use の経路も制限・検証する必要がある（[Codex の適用範囲](https://learn.chatgpt.com/docs/permissions#scope-and-enforcement)）。

通常の `op` 呼び出しを SA に切り替える entry point の導入状況は [Secrets](./secrets.md#ローカル-codex-の通常の-op-呼び出し)を参照する。この認証切替と、本ページの OS 分離完了は別に判定する。

## 1. 専用ユーザーを作る

システム設定 → ユーザとグループ → ユーザを追加。

- 種類: **標準**（管理者にはしない）
- フルネーム: `Dayopt Agent`
- アカウント名: `dayopt-agent`
- パスワード: User が画面で入力する。chat や agent のコマンド引数へ渡さない

専用ユーザーには人間用の 1Password / Apple Account / browser profile / CLI session / SSH Agent / Keychain / Codex 設定をコピー・同期しない。Codex 自体へのログインはそのユーザーで行い、追加する接続は必要なものだけにする。

ユーザー作成は [Apple の手順](https://support.apple.com/guide/mac-help/add-a-user-or-group-mtusr001/mac)、権限の意味は [ファイルアクセス権](https://support.apple.com/guide/mac-help/change-permissions-for-files-folders-or-disks-mchlp1203/mac)を参照する。

## 2. 人間のホームへのアクセスを閉じる

専用ユーザーの作成後、人間側の Terminal で適用する。以下は現在の Mac のパスを使う。OS ユーザー名とホームの所有者を確認してから実行する。

```bash
id dayopt-agent
ls -lde /Users/tanakatomoya
chmod +a 'user:dayopt-agent deny list,search' /Users/tanakatomoya
ls -lde /Users/tanakatomoya
```

この ACL は専用ユーザーによるホーム内の一覧取得とパスの探索を拒否する。再帰的な chmod や既存 ACL の削除は行わない。既存ユーザーが使う checkout は移動・変更しない。

戻す場合は人間側で今回追加した ACE だけを削除する。

```bash
chmod -a 'user:dayopt-agent deny list,search' /Users/tanakatomoya
```

## 3. 専用ユーザーで作業環境を用意する

専用ユーザーへログインし、そのホームに新しい作業コピーを作る。人間の checkout や認証ディレクトリへの symlink / shared mount は使わない。既存の Homebrew の Node / op / codex を利用する場合は、専用ユーザーから executable とその配置先を変更できないことを確認する。

この branch の `scripts/tasks/agent-service-account.mjs` は Node の組み込みモジュールだけを使うため、リポジトリ全体や認証ファイルを移さずに bootstrap できる。まだ push されていないので、通常の clone に含まれるとは扱わない。人間がこのファイルだけを読取専用の受け渡し先へ置き、専用ユーザー側へコピーする。

SA token の手入力は専用ユーザーの Terminal で行う。次は Bash 用で、値は入力中に表示せず、shell 設定やファイルへ保存しない。トークンを chat に送らない。

```bash
bash --noprofile --norc
export PATH=/opt/homebrew/opt/node@24/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin
read -r -s -p 'SA token: ' OP_SERVICE_ACCOUNT_TOKEN
printf '\n'
export OP_SERVICE_ACCOUNT_TOKEN
export DAYOPT_AGENT_SERVICE_ACCOUNT_ID=UARSP4VEVJGXBLSKW427LZJN74
export DAYOPT_AGENT_VAULT_ID=dlmo7yfs5buvd3j3sbikjjqypa
node /Users/Shared/dayopt-agent-bootstrap/agent-service-account.mjs check --json
```

起動検証が成功したら、同じ Terminal で CLI を起動する。

```bash
node /Users/Shared/dayopt-agent-bootstrap/agent-service-account.mjs run -- codex
unset OP_SERVICE_ACCOUNT_TOKEN
exit
```

これは CLI の起動手順。Desktop アプリの起動・実行ツールへの token 注入は別途実測する必要があり、CLI での成功を Desktop の成功と扱わない。

## 4. 専用ユーザーから検証する

- `id` が `dayopt-agent` で、`admin` / `wheel` group を持たない
- `test ! -r /Users/tanakatomoya && test ! -x /Users/tanakatomoya` が成功する。`test ! -r /Users/tanakatomoya/.codex/auth.json` など、人間の認証経路へアクセスできないことも確認する。値や内容は読まない
- SA 検証で active な指定 Service Account と、絞り込みなしの `agent` vault 1 件が一致する
- token を外した別 process は認証に失敗する。通常の op 設定にも人間用 account を登録しない。一時 config だけの失敗は、普段の config が安全である証明にはならない
- 普段使う Codex の実行ツール自体でも上記を確認する。operator の Terminal だけの成功を agent の境界と扱わない

SA token の read-only 権限は管理画面で別途確認する。旧ユーザーの既存 chat は引き続き旧権限で動くため、ローカル移行完了にはそちらの agent 利用を止める必要がある。同じ OS の標準ユーザー分離は、管理者や OS の脆弱性に対する境界ではない。
