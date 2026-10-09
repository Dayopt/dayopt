---
status: superseded
last_verified: 2026-10-09
superseded_by: docs/operations/secrets.md
---

# Mac 上のエージェント分離（撤回済み）

2026-09-30 に承認した「ローカルの agent は専用の標準 Mac ユーザーで分離する」手順は、2026-10-09 に撤回した（[#3052](https://github.com/Dayopt/dayopt/issues/3052)、決定の記録は [#3057](https://github.com/Dayopt/dayopt/issues/3057)）。専用ユーザーは作成されないまま、agent vault を read-only で読む Service Account の token を環境変数 `OP_SERVICE_ACCOUNT_TOKEN` 1 個で渡す形に置き換えた。到達できる secret の範囲は同じで、手順と保守対象が減るため。

現行の手順は [Secrets](./secrets.md#service-account) を正本とする。このページは [decisions.md](../decisions.md) の 2026-09-30 の行から参照されるため残している。
