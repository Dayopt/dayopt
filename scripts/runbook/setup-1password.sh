#!/usr/bin/env bash
# Dayopt 1Password vault / item 骨組み作成スクリプト
#
# 使い方:
#   ./scripts/runbook/setup-1password.sh             # dry-run (全コマンドを echo)
#   ./scripts/runbook/setup-1password.sh --execute   # 実際に作成
#
# 前提:
#   - `op` CLI インストール済み (brew install 1password-cli)
#   - `op account list` でサインイン済み
#   - 初回専用。vault / item が既に存在すると重複作成される
#
# 詳細: docs/operations/secrets.md

set -euo pipefail

# ---------- モード判定 ----------
MODE="${1:-dry-run}"
if [ "$MODE" = "--execute" ]; then
  echo "🔴 EXECUTE MODE — 実際に 1Password に書き込みます"
  run() { op "$@"; }
else
  echo "🟢 DRY-RUN MODE — コマンドを echo するのみ。実行は --execute を渡す"
  run() { printf '  op '; printf '%q ' "$@"; printf '\n'; }
fi
echo ""

# ---------- 前提チェック ----------
if ! command -v op >/dev/null 2>&1; then
  echo "❌ op CLI が見つかりません。brew install 1password-cli"
  exit 1
fi

if ! op account list >/dev/null 2>&1; then
  echo "❌ 1Password にサインインしていません。eval \"\$(op signin)\""
  exit 1
fi

# 重複作成防止: 3 vault に item が既に存在していないか確認
# vault だけ作られて item が無い状態での再実行は許容 (Phase 1 で中断後の続行)
for vault in agent ci human; do
  if op vault get "$vault" >/dev/null 2>&1; then
    item_count=$(op item list --vault="$vault" --format=json 2>/dev/null | jq 'length')
    if [ "$item_count" -gt 0 ]; then
      echo "❌ vault '$vault' に既に $item_count 個の item が存在します。このスクリプトは初回専用です。"
      exit 1
    fi
  fi
done

# Phase 1 skip 判定: 3 vault 全てが既に存在すれば skip
SKIP_PHASE1=true
for vault in agent ci human; do
  if ! op vault get "$vault" >/dev/null 2>&1; then
    SKIP_PHASE1=false
    break
  fi
done

# ---------- NOTES テンプレ ----------
NOTES='発行日:
発行場所:
権限/scope:
再発行手順:
revoke手順:
依存先: '

# =========================================================
# Phase 1: Vault 作成
# =========================================================
if [ "$SKIP_PHASE1" = "true" ]; then
  echo "── Phase 1: Vault 作成 (skip: 3 vault 作成済み) ─────────────"
else
  echo "── Phase 1: Vault 作成 ─────────────────────────"
  run vault create agent --description "AI が op run で解決してよい credentials（信頼境界軸、#2086）"
  run vault create human --description "人間専用: 本番キー・login・recovery・個人系。AI 経路なし（#2086）"
  run vault create ci --description "CI が消費する token の master（SA 導入時に read scope にする、#2086）"
fi
echo ""

# =========================================================
# Phase 2: Item 骨組み作成
# =========================================================
echo "── Phase 2: Item 作成 (値は空、NOTES テンプレ付き) ─────────────"

# ----- agent -----
echo "  [agent]"

# 接続情報（URL / anon key / service role key / DB password / project-ref）は
# 意図的に作らない。常設 staging が無いため、置けば production の複製になる。
# SUPABASE_ACCESS_TOKEN は置かない。human/supabase-cli を正本に
# 一本化した（#1933、2026-08-17 に supabase-cli へ再切り出し、#2127）。
run item create --category=apicredential --vault=agent --title=supabase \
  --tags=dayopt/supabase notesPlain="$NOTES" \
  'SEND_EMAIL_HOOK_SECRET[concealed]=' \
  'CRON_SECRET[concealed]='

run item create --category=apicredential --vault=agent --title=upstash \
  --tags=dayopt/upstash notesPlain="$NOTES" \
  'UPSTASH_REDIS_REST_URL[text]=' \
  'UPSTASH_REDIS_REST_TOKEN[concealed]='

run item create --category=apicredential --vault=agent --title=stripe-test \
  --tags=dayopt/stripe notesPlain="$NOTES" \
  'STRIPE_SECRET_KEY[concealed]=' \
  'STRIPE_WEBHOOK_SECRET[concealed]=' \
  'NEXT_PUBLIC_STRIPE_PRO_PRICE_ID[text]=' \
  'publishable-key[text]='

