# Dayopt サービス棚卸し — 2026-09-30

読み取り専用のAPI/CLI、認証済みMCP、公開DNS、repo調査による観測記録。期待値は expected.yaml を参照。観測値から期待値を自動更新しない。秘密値・認証付きURLは記録しない。

## 保証境界

repo上の依存先と重要設定を3つの独立調査で確認。アカウント内全設定やrepo外の手動連携の完全性は保証しない。403、404、認証timeout、値再取得不可を未設定と解釈しない。

## 差異と未確認

- Integrationは現在同じProduct projectのPreview。専用project Production targetへの移行方針は構築途中。
- 古いbranch DB参照6件はVercelに残るが取得可能なSupabase一覧に存在せず個別取得404。削除済みとは断定しない。
- PostHogを有効にしたPreviewに削除用envがなく、アカウント削除で失敗する可能性。実行未検証。
- GitHubはpublic。GitHub Team移行後のprivate化方針は未実施。
- R2保存先はavatars/attachments。storage-backupの古い記述と差異。HEAD成功だけではretention/permissions/restoreを証明しない。
- Supabase Storageのsource資格情報は読み取り用途だがwrite/delete・RLS bypass可能。
- Production Stripe/PostHog未有効は現在方針と整合。
- 追加op runはauthorization_timeoutで子プロセス実行前に失敗。追加Vercel設定とruleset詳細は未取得。

## 観測データ（安全な射影）

