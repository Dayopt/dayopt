#!/bin/bash

# ========================================
# Dayopt - 開発用データ投入スクリプト
# ========================================
# 使い方:
#   chmod +x scripts/tasks/seed-dev-data.sh
#   ./scripts/tasks/seed-dev-data.sh                 # ローカルDB（デフォルト）
#   USE_LINKED_DB=true ./scripts/tasks/seed-dev-data.sh  # linked DB（緊急時のみ）
# ========================================

set -e

# ========================================
# 環境変数の取得
# ========================================
LOCAL_URL="http://127.0.0.1:54321"
LOCAL_ANON_KEY="sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH"

if [ "${USE_LINKED_DB:-}" = "true" ]; then
  echo "☁️  linked Supabase モード（緊急時のみ）"
  SUPABASE_URL="${NEXT_PUBLIC_SUPABASE_URL:-}"
  ANON_KEY="${NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:-}"

  if [ -z "$SUPABASE_URL" ] || [ -z "$ANON_KEY" ]; then
    echo "❌ NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY が未設定です"
    echo "   op run --env-file=.op-env.human -- env USE_LINKED_DB=true pnpm db:seed を実行してください"
    exit 1
  fi
  DB_TARGET="--linked"
else
  echo "🔧 ローカルDB モード"
  SUPABASE_URL="$LOCAL_URL"
  ANON_KEY="$LOCAL_ANON_KEY"
  DB_TARGET="--local"
fi

echo "  URL: $SUPABASE_URL"
echo ""

echo "開発用データを投入します..."

# ========================================
# 1. テストユーザーの作成
# ========================================
echo "テストユーザーを作成中..."
USER_RESPONSE=$(curl -s -X POST "${SUPABASE_URL}/auth/v1/signup" \
  -H "apikey: ${ANON_KEY}" \
  -H "Content-Type: application/json" \
  -d '{
    "email": "dev@example.com",
    "password": "password123"
  }')

USER_ID=$(echo $USER_RESPONSE | jq -r '.user.id')

if [ "$USER_ID" == "null" ] || [ -z "$USER_ID" ]; then
  echo "ユーザー作成に失敗しました"
  echo $USER_RESPONSE | jq .
  exit 1
fi

echo "ユーザー作成成功: $USER_ID"

# ========================================
# 2. サンプルPlan / Recordの作成
# ========================================
echo "サンプルPlan / Recordを作成中..."

cat > /tmp/seed_timeblocks.sql <<EOF
DO \$\$
BEGIN
-- サンプルPlan 1
INSERT INTO public.plans (
  user_id, title, note, start_at, end_at
) VALUES (
  '${USER_ID}',
  'Development task',
  'Feature implementation and code review',
  NOW() + INTERVAL '1 hour',
  NOW() + INTERVAL '3 hours'
);

-- サンプルPlan 2
INSERT INTO public.plans (
  user_id, title, start_at, end_at
) VALUES (
  '${USER_ID}',
  'Auth system testing',
  NOW() + INTERVAL '4 hours',
  NOW() + INTERVAL '5 hours'
);

-- サンプルPlan 3と、それに紐づくRecord
WITH inserted_plan AS (
  INSERT INTO public.plans (
    user_id, title, note, start_at, end_at
  ) VALUES (
    '${USER_ID}',
    'Daily review',
    'Daily task review and next day planning',
    NOW() - INTERVAL '2 hours',
    NOW() - INTERVAL '1 hour'
  )
  RETURNING id, user_id, title, note, start_at
)
INSERT INTO public.records (
  user_id, title, note, start_at, end_at, source
)
SELECT
  user_id,
  title,
  note,
  start_at,
  NOW() - INTERVAL '50 minutes',
  'from_plan'
FROM inserted_plan;

-- サンプルカテゴリー / アクティビティ（旧 tags は #2175 で物理削除済み）
-- 色・アイコンを持つのはカテゴリーだけで、アクティビティは所属カテゴリーから継承する
WITH inserted_categories AS (
  INSERT INTO public.categories (user_id, name, color) VALUES
    ('${USER_ID}', 'Engineering', 'blue'),
    ('${USER_ID}', 'Maintenance', 'red')
  RETURNING id, name
)
INSERT INTO public.activities (user_id, category_id, name)
SELECT '${USER_ID}', inserted_categories.id, seed.name
FROM inserted_categories
JOIN (VALUES
  ('Engineering', 'Frontend'),
  ('Engineering', 'Backend'),
  ('Maintenance', 'Bug fix'),
  ('Maintenance', 'Documentation')
) AS seed(category_name, name) ON seed.category_name = inserted_categories.name;
END;
\$\$;
EOF

supabase db query --file /tmp/seed_timeblocks.sql $DB_TARGET

echo "サンプルデータ投入完了"
echo ""
echo "===================="
echo "作成されたデータ"
echo "===================="
echo "ユーザー: dev@example.com"
echo "パスワード: password123"
echo "Plan: 3件"
echo "Record: 1件"
echo "カテゴリー: 2件"
echo "アクティビティ: 4件"
echo ""
echo "開発を開始できます！"
