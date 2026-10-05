---
name: skill-design
description: project skill を新設する時、既存 skill の発動条件や責務を整理する時に使う。必要な場面を明確にし、AGENTS.md・他 skill・docs の重複を避ける。手順やコマンドだけの小修正では不要。
---

# Project skill の設計

## When to Use

- skill を新設する時
- description・発動条件・責務の境界を変える時

## When NOT to Use

- 手順やコマンドだけの小修正
- AI 設定全体の棚卸し（`audit-ai-config`）

## 必要な情報

- frontmatter の `name` と `description` に、何の作業で使うかを書く。description は起動判断に必要な情報に絞る。
- 本文は対象の作業、実行手順、必要な確認・検証を示す。混同しやすい作業だけ、対象外と既存の行き先を書く。
- AGENTS.md の承認境界や既存 skill を繰り返さず参照する。model 名・provider 固有の機能を共通の保証と扱わない。
- 同じ repo のファイルか公開資料で完結させる。個人設定・ホームへのリンク・個人メモリを前提にしない。
- `.agents/skills/` を正本にし、互換 symlink 側は編集しない。長い例は実際に必要なものだけ参照先へ分ける。
- 新設前に既存 skill / docs / script で足りないか確認する。類型・字数・bullet 数の固定書式は要求しない。

## 検証

frontmatter、参照先、対象と対象外の整合、重複、実行コマンドを確認する。自動生成物の変更だけを不要な skill の発動条件にしない。