# resend は旧 Staging（RESEND_WEBHOOK_SECRET）と旧 Shared（API_KEY / FROM_EMAIL）
# の 2 item を agent へ統合済み（#2086 cutover）。create は後段の 1 回にまとめる
run item create --category=apicredential --vault=agent --title=app \
  --tags=dayopt/internal notesPlain="$NOTES"$'\n⚠️ recovery-code-pepper は失うと全ユーザーの recovery code が復旧不能。別メディアに二重バックアップ必須' \
  'NEXT_PUBLIC_APP_URL[text]=' \
  'NEXT_PUBLIC_SITE_URL[text]=' \
  'RECOVERY_CODE_PEPPER[concealed]=' \
  'OAUTH_CLAUDE_REDIRECT_URIS[text]=' \
  'OAUTH_CHATGPT_REDIRECT_URIS[text]=' \
  'OAUTH_CURSOR_REDIRECT_URIS[text]=' \
  'MCP_OAUTH_ENVIRONMENT[text]=' \
  'OAUTH_AUTHORIZATION_SERVER_URI[text]=' \
  'MCP_CANONICAL_RESOURCE_URI[text]=' \
  'MCP_OAUTH_PREVIEW_BRANCH[text]=' \
  'MCP_OAUTH_PREVIEW_UPSTASH_HOST[text]=' \
  'MCP_WRITE_ENABLED_CLIENTS[text]='

# ----- human -----
echo "  [human]"

run item create --category=apicredential --vault=human --title=supabase \
  --tags=dayopt/supabase notesPlain="$NOTES" \
  'NEXT_PUBLIC_SUPABASE_URL[text]=' \
  'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY[concealed]=' \
  'SUPABASE_SECRET_KEY[concealed]=' \
  'SEND_EMAIL_HOOK_SECRET[concealed]=' \
  'CRON_SECRET[concealed]=' \
  'SUPABASE_DB_PASSWORD[concealed]=' \
  'project-ref[text]='

# operational credential（PAT / CLI token / rotation 対象）はサービス名 item から
# 分離する専用 item の初例（2026-08-17、#2127）。有効期限 field を必ず設定し、
# 1Password の expiry アラートに乗せる。
run item create --category=apicredential --vault=human --title=supabase-cli \
  --tags=dayopt/supabase notesPlain="$NOTES" \
  'SUPABASE_ACCESS_TOKEN[concealed]=' \
  '有効期限[text]='

run item create --category=apicredential --vault=human --title=upstash \
  --tags=dayopt/upstash notesPlain="$NOTES" \
  'UPSTASH_REDIS_REST_URL[text]=' \
  'UPSTASH_REDIS_REST_TOKEN[concealed]='

run item create --category=apicredential --vault=human --title=stripe-live \
  --tags=dayopt/stripe notesPlain="$NOTES"$'\n⚠️ 本番 Stripe キー。ローカル .env.local からは参照しない' \
  'STRIPE_SECRET_KEY[concealed]=' \
  'STRIPE_WEBHOOK_SECRET[concealed]=' \
  'NEXT_PUBLIC_STRIPE_PRO_PRICE_ID[text]=' \
  'publishable-key[text]='

run item create --category=apicredential --vault=human --title=resend \
  --tags=dayopt/resend notesPlain="$NOTES" \
  'RESEND_WEBHOOK_SECRET[concealed]='

run item create --category=apicredential --vault=human --title=resend-web \
  --tags=dayopt/resend notesPlain="$NOTES" \
  'RESEND_WEBHOOK_SECRET[concealed]='

run item create --category=apicredential --vault=human --title=sentry \
  --tags=dayopt/sentry notesPlain="$NOTES" \
  'NEXT_PUBLIC_SENTRY_DSN[text]=' \
  'SENTRY_DSN[text]=' \
  'SENTRY_ORG[text]=' \
  'SENTRY_PROJECT[text]='

run item create --category=apicredential --vault=human --title=sentry-web \
  --tags=dayopt/sentry notesPlain="$NOTES" \
  'NEXT_PUBLIC_SENTRY_DSN[text]=' \
  'SENTRY_DSN[text]=' \
  'SENTRY_ORG[text]=' \
  'SENTRY_PROJECT[text]='

run item create --category=apicredential --vault=human --title=app \
  --tags=dayopt/internal notesPlain="$NOTES"$'\n⚠️ recovery-code-pepper は失うと全ユーザーの recovery code が復旧不能。別メディアに二重バックアップ必須' \
  'NEXT_PUBLIC_APP_URL[text]=' \
  'NEXT_PUBLIC_SITE_URL[text]=' \
  'RECOVERY_CODE_PEPPER[concealed]=' \
  'OAUTH_CLAUDE_REDIRECT_URIS[text]=' \
  'OAUTH_CHATGPT_REDIRECT_URIS[text]=' \
  'OAUTH_CURSOR_REDIRECT_URIS[text]=' \
  'MCP_OAUTH_ENVIRONMENT[text]=' \
  'OAUTH_AUTHORIZATION_SERVER_URI[text]=' \
  'MCP_CANONICAL_RESOURCE_URI[text]=' \
  'MCP_WRITE_ENABLED_CLIENTS[text]='

# ----- 旧 Dayopt-Shared 分（agent / ci / human へ分配） -----
echo "  [旧 Dayopt-Shared 分 → agent / ci / human]"

