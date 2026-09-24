# ユーザーレベル AI 設定

Codex / Claude Code のユーザーレベル設定（`~/.codex`・`~/.claude`）の正本。本来の場所には `link.sh` が **main checkout**（`~/Desktop/dayopt`）内のこの dir を指す symlink を張る。
消しても git で戻り、別デバイスでは clone + `link.sh` で同じ状態になる。project 側の `.claude/skills → ../.agents/skills` と同じ構図を user 側へ広げたもの。

| repo 内                        | 設置先                            |
| ------------------------------ | --------------------------------- |
| `codex/AGENTS.md`              | `~/.codex/AGENTS.md`              |
| `codex/rules/default.rules`    | `~/.codex/rules/default.rules`    |
| `claude/settings.json`         | `~/.claude/settings.json`         |
| `claude/statusline-command.sh` | `~/.claude/statusline-command.sh` |
| `claude/skills/`               | `~/.claude/skills`                |

`codex/config.intent.toml` は link しない参照用コピー。`~/.codex/config.toml` の大半は Codex が自動で書く機械状態（project trust・plugin・hooks.state）なので、意図部分だけ手で写す。

入れないもの: `~/.claude.json`、`~/.claude/settings.local.json`、`~/.config/gh-agent/`（認証・マシン固有）、MCP 定義（`mcp-usage` skill）。この repo は public なので、ここへ書く内容は公開される。

## 運用

- symlink の先は main checkout。そこで branch を切り替えると設定もその branch の内容になるので、main checkout は main のまま使い、作業は worktree で行う
- ツールや手で設定を変えると main checkout に未 commit の差分として出る。worktree へ写して通常の PR で取り込む
- ツールが「一時 file に書いて rename」で保存すると symlink が実 file に化けて追跡から外れる。設定を UI から変えた後は `link.sh --check` で確認する

## 新デバイス

```bash
git clone https://github.com/Dayopt/dayopt.git ~/Desktop/dayopt
~/Desktop/dayopt/.agents/user/link.sh
~/Desktop/dayopt/.agents/user/link.sh --check
```

`claude/settings.json` の絶対パスは username `tanakatomoya` 前提。
