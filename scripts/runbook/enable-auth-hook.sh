#!/bin/bash

# ========================================
# Dayopt - Auth Hook 有効化スクリプト
# ========================================
# custom_access_token hook を Supabase プロジェクトで有効化する。
# JWTに subscription_status を埋め込み、entitledProcedureの毎リクエストDBクエリを排除。
#
# ========================================
# ⚠ production では現在このスクリプトを実行しない（#1946 で決着、2026-08-12）
# ========================================
# production の hook は**意図的に無効**にしてある。実測値 false を
# scripts/ci/production-auth-config-audit.mjs が期待値として pin している。
#
# 無効のままにする理由: この hook は課金 gate の性能最適化であって機能要件ではない。
# BILLING_ENFORCED が未設定の間、entitledProcedure は購読チェック自体を skip する
# （apps/product/src/lib/trpc/procedures.ts）ため、claim を載せても消せる DB クエリが
# 無い。claim が無い場合も context.ts → entitledProcedure の DB fallback で正しく動く。
#
# 実行してよい条件（すべて満たすこと）:
#   1. BILLING_ENFORCED=true で課金 gate が実際に効いている
#   2. entitledProcedure の DB fallback が実測で負荷になっている
#   3. 解約後の暴露窓が jwt_exp（現在 3600 秒）まで開くのを許容できる
#      — claim は token refresh まで更新されないため。OAuth 経路は設計上つねに
#        DB を読むので影響しない（旧 docs/projects 配下の設計メモ Decision 1、
#        docs/projects 全廃に伴い #2473 で削除。文脈は #1946 参照）
#
# 実行する時は**同じ変更で** production-auth-config-audit.mjs の
# `hook_custom_access_token_enabled` の expected を true にする。片方だけ変えると
# 日次 audit が恒久 failure になり、drift 検出そのものが止まる。
#
# 前提:
#   - マイグレーション適用済み（custom_access_token_hook 関数が存在すること）
#     ※ 通常は Supabase GitHub integration が migration を適用する。
#       手動 db push は emergency only。
#   - SUPABASE_ACCESS_TOKEN が設定済み
#     発行: https://supabase.com/dashboard/account/tokens
#
# 使い方:
#   chmod +x scripts/runbook/enable-auth-hook.sh
#   ./scripts/runbook/enable-auth-hook.sh
#
# dayopt project の Production 環境に対して実行する。
# PR Preview / staging 相当で有効化する場合は Supabase Dashboard 側で branch context を確認する。
# ========================================

set -euo pipefail

# ========================================
# プロジェクト参照ID
# ========================================
PROJECT_REF="yvglwblxrnrenfifsnje"

# ========================================
# アクセストークン確認
# ========================================
if [[ -z "${SUPABASE_ACCESS_TOKEN:-}" ]]; then
  echo "エラー: SUPABASE_ACCESS_TOKEN が未設定です"
  echo "発行先: https://supabase.com/dashboard/account/tokens"
  echo ""
  echo "  export SUPABASE_ACCESS_TOKEN=sbp_xxxxxxxx"
  echo "  $0"
  exit 1
fi

source "$(dirname "${BASH_SOURCE[0]}")/../tasks/confirm-target.sh"
require_target_confirmation "$PROJECT_REF" "production Auth config の書き換え（custom_access_token hook 有効化）"

# ========================================
# Auth Hook 有効化
# ========================================
echo "[dayopt/Production] custom_access_token hook を有効化中..."

# mktemp は mkstemp(3) 経由でファイルを 0600 (owner のみ読み書き) で作成するため、
# curl が書き込む前の隙間なく world-readable な固定パスを避けられる。応答には
# live な token / 個人情報が載るので、抽出後は trap で確実に削除する。
# 固定パスのままだと (1) 同一ホストの別 uid が読める (2) 攻撃者が先に symlink を
# 置くと curl -o が任意ファイルを operator 権限で truncate する。
RESPONSE_FILE=$(mktemp "${TMPDIR:-/tmp}/auth-hook-response.XXXXXX")
trap 'rm -f "$RESPONSE_FILE"' EXIT

HTTP_STATUS=$(curl -s -o "$RESPONSE_FILE" -w "%{http_code}" \
  -X PATCH \
  "https://api.supabase.com/v1/projects/${PROJECT_REF}/config/auth" \
  -H "Authorization: Bearer ${SUPABASE_ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "GOTRUE_HOOK_CUSTOM_ACCESS_TOKEN_ENABLED": true,
    "GOTRUE_HOOK_CUSTOM_ACCESS_TOKEN_URI": "pg-functions://postgres/public/custom_access_token_hook"
  }')

if [[ "$HTTP_STATUS" -ge 200 && "$HTTP_STATUS" -lt 300 ]]; then
  echo "[dayopt/Production] Auth Hook 有効化完了 (HTTP $HTTP_STATUS)"
else
  echo "エラー: Auth Hook の有効化に失敗しました (HTTP $HTTP_STATUS)"
  cat "$RESPONSE_FILE"
  exit 1
fi

# ========================================
# 3. 確認
# ========================================
echo ""
echo "=== 完了 ==="
echo "環境: dayopt / Production ($PROJECT_REF)"
echo "Hook: custom_access_token_hook"
echo ""
echo "既存ユーザーのJWTは最大1時間で自動リフレッシュされ、"
echo "subscription_status クレームが反映されます。"
echo "それまではDBフォールバックが動作するため、ダウンタイムはありません。"
