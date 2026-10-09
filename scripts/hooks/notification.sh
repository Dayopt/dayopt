#!/bin/bash
# Notification hook: 許可待ち・アイドル時にmacOSデスクトップ通知を送信
# 音: Ping（許可待ちを示す、注意を引く音）

INPUT=$(cat)
# macOS 以外（Claude Code on the web の Linux container 等）では通知手段が無いので no-op
command -v osascript >/dev/null 2>&1 || exit 0
TITLE=$(echo "$INPUT" | jq -r '.title // "Claude Code"')
MESSAGE=$(echo "$INPUT" | jq -r '.message // "通知があります"')

osascript -e "display notification \"$MESSAGE\" with title \"$TITLE\" sound name \"Ping\""

exit 0