run item create --category=apicredential --vault=agent --title=anthropic \
  --tags=dayopt/anthropic notesPlain="$NOTES" \
  'ANTHROPIC_API_KEY[concealed]='

run item create --category=apicredential --vault=agent --title=resend \
  --tags=dayopt/resend notesPlain="$NOTES"$'\nwebhook secret は Product=resend / Web=resend-web として環境ごとに分離' \
  'RESEND_API_KEY[concealed]=' \
  'RESEND_FROM_EMAIL[text]=' \
  'RESEND_WEBHOOK_SECRET[concealed]='

run item create --category=apicredential --vault=human --title=resend-support-replies \
  --tags=dayopt/resend notesPlain="$NOTES"$'\nGmail Send mail as 専用。Sending access / dayopt.app限定。アプリ用keyと共用しない。' \
  'RESEND_SMTP_API_KEY[concealed]='

# 実 item 名は sentry-login（Sentry の login 情報と同居。#2063 で判明した命名 drift、
# schema.ts と揃える）
run item create --category=apicredential --vault=human --title=sentry-login \
  --tags=dayopt/sentry notesPlain="$NOTES" \
  'SENTRY_AUTH_TOKEN[concealed]='

run item create --category=apicredential --vault=agent --title=turnstile \
  --tags=dayopt/cloudflare notesPlain="$NOTES" \
  'NEXT_PUBLIC_TURNSTILE_SITE_KEY[text]=' \
  'TURNSTILE_SECRET_KEY[concealed]='

run item create --category=login --vault=human --title=github-login \
  --tags=dayopt/github,recovery notesPlain="$NOTES"$'\nGitHub account login item. 既存 item がある場合は move + merge する。' \
  'username=' \
  'password[concealed]=' \
  'recovery-codes[concealed]=' \
  '2fa-notes[text]='

run item create --category=securenote --vault=human --title=github-ssh \
  --tags=dayopt/github \
  notesPlain="GitHub SSH key operational item. 既存 item がある場合は move + merge する。"

run item create --category=apicredential --vault=ci --title=vercel \
  --tags=dayopt/vercel notesPlain="$NOTES" \
  'VERCEL_TOKEN[concealed]=' \
  'VERCEL_TEAM_ID[text]=' \
  'VERCEL_PROJECT_ID_STAGING[text]=' \
  'VERCEL_PROJECT_ID_PRODUCTION[text]='

run item create --category=apicredential --vault=agent --title=google \
  --tags=dayopt/google notesPlain="$NOTES" \
  'GOOGLE_SITE_VERIFICATION[text]=' \
  'YANDEX_VERIFICATION[text]=' \
  'YAHOO_VERIFICATION[text]='

run item create --category=login --vault=human --title=domain \
  --tags=recovery notesPlain="$NOTES"$'\n⚠️ レジストラ乗っ取られたら事業終了。recovery codes を別メディアに二重バックアップ' \
  'username=' \
  'password[concealed]=' \
  'registrar-url[url]=' \
  'recovery-codes[concealed]=' \
  '2fa-notes[text]='

# recovery 情報の横断確認は索引 secure note ではなく 1Password タグ方式を使う
# （2026-08-14、#2069）。各 Login item に `recovery` タグを付け、
# `op item list --tags recovery --format=json` で横断確認する（タグ付け自体は
# 各 item 作成後の運用手順で行う。ここでの item 作成は不要）

# github / apple-developer は既存 item move または後日 GUI 作成推奨 (Phase 3 参照)
echo ""

# =========================================================
# Phase 3: 既存 item の移動 (情報のみ、実行は GUI 推奨)
# =========================================================
cat <<'EOF'
── Phase 3: 既存 item の移動 (GUI で手動実施推奨) ─────────────

以下は Development / ワーク vault の既存 item を human に移動する候補。
GUI で item を右クリック → Move → human を選択するのが最も安全。

  Development/GitHub (SSH_KEY)  →  human/github-ssh にリネーム
      ※ Dayopt commit にこの key を使っているか確認してから移動する
      ※ 別用途でも使っているなら、Dayopt 用に新規 SSH key 発行を推奨

  Development/GitHub (LOGIN)  →  human/github-login にリネーム
      ※ skeleton 作成済みの場合は既存 item の値を merge する

以下は移動せず既存 vault に残す (アカウント本体は分散させない方針):

  Development/Supabase (LOGIN)     → 残す
  Development/Sentry (LOGIN)       → 残す
  Development/Vercel (LOGIN)       → 残す
  ワーク/Stripe (LOGIN)            → 残す
  ワーク/Resend (LOGIN)            → 残す
  ワーク/Slack (LOGIN)             → 残す

apple-developer は .p8 / 証明書ファイルが揃ってから GUI で Document item 作成。
EOF

echo ""
echo "✅ 完了。Phase 2 の新規 item は全て空。次ステップ: 1Password GUI で値投入 → MISSING チェック"