```yaml
scope:
  project: Dayopt
  mode: read_only_draft
  file_created: false
  repository_sha: 650f62dc733831765aa8c110e29533b532e023f2
  snapshot_jst: 2026-09-30 10:43–11:13
  production_served_sha: 0aa61be1
  integration_served_sha: d5bdac2d9c464c7fbdb6dd626770dea540c58f6d
  expectation_revision: repository_sha
  completeness_boundary: repo_defined_dependencies_and_controls
  excludes:
    - customer_data
    - unrelated_accounts
    - service_changes
  unknown_policy: unknown_is_not_absent_or_failed
evidence:
  api_snapshot:
    source: op run API/CLI、認証済みread-only MCP
    observed_jst: 2026-09-30 10:43–10:58
  dns_snapshot:
    source: public_dns_query
    observed_jst: 2026-09-30 10:43–10:58
  db_metadata:
    source: 'Supabase MCP: mcp_mutation_control / cron.job の安全な列のみ'
    observed_jst: '2026-09-30'
    exact_acquisition_time: not_recorded
  repo:
    source: repository_sha
  recheck:
    status: authorization_timeout
    source: 追加op run。子プロセス実行前に失敗
    affected:
      - vercel_project_settings
      - github_ruleset_details
services:
  github:
    observed:
      repository: Dayopt/dayopt
      visibility: public
      branch: main
    verification:
      hooks: insufficient_access_403
      secrets_api: insufficient_access_403
      ruleset_details: authorization_timeout
  vercel:
    observed:
      product:
        id: prj_hByu1DGZWiuLk0yfV4Gz1T4aIjpa
        root: apps/product
        domains:
          - app.dayopt.app
          - mcp.dayopt.app
      web:
        id: prj_saTfo2jhvayTDb3YoMSKmla6QryZ
        root: apps/web
        domains:
          - dayopt.app
      github_link: Dayopt/dayopt
      production_db: yvglwblxrnrenfifsnje
      preview_default_db: tilwaprottpyhlfoggbb
      integration:
        project: product
        target: preview
        branch: integration
        origin: https://product-git-integration-dayopt.vercel.app
      shared_environment_variables: 0
      branch_db_overrides_missing_from_accessible_supabase:
        - xjkcookekempigbmmkdj
        - jqygokaqgoqmyqgjxcao
        - snqvbyjxxnqbuvgsnnby
        - jpmigigupyqgbjlyvsfl
        - fbcfebidugrmljltweng
        - zzrbmswtimfnhxswmkrz
      auto_assign_custom_domains:
        product: unknown
        web: unknown
    verification:
      sensitive_env_values: not_retrievable
      project_settings: authorization_timeout
      deployed_cron_heartbeat: unknown
  supabase:
    observed:
      main:
        ref: yvglwblxrnrenfifsnje
        site_url: https://app.dayopt.app
        signup_enabled: true
        captcha: turnstile
        email_hook: enabled
        google_provider: enabled
        email_autoconfirm: false
      integration:
        ref: tilwaprottpyhlfoggbb
        persistent: true
        with_data: false
        signup_enabled: false
        captcha: turnstile
        email_hook: disabled
        google_provider: enabled
        email_autoconfirm: true
      production_mcp_gate:
        writes_enabled: false
        enabled_client_ids: []
        billing_enforced: false
        revision: 0
      active_pg_cron_utc:
        cleanup-calendar-authority-retention: 50 * * * *
        cleanup-product-events: 40 3 * * *
        expire-calendar-revoke-authority: 10 * * * *
        expire-calendar-revoke-outbox: '* * * * *'
        finalize-calendar-revoke-guards: 15 * * * *
    verification:
      backups_api: insufficient_access_403
      google_selected_client: unknown
      captcha_secret_match: unknown
      storage_rls_and_schema_live: unknown
      pg_cron_success: unknown
  mcp_oauth:
    observed:
      integration_identity_mode: integration
    verification:
      client_registration: unknown
      sensitive_upstash_binding: unknown
      maintenance_write_fence: unknown
  stripe:
    observed:
      test:
        account: acct_1TBpLoRRjoh5xfrs
        price: price_1UDGzDRRjoh5xfrs4MMbK2rb
        currency: usd
        amount: 500
        interval: month
      webhook:
        id: we_1UKocjRRjoh5xfrsVsy2PhnV
        enabled: true
        livemode: false
        api_version: 2026-02-25.clover
        destination_node: stripe_endpoint
        bypass_ref: product_bypass
      events:
        - checkout.session.completed
        - customer.subscription.updated
        - customer.subscription.deleted
        - invoice.paid
        - invoice.payment_failed
      live:
        account: acct_1TBpLgIe9fUk4fJW
        active_prices: 0
        webhooks: 0
      production_billing_env: unset
    verification:
      portal_settings: unknown
      webhook_secret_replica: unknown
      billing_flow: not_executed
  resend:
    observed:
      domain:
        name: dayopt.app
        status: verified
        region: ap-northeast-1
        sending: enabled
        receiving: disabled
        open_tracking: false
        click_tracking: false
      product_events:
        - email.bounced
        - email.complained
        - email.delivered
        - email.delivery_delayed
        - email.failed
        - email.suppressed
      web_events:
        - email.bounced
        - email.complained
        - email.failed
        - email.suppressed
      webhook_status: enabled
    verification:
      sender_replicas: unknown
      edge_secret_replicas: unknown
      support_smtp: unknown
  cloudflare:
    observed:
      nameservers:
        - keira.ns.cloudflare.com
        - colin.ns.cloudflare.com
      app_and_mcp_cname: cname.vercel-dns-017.com
      apex_a:
        - 216.150.16.193
        - 216.150.1.193
      inbound_mail: cloudflare_email_routing
      spf_apex: include:_spf.mx.cloudflare.net ~all
      spf_send: include:amazonses.com ~all
      send_mx: feedback-smtp.ap-northeast-1.amazonses.com
      resend_dkim: present
      dmarc:
        policy: none
        rua: mailto:dmarc@dayopt.app
      r2_bucket_head:
        avatars: 200
        attachments: 200
        storage-backup: 404
    verification:
      zone_admin_settings: unavailable_with_existing_token
      turnstile_domains: unknown
      r2_locks: insufficient_access_403
      r2_permissions_and_retention: unknown
      backup_restore_evidence: unknown
  posthog:
    observed:
      project: 625917
      production_switch: disabled
      preview_events: 12
      integration_events_in_window: 0
      production_events_in_window: 0
      query_utc_window:
        - '2026-09-23 00:00:00'
        - '2026-09-30 02:00:00'
      preview_deletion_key_env: absent
    verification:
      project_settings: insufficient_access_403
      public_key_project_match: unknown
      deletion_master_exists: unknown
      deletion_flow: not_executed
  sentry:
    observed:
      product: dayopt
      product_project_id: '4509737836412928'
      web: dayopt-web
      web_project_id: '4511741979394048'
    verification:
      source_map_application: unknown
      privacy_dashboard_settings: unknown
  google:
    observed:
      integration_calendar_client_matches_1password: true
      production_calendar_client_is_distinct: true
    verification:
      registered_callbacks: unknown
      consent_screen_and_test_users: unknown
      project_number_and_refresh_token_key_replicas: unknown
  turnstile:
    observed:
      default_preview_site_key: official_always_pass_test_key
    verification:
      allowed_domains: unknown
      sensitive_product_secret_pair: unknown
  upstash:
    observed:
      master_host: discrete-sloth-103465.upstash.io
      agent_and_human_ping: success
      tokens_distinct: true
      web_production_host_matches: true
    verification:
      product_sensitive_url: not_retrievable
      token_permissions: unknown
  uptime_robot:
    observed:
      url: https://app.dayopt.app/api/health
      interval_seconds: 300
      status: up
    verification:
      notification_routes: unknown
  vercel_browser_telemetry:
    observed: {}
    verification:
      dashboard_enablement_and_ingestion: unknown
  pwned_passwords:
    observed: {}
    verification:
      live_availability: not_checked
  optional:
    observed: {}
    verification: {}
nodes:
  github: Dayopt/dayopt + Actions
  product_prod: Vercel Product / Production
  product_preview: Vercel Product / default Preview
  product_integration: Vercel Product / integration Preview
  web_prod: Vercel Web / Production
  analytics_preview: Product/Web analytics branches
  supabase_main: Supabase yvglwblxrnrenfifsnje
  supabase_integration: Supabase tilwaprottpyhlfoggbb
  supabase_auth: Production Supabase Auth
  auth_edge: Supabase send-auth-email
  resend_api: Resend dayopt.app
  resend_product_endpoint: https://app.dayopt.app/api/webhooks/resend
  resend_web_endpoint: https://dayopt.app/api/webhooks/resend
  stripe_test: Stripe test acct_1TBpLoRRjoh5xfrs
  stripe_live: Stripe live acct_1TBpLgIe9fUk4fJW
  stripe_endpoint: https://product-git-integration-dayopt.vercel.app/api/webhooks/stripe
  dns: Cloudflare dayopt.app
  app_domain: app.dayopt.app
  mcp_domain: mcp.dayopt.app
  web_domain: dayopt.app
  mcp_endpoint: Product /api/mcp
  google_auth: Google Supabase Auth OAuth client
  google_calendar: Google Calendar OAuth client
  calendar_callback: Product /api/integrations/google-calendar/callback
  auth_callback: Supabase /auth/v1/callback
  upstash: Upstash Redis
  posthog: PostHog 625917
  sentry_product: Sentry dayopt
  sentry_web: Sentry dayopt-web
  sentry_edge: Sentry Auth Edge optional
  r2: Cloudflare R2 avatars/attachments
  supabase_storage: Production Supabase Storage
  uptime: UptimeRobot
  health: https://app.dayopt.app/api/health
  cron: Vercel Product cron scheduler
  product_cron: Product cron endpoints
  cf_mail: Cloudflare Email Routing
  support_mailbox: Support mailbox / Gmail
  resend_smtp: Resend support SMTP
  turnstile: Cloudflare Turnstile
  browser: Product/Web browser
  telemetry: Vercel Analytics / Speed Insights
  pwned: Pwned Passwords API
  jev: Developer Jev
  ai_gateway: Vercel AI Gateway
connections:
  - from: github
    to: product_prod
    type: deployment_control
    contract_ref: release
  - from: github
    to: web_prod
    type: deployment_control
    contract_ref: release
  - from: product_prod
    to: supabase_main
    type: api_request
    evidence_ref: api_snapshot
  - from: product_preview
    to: supabase_integration
    type: api_request
    evidence_ref: api_snapshot
  - from: product_integration
    to: supabase_integration
    type: api_request
    evidence_ref: api_snapshot
  - from: product_integration
    to: stripe_test
    type: api_request
    evidence_ref: api_snapshot
  - from: stripe_test
    to: stripe_endpoint
    type: webhook_delivery
    credential_ref: product_bypass
    evidence_ref: api_snapshot
  - from: resend_api
    to: resend_product_endpoint
    type: webhook_delivery
    credential_ref: resend_product_hook
    evidence_ref: api_snapshot
  - from: resend_api
    to: resend_web_endpoint
    type: webhook_delivery
    credential_ref: resend_web_hook
    evidence_ref: api_snapshot
  - from: dns
    to: resend_api
    type: email_dns_auth
    evidence_ref: dns_snapshot
  - from: browser
    to: turnstile
    type: captcha
    verification: domain_and_secret_binding_unknown
  - from: dns
    to: app_domain
    type: dns_resolution
    evidence_ref: dns_snapshot
  - from: dns
    to: mcp_domain
    type: dns_resolution
    evidence_ref: dns_snapshot
  - from: dns
    to: web_domain
    type: dns_resolution
    evidence_ref: dns_snapshot
  - from: app_domain
    to: product_prod
    type: deployment_control
    evidence_ref: api_snapshot
  - from: mcp_domain
    to: product_prod
    type: deployment_control
    evidence_ref: api_snapshot
  - from: web_domain
    to: web_prod
    type: deployment_control
    evidence_ref: api_snapshot
  - from: product_prod
    to: mcp_endpoint
    type: routing
    contract_ref: vercel
  - from: supabase_auth
    to: auth_edge
    type: webhook_delivery
    credential_ref: auth_hook
    contract_ref: auth
  - from: auth_edge
    to: resend_api
    type: api_request
    credential_ref: resend_send
    contract_ref: auth
  - from: product_prod
    to: resend_api
    type: api_request
    credential_ref: resend_send
    evidence_ref: repo
  - from: web_prod
    to: resend_api
    type: api_request
    credential_ref: resend_send
    evidence_ref: repo
  - from: google_auth
    to: auth_callback
    type: oauth_redirect
    verification: unknown
  - from: google_calendar
    to: calendar_callback
    type: oauth_redirect
    verification: unknown
  - from: product_prod
    to: google_calendar
    type: api_request
    credential_ref: calendar_secret
    contract_ref: calendar
  - from: product_prod
    to: upstash
    type: api_request
    verification: sensitive_binding_unknown
  - from: product_preview
    to: upstash
    type: api_request
    verification: sensitive_binding_unknown
  - from: web_prod
    to: upstash
    type: api_request
    evidence_ref: api_snapshot
  - from: analytics_preview
    to: posthog
    type: telemetry_ingestion
    verification: key_project_binding_unknown
  - from: product_prod
    to: sentry_product
    type: telemetry_ingestion
    evidence_ref: api_snapshot
  - from: web_prod
    to: sentry_web
    type: telemetry_ingestion
    evidence_ref: api_snapshot
  - from: auth_edge
    to: sentry_edge
    type: telemetry_ingestion
    verification: optional_unknown
  - from: github
    to: sentry_product
    type: release_control
    credential_ref: sentry_release
    verification: source_map_application_unknown
  - from: github
    to: sentry_web
    type: release_control
    credential_ref: sentry_release
    verification: source_map_application_unknown
  - from: supabase_storage
    to: r2
    type: backup_transfer
    via: github
    contract_ref: backup
  - from: uptime
    to: health
    type: monitoring
    evidence_ref: api_snapshot
  - from: cron
    to: product_cron
    type: scheduled_request
    credential_ref: cron_secret
    contract_ref: vercel
  - from: product_cron
    to: google_calendar
    type: api_request
    contract_ref: calendar
  - from: product_cron
    to: stripe_live
    type: reconciliation
    verification: production_billing_pending_mode_guard_required
  - from: cf_mail
    to: support_mailbox
    type: email_routing
    verification: forwarding_destinations_unknown
  - from: support_mailbox
    to: resend_smtp
    type: smtp_send
    credential_ref: support_smtp
    verification: unknown
  - from: browser
    to: telemetry
    type: telemetry_ingestion
    verification: consent_and_live_ingestion_unknown
  - from: browser
    to: pwned
    type: api_request
    contract_ref: password_check
  - from: jev
    to: ai_gateway
    type: api_request
    credential_ref: ai_gateway
    contract_ref: development_ai
ui_only:
  api_not_provided_confirmed: []
  insufficient_current_access:
    - items:
        - github_hooks
        - github_secrets
      reason: http_403
      alternative: authorized_dashboard
    - items:
        - supabase_backups
      reason: http_403
      alternative: authorized_dashboard
    - items:
        - posthog_project_settings
      reason: http_403
      alternative: authorized_dashboard
    - items:
        - cloudflare_zone_settings
        - turnstile_domains
        - r2_bucket_locks
      reason: existing_token_scope
      alternative: authorized_dashboard
  ui_confirmation_candidates:
    items:
      - google_oauth_callbacks_and_consent
      - gmail_smtp_setup
      - uptime_notification_routes
      - sentry_privacy_settings
      - vercel_telemetry_enablement
    api_exclusivity: not_established
  secret_not_redisplayable:
    items:
      - github_action_secret_values
      - vercel_sensitive_environment_values
      - stripe_existing_webhook_signing_secret
    method: master_reference_and_replica_metadata_or_authorized_consumer_check
  auth_retry_needed:
    items:
      - vercel_project_settings
      - github_ruleset_details
    reason: authorization_timeout
```
