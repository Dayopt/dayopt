export type EnvVisibility = 'public' | 'secret';
export type EnvEnvironment = 'local' | 'staging' | 'production' | 'shared';

export type EnvSchemaEntry = {
  envName: string;
  required: boolean;
  visibility: EnvVisibility;
  environment: EnvEnvironment;
  vault: string;
  item: string;
  field: string;
  /**
   * schema が実態より先行している optional entry の理由。1password:check が
   * 非 OK 状態を表示する際、この文言を添えて「機能未展開だから欠けている」ことを
   * 明示する（#2063）。required entry には付けない（そちらは exit 1 の理由が
   * すでに status 行だけで自明なため）。
   */
  pendingReason?: string;
};

export type OperationalItem = {
  vault: string;
  item: string;
  required: boolean;
};

/** 実在してはいけない field。存在すれば 1password:check を失敗させる。 */
export type ForbiddenField = {
  vault: string;
  item: string;
  field: string;
  reason: string;
};

const agent = 'agent';
const human = 'human';
const ci = 'ci';

function envEntry(
  envName: string,
  required: boolean,
  visibility: EnvVisibility,
  environment: EnvEnvironment,
  vault: string,
  item: string,
  field = envName,
): EnvSchemaEntry {
  return { envName, required, visibility, environment, vault, item, field };
}

/** schema先行 entry 用。pendingReason 付きの envEntry。 */
function pendingEnvEntry(
  envName: string,
  visibility: EnvVisibility,
  environment: EnvEnvironment,
  vault: string,
  item: string,
  pendingReason: string,
  field = envName,
): EnvSchemaEntry {
  return { envName, required: false, visibility, environment, vault, item, field, pendingReason };
}

