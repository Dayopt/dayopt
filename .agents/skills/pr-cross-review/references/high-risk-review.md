# 高リスク変更の固定差分レビュー（停止中・アーカイブ）

2026-09-17 の User 指示により、この手順は実行しない。高リスク変更も GitHub の `@codex review`、セルフレビュー、CI、必要な `EXPLICIT AUTHORITY` の契約で扱う。高リスクであること、GitHub の無応答、モデルの安さを理由に追加 reviewer を起動しない。

このファイルは、過去に作成した immutable review pack / result の形式と判断履歴を参照するために残しているアーカイブである。ここに過去のコマンドや role 定義が残っていても、現在の作業手順として実行してはならない。通常の PR レビューを行う時は [pr-cross-review](../SKILL.md) の `@codex review` 手順を使う。

`scripts/tasks/review-pack.mjs` と `pnpm review:pack` / `pnpm review:validate` は、既存証跡の読み取りと明示的な `security-sweep` 契約のために互換維持する。新しい PR の追加レビューを起動する入口ではない。`security-sweep` は [security-sweep skill](../../security-sweep/SKILL.md) の明示依頼時だけ実行する。
