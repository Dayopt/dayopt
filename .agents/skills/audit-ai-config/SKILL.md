---
name: audit-ai-config
description: AI 設定・AGENTS.md・skills・hooks の整理や棚卸しを明示依頼された時に使う。不要な規則と重複を削り、必要な指示と実行時の保護を区別する。公開 docs の監査や通常実装では不要。
---

# AI 設定の整理

## When to Use

AI 設定の整理・削除・重複確認が明示された時に使う。

## When NOT to Use

- 公開 docs の監査（`docs-audit`）
- 通常実装・skill の作成だけ（該当する開発 skill / `skill-design`）

## 確認すること

- 対象の AGENTS.md、skills、provider 設定、hook の登録と実装、参照元を必要な範囲で調べる。
- AGENTS.md は全作業に必要な制約だけ。作業別の手順は skill、技術の詳細は既存 docs、確定的な検査は既存 script / lint / CI に置く。
- 行数だけで評価しない。重複・矛盾・古い前提・不要な必須工程を探す。内容を別ファイルへ移すだけで削減と扱わない。
- 不要な規則は削除する。必要な情報は既存の正本へ統合し、新しい退避文書は作らない。tracked 情報の復元は Git 履歴を使う。
- 設定の存在・runtime の読み込み・実際の発火を区別する。guard の変更は保護が消える範囲と対象検証を確認してから行う。

## Project 設定の境界

共通指示は AGENTS.md、skills は `.agents/skills/`。CLAUDE.md は互換入口、`.claude/skills` は repo 内の相対 symlink。Cloud-first、Local-optional とし、ホームへの絶対リンク・特定 Mac・個人設定を前提にしない。

ホームの認証・plugin・アプリ設定は repo の整理対象に含めない。ユーザーが指定した個人設定を外す時は、実際の symlink と対象の未保存変更を確認する。他 checkout のファイルを変更しない。

## 完了報告

削除・統合したもの、残した理由、検証結果、未確認の runtime 挙動を短く示す。token 削減を指示遵守の改善として断定しない。