export const envSchema: EnvSchemaEntry[] = [
  // Supabase の接続情報（URL / anon key / service role key / DB password）は
  // agent（旧 Dayopt-Staging）に置かない。常設 staging 環境が存在せず、この 4 field は
  // production の複製になっていた。local dev の接続は scripts/tasks/dev-with-op.sh が
  // supabase status -o env から注入するため 1Password を経由しない。
  // SUPABASE_ACCESS_TOKEN は human 側を正本に一本化した（#1933、2026-08-17 に
  // human/supabase-cli へ再切り出し、#2127）。human と同一値の複製を agent から
  // 読む理由が無いため、ここには entry を置かない。
  envEntry('CRON_SECRET', false, 'secret', 'staging', agent, 'supabase'),
  envEntry('SEND_EMAIL_HOOK_SECRET', false, 'secret', 'staging', agent, 'supabase'),

  envEntry('UPSTASH_REDIS_REST_URL', false, 'secret', 'staging', agent, 'upstash'),
  envEntry('UPSTASH_REDIS_REST_TOKEN', false, 'secret', 'staging', agent, 'upstash'),

  envEntry('STRIPE_SECRET_KEY', false, 'secret', 'staging', agent, 'stripe-test'),
  envEntry('STRIPE_ACCOUNT_ID', false, 'public', 'staging', agent, 'stripe-test'),
  envEntry('STRIPE_LIVEMODE', false, 'public', 'staging', agent, 'stripe-test'),
  envEntry('STRIPE_WEBHOOK_SECRET', false, 'secret', 'staging', agent, 'stripe-test'),
  envEntry('NEXT_PUBLIC_STRIPE_PRO_PRICE_ID', false, 'public', 'staging', agent, 'stripe-test'),

  envEntry('RESEND_API_KEY', false, 'secret', 'shared', agent, 'resend'),
  envEntry('RESEND_FROM_EMAIL', false, 'public', 'shared', agent, 'resend'),
  pendingEnvEntry(
    'RESEND_WEBHOOK_SECRET',
    'secret',
    'staging',
    agent,
    'resend',
    '旧 Staging/resend（human/resend-old-staging に退避中）から agent/resend への field 統合待ち（#2086 cutover）',
  ),

  envEntry('NEXT_PUBLIC_APP_URL', true, 'public', 'local', agent, 'app'),
  envEntry('NEXT_PUBLIC_SITE_URL', false, 'public', 'staging', agent, 'app'),
  envEntry('RECOVERY_CODE_PEPPER', false, 'secret', 'staging', agent, 'app'),
  envEntry('OAUTH_CLAUDE_REDIRECT_URIS', false, 'public', 'staging', agent, 'app'),
  envEntry('OAUTH_CHATGPT_REDIRECT_URIS', false, 'public', 'staging', agent, 'app'),
  envEntry('OAUTH_CURSOR_REDIRECT_URIS', false, 'public', 'staging', agent, 'app'),
  envEntry('MCP_OAUTH_ENVIRONMENT', false, 'public', 'staging', agent, 'app'),
  envEntry('OAUTH_AUTHORIZATION_SERVER_URI', false, 'public', 'staging', agent, 'app'),
  envEntry('MCP_CANONICAL_RESOURCE_URI', false, 'public', 'staging', agent, 'app'),
  envEntry('MCP_OAUTH_PREVIEW_BRANCH', false, 'public', 'staging', agent, 'app'),
  envEntry('MCP_OAUTH_PREVIEW_UPSTASH_HOST', false, 'public', 'staging', agent, 'app'),
  envEntry('MCP_WRITE_ENABLED_CLIENTS', false, 'public', 'staging', agent, 'app'),

  envEntry('NEXT_PUBLIC_TURNSTILE_SITE_KEY', false, 'public', 'shared', agent, 'turnstile'),
  envEntry('TURNSTILE_SECRET_KEY', false, 'secret', 'shared', agent, 'turnstile'),
  envEntry('ANTHROPIC_API_KEY', false, 'secret', 'shared', agent, 'anthropic'),

  envEntry('VERCEL_TOKEN', false, 'secret', 'shared', ci, 'vercel'),
  envEntry('VERCEL_TEAM_ID', false, 'public', 'shared', ci, 'vercel'),
  envEntry('VERCEL_PROJECT_ID_STAGING', false, 'public', 'shared', ci, 'vercel'),
  envEntry('VERCEL_PROJECT_ID_PRODUCTION', false, 'public', 'shared', ci, 'vercel'),
  // agent 用 Vercel token（#2086 plan v2）。CI と agent の VERCEL_TOKEN 二重用途を
  // 解消するため agent は別発行 token を使う。発行までは replica:check を User 実行に倒す
  pendingEnvEntry(
    'VERCEL_TOKEN',
    'secret',
    'shared',
    agent,
    'vercel',
    'agent 用 token 未発行（#2086 plan v2）。User 発行後に item を作り replica:check の参照を切り替える',
  ),

  envEntry('GOOGLE_SITE_VERIFICATION', false, 'public', 'shared', agent, 'google'),
  envEntry('YANDEX_VERIFICATION', false, 'public', 'shared', agent, 'google'),
  envEntry('YAHOO_VERIFICATION', false, 'public', 'shared', agent, 'google'),

  // 外部カレンダー取り込み用の専用 OAuth client（Supabase Auth の Google provider とは別物）。
  // agent（旧 Dayopt-Staging）/google-calendar item は 2026-08-14 実測時点で 1Password に
  // 存在しない（#2063）。test mode の Google OAuth client 作成後に item を
  // 作れば解消する見込みの pending なので pendingReason を付ける。
  ...(
    [
      ['GOOGLE_CALENDAR_CLIENT_ID', 'public'],
      ['GOOGLE_CALENDAR_PROJECT_NUMBER', 'public'],
      ['GOOGLE_CALENDAR_CLIENT_SECRET', 'secret'],
      ['CALENDAR_TOKEN_ENCRYPTION_KEY', 'secret'],
      ['GOOGLE_CALENDAR_REDIRECT_URIS', 'public'],
    ] as const
  ).map(([field, visibility]) =>
    pendingEnvEntry(
      field,
      visibility,
      'staging',
      agent,
      'google-calendar',
      'item 未作成（2026-08-14 実測、#2063）。test mode の Google OAuth client 作成後に解消',
    ),
  ),
];

