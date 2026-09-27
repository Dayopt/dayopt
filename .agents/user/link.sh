#!/usr/bin/env bash
# ユーザーレベル AI 設定の正本（.agents/user/）を本来の場所へ symlink する。冪等。
#   ./link.sh            設置（既存の実 file/dir は <name>.bak-YYYYmmddHHMMSS に退避）
#   ./link.sh --dry-run  判定だけ表示
#   ./link.sh --check    全 pair が repo 内を指す symlink か検査（化けていたら exit 1）
set -euo pipefail
REPO="$(cd "$(dirname "$0")" && pwd)"

# worktree は branch:finish で消えるので、そこを指す symlink はすぐ壊れる。main checkout からだけ実行させる。
git_dir="$(git -C "$REPO" rev-parse --absolute-git-dir)"
common_dir="$(git -C "$REPO" rev-parse --path-format=absolute --git-common-dir)"
if [ "$git_dir" != "$common_dir" ]; then
  echo "refuse: $REPO は worktree の中。main checkout（例: ~/Desktop/dayopt/.agents/user/link.sh）から実行する" >&2
  exit 2
fi
MODE="${1:-link}"

# repo 内 path : 設置先
PAIRS=(
  "codex/AGENTS.md:$HOME/.codex/AGENTS.md"
  "codex/rules/default.rules:$HOME/.codex/rules/default.rules"
  "claude/settings.json:$HOME/.claude/settings.json"
  "claude/statusline-command.sh:$HOME/.claude/statusline-command.sh"
  "claude/skills:$HOME/.claude/skills"
)

fail=0
for pair in "${PAIRS[@]}"; do
  src="$REPO/${pair%%:*}"
  dst="${pair#*:}"
  [ -e "$src" ] || { echo "missing-src $src"; fail=1; continue; }

  if [ -L "$dst" ] && [ "$(readlink "$dst")" = "$src" ]; then
    echo "ok        $dst"
    continue
  fi

  case "$MODE" in
    --check)
      if [ -L "$dst" ]; then echo "wrong     $dst -> $(readlink "$dst")"
      elif [ -e "$dst" ]; then echo "not-link  $dst"
      else echo "absent    $dst"; fi
      fail=1
      ;;
    --dry-run)
      if [ -e "$dst" ] || [ -L "$dst" ]; then echo "would-backup+link $dst"
      else echo "would-link $dst"; fi
      ;;
    link)
      mkdir -p "$(dirname "$dst")"
      if [ -e "$dst" ] || [ -L "$dst" ]; then
        bak="$dst.bak-$(date +%Y%m%d%H%M%S)"
        mv "$dst" "$bak"
        echo "backup    $dst -> $bak"
      fi
      ln -sn "$src" "$dst"
      echo "linked    $dst -> $src"
      ;;
    *) echo "usage: $0 [--dry-run|--check]"; exit 2 ;;
  esac
done
exit "$fail"
