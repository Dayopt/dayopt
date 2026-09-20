#!/bin/bash

# ========================================
# Dayopt - 破壊的な production 操作の対象確認
# ========================================
# 実際に操作される Supabase project ref を、実行者が DAYOPT_CONFIRM_TARGET に
# 打ち返した時だけ続行する（2026-09-14、Secret / Credential 監査 P2-2）。
#
# 期待値は「操作対象から導出した ref」なので、別 project を指したまま
# 惰性で確認を通すことができない。確認値の既定や省略は用意しない。
#
# 使い方:
#   source から: require_target_confirmation <project-ref> <操作の説明>
#   単体実行:   bash scripts/tasks/confirm-target.sh url <supabase-url> <操作の説明>
#               bash scripts/tasks/confirm-target.sh linked <supabase-dir> <操作の説明>
#
# 例（admin-delete-user.sh）:
#   op run --env-file=.op-env.human -- \
#     env USER_EMAIL=foo@example.com DAYOPT_CONFIRM_TARGET=<project-ref> \
#     bash scripts/runbook/admin-delete-user.sh
# ========================================

# https://<ref>.supabase.co → <ref>。形が違えば空を返す（呼び出し側が fail closed）。
supabase_ref_from_url() {
  local url="${1:-}"
  if [[ "$url" =~ ^https://([a-z0-9]{20})\.supabase\.co/?$ ]]; then
    echo "${BASH_REMATCH[1]}"
  fi
}

# supabase link 済みの ref（Supabase CLI が <supabase-dir>/.temp/project-ref に書く）。
supabase_linked_ref() {
  local dir="${1:-supabase}"
  local file="${dir}/.temp/project-ref"
  if [[ -f "$file" ]]; then
    tr -d '[:space:]' <"$file"
  fi
}

require_target_confirmation() {
  local target="${1:-}"
  local action="${2:-破壊的な操作}"
  if [[ -z "$target" ]]; then
    echo "エラー: ${action} の対象 project ref を特定できません。確認できない対象には実行しません" >&2
    exit 1
  fi
  if [[ "${DAYOPT_CONFIRM_TARGET:-}" != "$target" ]]; then
    echo "中止: ${action} は Supabase project ${target} に対して行われます。" >&2
    echo "対象が正しい場合だけ、DAYOPT_CONFIRM_TARGET=${target} を付けて再実行してください。" >&2
    exit 1
  fi
  echo "[確認済み] ${action} → ${target}"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  set -euo pipefail
  mode="${1:-}"
  case "$mode" in
    url) require_target_confirmation "$(supabase_ref_from_url "${2:-}")" "${3:-破壊的な操作}" ;;
    linked) require_target_confirmation "$(supabase_linked_ref "${2:-supabase}")" "${3:-破壊的な操作}" ;;
    *)
      echo "Usage: confirm-target.sh url <supabase-url> <action> | linked <supabase-dir> <action>" >&2
      exit 1
      ;;
  esac
fi
