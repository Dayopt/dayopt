---
status: current
last_verified: 2026-09-21
---

# 11. Jev / Agent（AI が何を見て、どう判断しているか）

## この章で答えられるようになる問い

- Dayopt の開発で AI（Claude Code / Codex / Jev）はどこまで任されていて、どこで止まるか
- AI の判断が間違っても、何が最後の砦になっているか
- AI の作業を人が検証する時、何を見ればよいか

## 概念

Dayopt は 1 人で開発し、実装の多くを AI が行う。だから「AI に何を任せ、何を**機械**（決定的なコード）に持たせ、何を**人**が決めるか」の線引きが設計の一部になっている。

```mermaid
flowchart LR
  AI["AI agent<br/>調査・実装・検証"] --> G["機械の gate<br/>hook・lint・test・ruleset"]
  G --> R["独立レビュー<br/>@codex review"]
  R --> H["人<br/>価値判断・不可逆な操作"]
  J["Jev<br/>意味の特徴を足すだけ"] -.-> AI
```

## Dayopt ではどうなっているか

**AI への指示の正本**は `AGENTS.md`（provider を問わず共通）。作業の手順は `.agents/skills/*/SKILL.md`。判断のテンポは 3 段階: 可逆なら承認なしで進める、顧客挙動・公開契約・権限に関わるなら止まって問う、不可逆（本番の変更・データ削除・課金・リリース）は明示の指示と独立レビューが揃うまで実行しない。

**機械の gate**（AI が間違えても止まる場所）:

- `scripts/hooks/pre-tool-guard.sh` — AI のツール実行の前に危険なコマンドを止める
- `.husky/pre-push` — push の前の確認（DO-CONFIRM）
- main の repository ruleset — required checks と review thread の解決が揃わないと merge できない。bypass できる人はいない
- `scripts/ci/protected-path-gate.mjs` — 外部契約・不可逆の path に触った変更を、レビューで重点的に読む範囲として示す。ruleset の merge は止めない。監査の契約（`auditContract`）に触れた PR でも、Production Config Audit の「この head に監査結果が無い」は `pnpm branch:finish` が参考扱いにして失敗数から外す。止めるのは Vercel の env が契約と実際に食い違った時（drift）と、結果を判定できない時だけ
- `pnpm docs:check` — この教材の参照切れもここで止まる

**Jev** は Vercel AI Gateway 経由の小さな評価モデル。**最終意思決定者ではない**。権限・必須レビュー・test の結果・path の policy は決定的なコードが持ち、Jev は非構造の文章から意味の特徴を足すだけ。予算と停止条件（残高が下限を下回ると送らない、`JEV_DISABLED=1` で止まる）が先に決めてある。

**AI の仕事を検証する時に見るもの**: diff、検証コマンドとその出力、実際の画面や API の動き。「passed」という申告だけで完了にしない（AGENTS.md の委任・報告の作法）。

## 正本

- [AGENTS.md](../../AGENTS.md) — レビュー規則、シンプルルール、Non-Negotiables、委任・報告の作法
- [docs/operations/jev.md](../operations/jev.md) — Jev の境界・予算・pack
- [docs/engineering/infra.md](../engineering/infra.md) の「merge gate の required checks」
- `routing` skill / `audit-ai-config` skill

## 自分で確かめる問い

<details>
<summary>1. AI が「テストは通りました」と報告した。何を確かめるか</summary>

実行したコマンドと出力の要点。skip された test が緑に見えていないか、変更前から通るテストではないか（TEST-1）。

</details>

<details>
<summary>2. Jev が「この PR は低リスク」と判定した。レビューを省いてよいか</summary>

よくない。Jev の判定で既存の権限・必須レビュー・security の下限を下げない（jev.md の境界）。

</details>

<details>
<summary>3. AI に本番の DB を直接直させたい</summary>

不可逆な操作なので EXPLICIT AUTHORITY の段。明示の指示・独立レビュー・dry-run か backup が揃うまで実行しない。揃わなければ実行せずに報告させる。

</details>

## 参照（検査用）

このページの本文が名指ししているコード。`pnpm docs:check` が、ファイルが在り `find` の文字列を含むことを検査する。本文を書き換えたらここも直す。

```json learn:refs
[
  {
    "path": "scripts/tasks/finish-branch.sh",
    "find": "# ── audit contract guard も advisory として扱う"
  },
  {
    "path": "docs/operations/jev.md",
    "find": "**Jev は最終意思決定者ではない。**"
  },
  {
    "path": "scripts/ci/protected-path-gate.mjs",
    "find": "still a merge"
  },
  {
    "path": ".husky/pre-push",
    "find": "pause point"
  },
  {
    "path": "scripts/hooks/pre-tool-guard.sh",
    "find": "pre-tool-guard.mjs"
  }
]
```
