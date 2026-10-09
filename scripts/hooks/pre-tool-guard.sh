#!/bin/sh
# PreToolUse hook の launcher。**ロジックは一切持たない**（判定は
# pre-tool-guard.mjs → pre-tool-guard-rules.mjs 側）。
#
# なぜ node を直接 settings.json へ書かないか（#2565）:
#
# Claude Code は PreToolUse hook の **exit 2 だけ**を block と解釈し、それ以外の
# 非 0（コマンド not found = 127 を含む）は non-blocking error として tool 実行を
# 続行する。settings.json に `node scripts/hooks/pre-tool-guard.mjs` と書くと
# hook の起動が `node` の PATH 解決に依存し、解決できない実行コンテキストでは
# 全 matcher（Write / Edit / MultiEdit / NotebookEdit / Bash / Read）が
# **すべて無言で fail-open** する。force push / reset --hard / `.env` の読み書き /
# worktree 越境 Write が素通りする。
# bash 版 guard（#2563 で撤去）にはこの依存が無かった。
#
# 実測（2026-09-05、cloud session）: この repo の node は /opt/node22/bin/node に
# あり、POSIX 既定 PATH（/usr/bin:/bin）では `command -v node` が解決できない。
# 今日壊れていなくても、blast radius が「guard 全体の消失」なので class を閉じる。
#
# なぜ shell 1 行（`command -v node || exit 2; exec node ...`）を settings.json へ
# 直接書かないか: Claude Code が hook の `command` を shell 経由（sh -c）で実行するか
# argv 直渡しかは harness の実装依存で、repo 側からは固定できない。**この launcher は
# どちらでも動く**（shebang + 実行ビットのスクリプトは argv 直渡しでも起動する）。
# 同じ形の scripts/hooks/session-start.sh / post-tool-format.sh が現に稼働している。
# 「不要な wrapper」に見えても外さないこと — 外すと fail-open へ戻る。
#
# **この launcher の保証境界**: 閉じているのは `node` の PATH 解決だけ。**launcher 自身に
# 到達できない経路は依然 fail-open** で、repo 側からは閉じられない:
#   - harness が repo root 以外の cwd で相対 command を起動する（exit 127）
#     ※ 旧 `node scripts/hooks/pre-tool-guard.mjs` も同じ cwd 依存を持っていた
#   - この launcher の実行ビットが落ちる（exit 126）
#     ※ launcher 導入で新たに増えた依存。git は 100755 で追跡し、
#       scripts/__tests__/pre-tool-guard.test.ts が mode & 0o111 を assert する
# どちらも「exit 2 以外の非 0 = non-blocking error」として tool 実行が続行される。

# **意図的なトレードオフ**: node を解決できない時は全 matcher が block になるため、
# Bash も Read も止まりセッション内からは復旧できない（User が PATH を直すまで）。
# 既知の絶対パスを探しに行く逃げ道は置かない — guard の解決先を PATH 外の
# 決め打ちパスへ広げたくないのと、「node 不在なら exit 2」を test で固定できなくなるため。
# fail-open（guard 全体の消失）より、止まって気づける方を選ぶ。

set -u

if ! command -v node >/dev/null 2>&1; then
  # exit 2 = block。
  echo "BLOCKED: node を解決できないため PreToolUse guard を実行できません（fail closed、#2565）。PATH に node を通してから再実行してください。" >&2
  exit 2
fi

exec node "$(dirname "$0")/pre-tool-guard.mjs"
