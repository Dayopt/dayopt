---
name: audit-ai-config
description: AI設定の棚卸し、設定整理、audit、協働設定レビューの明示依頼時に発動。AGENTS.md・provider adapter・project skills・hooks・MCP の重複、配置、発火条件、強制力、AGENTS.md の行数予算を評価する。docs棚卸しやskill新設判断では発動しない。
---

# AI設定の棚卸し（audit-ai-config）

Dayopt の AI 協働設定を provider-neutral に棚卸しし、不要・重複・配置間違い・発火条件の曖昧さ・保証の過大表現を検出する。削除や移動は提案としてまとめ、実行まで指示されている場合だけ変更する。

## When to Use

**明示発動型** — この skill はユーザーの explicit な AI 設定棚卸し意図のみを契機に発動する。

- 「AI設定を棚卸しして」「設定を整理して」など、AI 協働設定全体の audit が明示された時
- `.agents/skills`、provider adapter、`AGENTS.md`、hooks、MCP の重複や配置を点検するよう指示された時
- skill / AGENTS.md / hooks の使い分けや、runtime ごとの保証境界をレビューするよう指示された時
- AI 設定の削除候補・統合候補・発火条件改善案をまとめるよう指示された時

## When NOT to Use

この skill は **explicit AI 設定棚卸し意図のみを契機とする**。参考として近接するが発動しないケース:

- docs の棚卸し・鮮度確認 → `/gardening`
- docs gap の検出・技術ドキュメント更新 → `docs-writing` skill
- skill 新設・description 書式判断 → `skill-design` skill

## 現在の構成

- 実装・運用ガイダンスの正本は `AGENTS.md`（~200 行予算）。OpenAI / Codex を primary harness とする provider-neutral な判断層と不変条件を置く
- `CLAUDE.md` は `@AGENTS.md` を import する Claude Code 用互換 adapter
- project skill の正本は `.agents/skills/*/SKILL.md`。`.claude/skills` は Claude Code 互換の相対 symlink で、内容を二重管理しない
- `.claude/rules/` と `.claude/agents/` は持たない。恒常ルールは AGENTS.md または該当 skill に置く
- hook の共有ロジックは `scripts/hooks/pre-tool-guard-rules.mjs`。provider adapter はこの rules を呼ぶ薄い入口とし、runtime から登録・起動されて初めて強制力を持つ
- runtime で read-only と repository scope を同時に強制できる adapter がないため、大量の読み取り調査も主担当が行う。現行 native delegation は実際の入力に read-only / write を区別する型がないため使わず、runtime が別名の typed write / browser tool を提供した時だけ User の明示した非重複 scope・authority 契約で扱う。両方を実測できる adapter が追加された場合だけ、Luna / Haiku の候補を再評価する
- 独立 PR レビューは `protected-path-gate.mjs` が判定する外部契約・不可逆・ガードレール変更だけで `@codex review` を使う。通常 PR は対象外で、`pr-cross-review` は依頼と裁定の入口。追加 reviewer は User が明示的に再開を指示するまで停止する

## Inventory

以下を列挙し、件数・責務・被参照・重複候補・実際の起動経路を確認する。

- `.agents/skills/*/SKILL.md` と `.claude/skills` symlink
- `scripts/hooks/*`（共有 rules と provider adapter）
- repo 内の provider 設定（例: `.claude/settings.json`）。user-global 設定は読み取りの必要性と許可がある時だけ確認し、repo 設定と混同しない
- `CLAUDE.md` などの provider adapter
- `AGENTS.md`（判断層・不変条件・provider-neutral review 規則）
- MCP / connector / CLI の登録先と、常設か on-demand か

AGENTS.md は次も確認する。

- **行数予算**: `wc -l AGENTS.md` が ~200 行に収まっているか。超過していれば、機械 gate の説明重複や特定作業限定の手順を該当 skill へ移す
- provider 固有の model 名・tool 名・権限制御を、全 runtime 共通の保証として書いていないか
- 成功条件、事実と仮説、委譲の採算、outcome 検証、issue / PR handoff の境界が明確か

## Review Questions

1. **使用実績**: `git log -1` の日付だけで鮮度を決めない。`rg --hidden --glob '!.git/**'` の被参照と、必要なら `git log --follow -p` の実質 diff を根拠にする
2. **適材適所**: 判断不要で毎回同じ処理は script / hook / CI、短い常時ルールは AGENTS.md、特定作業だけの手順は skill に置けないか
3. **重複**: AGENTS.md、skills、docs、provider adapter で同じ規約を二重管理していないか。正本を 1 箇所に決め、他は参照へ落とす
4. **トリガー品質**: skill の description / When to Use / NOT 条件が、対象ファイルと作業種別を具体的に示すか
5. **保証境界**: hook script の存在、provider からの登録、実行時 permission、CI を区別しているか。prompt や manifest だけを security boundary と表現していないか
6. **outcome**: token 数や model 比率だけでなく、成功条件の達成、revert、再発、User 介入、検証漏れを見ているか

## Output

- 削除提案: 対象、理由、復元方法
- 移動・統合提案: 移動元、移動先、正本にする理由
- 改善提案: description / When to Use / NOT 条件の修正文案
- 権限監査: runtime ごとの実際の guard 起動経路、未検証の tool surface、外部 state mutation の境界
- 残余 coupling: provider 固有コマンド、user-global 設定、互換 shim と、その代替経路

## Safety

- `~/.claude.json`、`~/.claude/settings.json`、`~/.codex/`、plugin / connector の個人設定や認証状態は、明示依頼なしに変更しない
- repo 内の local state は、削除提案前に git 管理対象かを確認する
- parent session の permission が child の既定値を上書きし得る runtime では、manifest や prompt だけを security boundary と表現しない
- purpose-built browser-only / read-only worker を一般 writer にしない。委譲は `AGENTS.md §委任・報告の作法` の scope と権限契約に従う
