#!/bin/bash

# ========================================
# Dayopt - 管理者によるユーザー削除スクリプト
# ========================================
# Supabase Auth Admin API で user を hard delete する。
# auth.users が削除されると ON DELETE CASCADE で関連 row (user_settings,
# entries, tags 等) も全削除される点に注意。
#
# 用途: orphan user (auth.identities が空 / 壊れた user) を一旦削除して
# admin-create-user.sh で fresh 作成する dogfooding 用。
#
# 使い方:
#   op run --env-file=.op-env.human -- \
#     env USER_EMAIL=foo@example.com DAYOPT_CONFIRM_TARGET=<project-ref> \
#     bash scripts/runbook/admin-delete-user.sh
#
# DAYOPT_CONFIRM_TARGET は NEXT_PUBLIC_SUPABASE_URL から導いた project ref と
# 一致しないと削除しない（confirm-target.sh）。
# ========================================

set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/admin-common.sh"

USER_EMAIL="${USER_EMAIL:-}"

require_user_email
require_supabase_env
require_target_confirmation "$(supabase_ref_from_url "$NEXT_PUBLIC_SUPABASE_URL")" "user の hard delete（${USER_EMAIL}、関連 row も CASCADE 削除）"

auth_headers_json

# ========================================
# email から user ID を解決
# ========================================
echo "[Supabase] ${USER_EMAIL} の user ID を検索中..."

LOOKUP_URL="${NEXT_PUBLIC_SUPABASE_URL}/auth/v1/admin/users?per_page=1000"
LOOKUP_RESPONSE=$(curl -sS "${AUTH_HEADERS[@]}" "$LOOKUP_URL")

USER_ID=$(echo "$LOOKUP_RESPONSE" | jq -r --arg email "$USER_EMAIL" \
  '.users[]? | select(.email == $email) | .id' | head -n1)

if [[ -z "$USER_ID" || "$USER_ID" == "null" ]]; then
  echo "エラー: ${USER_EMAIL} の user が見つかりませんでした (既に削除済み？)" >&2
  exit 1
fi

echo "[Supabase] User ID: $USER_ID"

# ========================================
# hard delete
# ========================================
echo "[Supabase] hard delete を実行中..."

# mktemp は mkstemp(3) 経由でファイルを 0600 (owner のみ読み書き) で作成するため、
# curl が書き込む前の隙間なく world-readable な固定パスを避けられる。応答には
# live な token / 個人情報が載るので、抽出後は trap で確実に削除する。
# 固定パスのままだと (1) 同一ホストの別 uid が読める (2) 攻撃者が先に symlink を
# 置くと curl -o が任意ファイルを operator 権限で truncate する。
RESPONSE_FILE=$(mktemp "${TMPDIR:-/tmp}/admin-delete-user-response.XXXXXX")
trap 'rm -f "$RESPONSE_FILE"' EXIT

HTTP_STATUS=$(curl -sS -o "$RESPONSE_FILE" -w "%{http_code}" \
  -X DELETE \
  "${NEXT_PUBLIC_SUPABASE_URL}/auth/v1/admin/users/${USER_ID}" \
  "${AUTH_HEADERS[@]}")

if [[ "$HTTP_STATUS" -ge 200 && "$HTTP_STATUS" -lt 300 ]]; then
  echo ""
  echo "=== 完了 ==="
  echo "削除した user:"
  echo "  Email: $USER_EMAIL"
  echo "  User ID: $USER_ID"
  echo ""
  echo "次のステップ: admin-create-user.sh で fresh 作成"
else
  echo "エラー: 削除に失敗しました (HTTP $HTTP_STATUS)" >&2
  cat "$RESPONSE_FILE" >&2
  echo "" >&2
  exit 1
fi