export const productionEnvSchema: EnvSchemaEntry[] = [
  // Supabase の接続情報はここが唯一の master。Staging 側の複製を撤去した分の
  // required 検査をこちらへ移す。欠けると production の runtime に加えて、
  // .op-env.human 経由の管理者運用（緊急時のユーザー復旧）が op run の
  // 参照解決で止まる。
  envEntry('NEXT_PUBLIC_SUPABASE_URL', true, 'public', 'production', human, 'supabase'),
  envEntry('NEXT_PUBLIC_SUPABASE_ANON_KEY', true, 'public', 'production', human, 'supabase'),
  envEntry('SUPABASE_SERVICE_ROLE_KEY', true, 'secret', 'production', human, 'supabase'),
  // SUPABASE_ACCESS_TOKEN は 2026-08-17 に human/supabase-cli へ専用 item として切り出した
  // （#2127）。「アプリが env として消費する値の束」と「人間・CLI が使う operational
  // credential（rotation 対象、有効期限 field 必須）」を分離する命名規約に合わせたもの。
  envEntry('SUPABASE_ACCESS_TOKEN', false, 'secret', 'production', human, 'supabase-cli'),
  // .op-env.human 経由の `supabase db query --linked` が要求する。欠けると
  // seed が user 作成だけ成功して DB 投入で止まり、部分適用になる。
  envEntry('SUPABASE_DB_PASSWORD', true, 'secret', 'production', human, 'supabase'),
  envEntry('CRON_SECRET', false, 'secret', 'production', human, 'supabase'),
  envEntry('SEND_EMAIL_HOOK_SECRET', false, 'secret', 'production', human, 'supabase'),
  envEntry('UPSTASH_REDIS_REST_URL', false, 'secret', 'production', human, 'upstash'),
  envEntry('UPSTASH_REDIS_REST_TOKEN', false, 'secret', 'production', human, 'upstash'),
  envEntry('STRIPE_SECRET_KEY', false, 'secret', 'production', human, 'stripe-live'),
  pendingEnvEntry(
    'STRIPE_ACCOUNT_ID',
    'public',
    'production',
    human,
    'stripe-live',
    '課金未有効化のため未設定（2026-08-11 実測、#1669）。durable Billing 有効化時に STRIPE_SECRET_KEY と併せて設定する',
  ),
  pendingEnvEntry(
    'STRIPE_LIVEMODE',
    'public',
    'production',
    human,
    'stripe-live',
    '課金未有効化のため未設定（2026-08-11 実測、#1669）。durable Billing 有効化時に STRIPE_SECRET_KEY と併せて設定する',
  ),
  pendingEnvEntry(
    'STRIPE_WEBHOOK_SECRET',
    'secret',
    'production',
    human,
    'stripe-live',
    '課金未有効化のため未設定（2026-08-11 実測、#1669）',
  ),
  pendingEnvEntry(
    'NEXT_PUBLIC_STRIPE_PRO_PRICE_ID',
    'public',
    'production',
    human,
    'stripe-live',
    '課金未有効化のため未設定（2026-08-11 実測、#1669）',
  ),
  envEntry('RESEND_WEBHOOK_SECRET', false, 'secret', 'production', human, 'resend'),
  envEntry('RESEND_WEBHOOK_SECRET', false, 'secret', 'production', human, 'resend-web'),
  envEntry('NEXT_PUBLIC_SENTRY_DSN', true, 'public', 'production', human, 'sentry'),
  envEntry('SENTRY_DSN', true, 'public', 'production', human, 'sentry'),
  envEntry('SENTRY_ORG', true, 'public', 'production', human, 'sentry'),
  envEntry('SENTRY_PROJECT', true, 'public', 'production', human, 'sentry'),
  envEntry('NEXT_PUBLIC_SENTRY_DSN', true, 'public', 'production', human, 'sentry-web'),
  envEntry('SENTRY_DSN', true, 'public', 'production', human, 'sentry-web'),
  envEntry('SENTRY_ORG', true, 'public', 'production', human, 'sentry-web'),
  envEntry('SENTRY_PROJECT', true, 'public', 'production', human, 'sentry-web'),
  // item 名は sentry ではなく sentry-login（2026-08-14 実測の命名 drift、#2063）。
  // 修正前は op の曖昧解決で偶然通っていたが、1password:check の恒久 red の
  // 直接原因だった（required entry が MISSING_ITEM で fail）。
  envEntry('SENTRY_AUTH_TOKEN', true, 'secret', 'production', human, 'sentry-login'),
  // NEXT_PUBLIC_APP_URL / NEXT_PUBLIC_SITE_URL / RECOVERY_CODE_PEPPER は
  // replica（Vercel Production Env）に値がある可能性がある「反映漏れ」枠。
  // schema先行（機能未展開）ではないため pendingReason は付けない。EMPTY の場合は
  // docs/operations/secrets.md §1password:check が失敗した時 の「本当の欠落」
  // 判定に従い、Vercel → master への逆流で埋める（#1940 の枠）。
  envEntry('NEXT_PUBLIC_APP_URL', false, 'public', 'production', human, 'app'),
  envEntry('NEXT_PUBLIC_SITE_URL', false, 'public', 'production', human, 'app'),
  envEntry('RECOVERY_CODE_PEPPER', false, 'secret', 'production', human, 'app'),
  ...(
    [
      'OAUTH_CLAUDE_REDIRECT_URIS',
      'OAUTH_CHATGPT_REDIRECT_URIS',
      'OAUTH_CURSOR_REDIRECT_URIS',
      'MCP_OAUTH_ENVIRONMENT',
      'OAUTH_AUTHORIZATION_SERVER_URI',
      'MCP_CANONICAL_RESOURCE_URI',
      'MCP_WRITE_ENABLED_CLIENTS',
    ] as const
  ).map((field) =>
    pendingEnvEntry(
      field,
      'public',
      'production',
      human,
      'app',
      '#2553（#1754 epic の Production 有効化ゲート）の production 未展開分',
    ),
  ),

  // human 側は 2026-08-14 実測ですべて OK（値が揃っている）。pending な
  // 状態ではないため pendingReason は付けない。
  envEntry('GOOGLE_CALENDAR_CLIENT_ID', false, 'public', 'production', human, 'google-calendar'),
  envEntry(
    'GOOGLE_CALENDAR_PROJECT_NUMBER',
    false,
    'public',
    'production',
    human,
    'google-calendar',
  ),
  envEntry(
    'GOOGLE_CALENDAR_CLIENT_SECRET',
    false,
    'secret',
    'production',
    human,
    'google-calendar',
  ),
  envEntry(
    'CALENDAR_TOKEN_ENCRYPTION_KEY',
    false,
    'secret',
    'production',
    human,
    'google-calendar',
  ),
  // human には human origin だけを入れる。localhost を混ぜると
  // forwarded host 経由で allowlist を通過されうる。
  envEntry(
    'GOOGLE_CALENDAR_REDIRECT_URIS',
    false,
    'public',
    'production',
    human,
    'google-calendar',
  ),
];

