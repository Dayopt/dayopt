#!/bin/bash

# Safe local dev entrypoint.
# Real secret values must not live in .env.local; use .op-env.agent references.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
OP_ENV_FILE="${OP_ENV_FILE:-.op-env.agent}"
# OP_ENV_FILE の差し替えは basename が .op-env.agent のものに限る（#2086 の
# 反証レビュー指摘）。任意名への差し替えを許すと、guard の内容検査
# （.op-env.agent 系のみ対象）を受けないファイルを script 内部の op run に
# 渡せてしまい、human / ci の参照が解決できる。
if [ "$(basename "$OP_ENV_FILE")" != ".op-env.agent" ]; then
  echo "❌ OP_ENV_FILE は basename が .op-env.agent のファイルに限ります（指定: $OP_ENV_FILE）" >&2
  exit 1
fi
OP_ENV_PATH="$ROOT_DIR/$OP_ENV_FILE"

cd "$ROOT_DIR"

error() {
  echo "❌ $1" >&2
}

# git worktree では gitignored の .op-env.agent が引き継がれないため、
# main checkout に実ファイルがあれば自動コピーする（中身は op:// 参照のみで実秘密なし）
if [[ ! -f "$OP_ENV_PATH" ]]; then
  git_common_dir="$(git -C "$ROOT_DIR" rev-parse --git-common-dir 2>/dev/null || true)"
  if [[ -n "$git_common_dir" ]]; then
    main_root="$(cd "$ROOT_DIR" && cd "$(dirname "$git_common_dir")" && pwd)"
    if [[ "$main_root" != "$ROOT_DIR" && -f "$main_root/$OP_ENV_FILE" ]]; then
      cp "$main_root/$OP_ENV_FILE" "$OP_ENV_PATH"
      echo "ℹ️  worktree に $OP_ENV_FILE が無いため main checkout ($main_root) からコピーしました" >&2
    fi
  fi
fi

if [[ ! -f "$OP_ENV_PATH" ]]; then
  error "$OP_ENV_FILE が見つかりません。"
  cat >&2 <<EOF

1Password 参照ファイルを作成してください:
  cp .op-env.agent.example .op-env.agent

.op-env.agent には実値ではなく op://... 参照だけを書きます。
詳細: docs/operations/secrets.md
EOF
  exit 1
fi

blocked_files=()
for env_file in ".env.local" "apps/product/.env.local" "apps/web/.env.local"; do
  if [[ -f "$ROOT_DIR/$env_file" ]]; then
    blocked_files+=("$env_file")
  fi
done

if (( ${#blocked_files[@]} > 0 )); then
  error ".env.local 実値ファイルが残っているため、通常 dev を停止します。"
  printf '  - %s\n' "${blocked_files[@]}" >&2
  cat >&2 <<EOF

通常の local dev は .op-env.agent + op run を使います。
上記ファイルを削除または退避してから再実行してください。

素の起動が必要な一時作業だけ:
  pnpm dev:raw
EOF
  exit 1
fi

# Supabase の接続先は local 固定。1Password の op:// 参照をそのまま使う
# DAYOPT_SUPABASE_TARGET=op は production を指していたため廃止した。
if [[ -n "${DAYOPT_SUPABASE_TARGET:-}" && "${DAYOPT_SUPABASE_TARGET}" != "local" ]]; then
  error "DAYOPT_SUPABASE_TARGET は廃止されました（Supabase local 固定）。"
  cat >&2 <<EOF

local dev の Supabase 接続は supabase status -o env が供給します。
1Password 参照で Supabase へ繋ぐ経路は production を指していたため削除しました。
詳細: docs/operations/secrets.md
EOF
  exit 1
fi

if ! command -v supabase >/dev/null 2>&1; then
  error "Supabase CLI が見つかりません。"
  exit 1
fi

if ! local_supabase_env="$(supabase status -o env 2>/dev/null)"; then
  echo "Supabase local を起動します..." >&2
  if ! supabase start >/dev/null; then
    error "Supabase local を起動できませんでした。Docker の状態を確認してください。"
    cat >&2 <<EOF

Docker Desktop を起動してから supabase start を手動で実行し、エラー内容を確認してください:
  supabase start
EOF
    exit 1
  fi

  if ! local_supabase_env="$(supabase status -o env 2>/dev/null)"; then
    error "起動後の Supabase local から URL / key を取得できませんでした。"
    exit 1
  fi
fi

get_local_supabase_env() {
  local key="$1"
  printf '%s\n' "$local_supabase_env" | awk -F= -v key="$key" '
    $1 == key {
      value = substr($0, index($0, "=") + 1)
      gsub(/^"/, "", value)
      gsub(/"$/, "", value)
      print value
      exit
    }
  '
}

# ローカル OAuth token flow に必要な MCP environment identity を冪等に投入する
# （supabase/local/mcp-identity-seed.sql。接続先は 127.0.0.1:54322 固定で
# hosted では実行不能）。seed が無くても困るのは OAuth route（503）だけ
# なので、失敗時は警告して dev は止めない。
if command -v psql >/dev/null 2>&1; then
  if ! psql postgresql://postgres:postgres@127.0.0.1:54322/postgres \
      -v ON_ERROR_STOP=1 -q \
      -f "$ROOT_DIR/supabase/local/mcp-identity-seed.sql" >/dev/null 2>&1; then
    echo "⚠️  MCP environment identity seed を適用できませんでした。ローカルの OAuth token 発行は 503 になります（pnpm db:seed:identity で再試行）" >&2
  fi
else
  echo "⚠️  psql が見つからないため MCP environment identity seed をスキップしました。ローカルの OAuth token 発行は 503 になります（pnpm db:seed:identity で適用）" >&2
fi

LOCAL_SUPABASE_URL="$(get_local_supabase_env API_URL)"
LOCAL_SUPABASE_ANON_KEY="$(get_local_supabase_env PUBLISHABLE_KEY)"
if [[ -z "$LOCAL_SUPABASE_ANON_KEY" ]]; then
  LOCAL_SUPABASE_ANON_KEY="$(get_local_supabase_env ANON_KEY)"
fi
LOCAL_SUPABASE_SECRET_KEY="$(get_local_supabase_env SECRET_KEY)"
if [[ -z "$LOCAL_SUPABASE_SECRET_KEY" ]]; then
  LOCAL_SUPABASE_SECRET_KEY="$(get_local_supabase_env SERVICE_ROLE_KEY)"
fi

if [[ -z "$LOCAL_SUPABASE_URL" || -z "$LOCAL_SUPABASE_ANON_KEY" || -z "$LOCAL_SUPABASE_SECRET_KEY" ]]; then
  error "Supabase local の URL / key を取得できませんでした。"
  exit 1
fi

exec op run --env-file="$OP_ENV_PATH" -- env \
  NEXT_PUBLIC_SUPABASE_URL="$LOCAL_SUPABASE_URL" \
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY="$LOCAL_SUPABASE_ANON_KEY" \
  SUPABASE_SECRET_KEY="$LOCAL_SUPABASE_SECRET_KEY" \
  pnpm --filter @dayopt/product dev:raw
