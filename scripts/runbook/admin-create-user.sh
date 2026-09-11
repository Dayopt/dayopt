#!/bin/bash

# ========================================
# Dayopt - 管理者によるユーザー作成スクリプト
# ========================================
# Supabase Auth Admin API で email + password の user を作成する。
# email_confirm: true を指定するため confirmation メールをスキップして即 login 可能。
#
# 用途: dogfooding / 内部テスト用の account を CLI で作る。通常の signup flow が
# 使えない / bypass したい時のみ使用。
#
# 前提:
#   - .op-env.human が存在し、以下を含む:
#       NEXT_PUBLIC_SUPABASE_URL=op://...
#       SUPABASE_SECRET_KEY=op://...
#   - 1Password CLI (op) に signin 済み (op signin)
#   - password を保存する 1Password item を事前に作成済み
#
# 使い方:
#   op run --env-file=.op-env.human -- \
#     env USER_EMAIL=foo@example.com PASSWORD_ITEM_ID=xxxxxxxxxxxxxxxxxxxxxxxxxx \
#     bash scripts/runbook/admin-create-user.sh
#
# 環境:
#   `.op-env.human` は human vault（本番キー）を参照するため、実行は production への操作になる。
#   実行したら手動作業ログを残す（docs/operations/tooling.md 第4部）。
# ========================================

set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/admin-common.sh"

# ========================================
# 入力チェック
# ========================================
USER_EMAIL="${USER_EMAIL:-}"
PASSWORD_ITEM_ID="${PASSWORD_ITEM_ID:-}"

require_user_email_and_password_item "admin-create-user.sh"
require_supabase_env_verbose

# ========================================
# 1Password から password を取得
# ========================================
echo "[1Password] item ${PASSWORD_ITEM_ID} から password を取得中..."
USER_PASSWORD=$(op item get "$PASSWORD_ITEM_ID" --fields password --reveal)

if [[ -z "$USER_PASSWORD" ]]; then
  echo "エラー: 1Password から password を取得できませんでした" >&2
  exit 1
fi

# ========================================
# Supabase Auth Admin API で user 作成
# ========================================
echo "[Supabase] ${USER_EMAIL} を作成中..."

REQUEST_BODY=$(jq -n \
  --arg email "$USER_EMAIL" \
  --arg password "$USER_PASSWORD" \
  '{email: $email, password: $password, email_confirm: true}')

# mktemp は mkstemp(3) 経由でファイルを 0600 (owner のみ読み書き) で作成するため、
# curl が書き込む前の隙間なく world-readable な固定パスを避けられる。応答には
# live な token / 個人情報が載るので、抽出後は trap で確実に削除する。
# 固定パスのままだと (1) 同一ホストの別 uid が読める (2) 攻撃者が先に symlink を
# 置くと curl -o が任意ファイルを operator 権限で truncate する。
RESPONSE_FILE=$(mktemp "${TMPDIR:-/tmp}/admin-create-user-response.XXXXXX")
trap 'rm -f "$RESPONSE_FILE"' EXIT

auth_headers_json

HTTP_STATUS=$(curl -sS -o "$RESPONSE_FILE" -w "%{http_code}" \
  -X POST \
  "${NEXT_PUBLIC_SUPABASE_URL}/auth/v1/admin/users" \
  "${AUTH_HEADERS[@]}" \
  -d "$REQUEST_BODY")

if [[ "$HTTP_STATUS" -ge 200 && "$HTTP_STATUS" -lt 300 ]]; then
  USER_ID=$(jq -r '.id' "$RESPONSE_FILE")
  echo ""
  echo "=== 完了 ==="
  echo "Email: $USER_EMAIL"
  echo "User ID: $USER_ID"
  echo "Email confirmed: true (即 login 可能)"
else
  echo "エラー: user 作成に失敗しました (HTTP $HTTP_STATUS)" >&2
  cat "$RESPONSE_FILE" >&2
  echo "" >&2
  exit 1
fi