// schema から entry を消しても、実 vault に field が残っていれば
// agent（旧 Dayopt-Staging） へのアクセスだけで human の接続情報が取れてしまう。
// schema の不在（envSchema 側）と実在の禁止（ここ）は別物なので両方を持つ。
export const forbiddenFields: ForbiddenField[] = [
  ...[
    'NEXT_PUBLIC_SUPABASE_URL',
    'NEXT_PUBLIC_SUPABASE_ANON_KEY',
    'SUPABASE_SERVICE_ROLE_KEY',
    'SUPABASE_DB_PASSWORD',
  ].map((field) => ({
    vault: agent,
    item: 'supabase',
    field,
    reason: '常設 agent が無いため、この field は human の複製にしかならない',
  })),
  // SUPABASE_ACCESS_TOKEN は human 正本へ一本化済み（#1933）。schema から
  // entry を消しただけでは agent vault 経由で human Management API
  // token が取得できる状態を検出できないため、接続 4 field と同じ理由で
  // forbiddenFields に登録する。field 削除（1Password 側、User 手作業）が
  // 済むまで 1password:check は意図どおり red になる（fail-closed）。
  {
    vault: agent,
    item: 'supabase',
    field: 'SUPABASE_ACCESS_TOKEN',
    reason: 'human 正本へ一本化済み（#1933）',
  },
];

export const operationalItems: OperationalItem[] = [
  { vault: human, item: 'github-login', required: true },
  { vault: human, item: 'github-ssh', required: true },
  { vault: human, item: 'domain', required: true },
  { vault: human, item: 'resend-support-replies', required: true },
  // Supabase Dashboard の GUI ログイン。op:// では参照されない（#2127）。
  { vault: human, item: 'supabase-login', required: true },
  // Upstash Console の GUI ログイン。op:// では参照されない（#2127）。
  { vault: human, item: 'upstash-login', required: true },
];

export const onePasswordEnvSchema = [...envSchema, ...productionEnvSchema];
