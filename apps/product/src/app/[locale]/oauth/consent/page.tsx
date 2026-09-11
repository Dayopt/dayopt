import type { Metadata } from 'next';

import { getTranslations } from 'next-intl/server';

import type { ScopedMessageKey } from '@/lib/i18n';
import {
  createOAuthDbClient,
  hasWriteScope,
  isConsentWriteEnabled,
  resolveGrantableScopes,
  validateAuthorizeInput,
  type AuthorizeValidationError,
  type SupportedScope,
} from '@/lib/oauth-server';
import { assertOAuthAuthorizationRequestHost } from '@/lib/oauth-server/authorization-request-host';
import { observeAuthOperation } from '@/lib/sentry';
import { createClient } from '@/lib/supabase/server';
import { Button } from '@dayopt/components';

import { OAuthErrorPanel } from '../_components/OAuthErrorPanel';
import { processConsent } from './actions';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('oauth.consent');
  return { title: t('pageTitle') };
}

interface ConsentPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const ERROR_MESSAGE_KEY: Record<AuthorizeValidationError, ScopedMessageKey<'oauth.error'>> = {
  unsupported_response_type: 'unsupportedResponseType',
  invalid_client: 'invalidClient',
  invalid_redirect_uri: 'invalidRedirectUri',
  missing_pkce: 'missingPkce',
  invalid_scope: 'invalidScope',
  invalid_resource: 'invalidResource',
};

export default async function ConsentPage({ searchParams }: ConsentPageProps) {
  await assertOAuthAuthorizationRequestHost();

  const params = await searchParams;
  const stringParam = (key: string): string | undefined => {
    const v = params[key];
    return typeof v === 'string' ? v : undefined;
  };

  // Defense in depth: re-validate even though /oauth/authorize already validated
  const validation = validateAuthorizeInput({
    response_type: 'code',
    client_id: stringParam('client_id'),
    redirect_uri: stringParam('redirect_uri'),
    code_challenge: stringParam('code_challenge'),
    code_challenge_method: 'S256',
    scope: stringParam('scope'),
    state: stringParam('state'),
    resource: stringParam('resource'),
  });

  if (!validation.ok) {
    const tError = await getTranslations('oauth.error');
    return <OAuthErrorPanel message={tError(ERROR_MESSAGE_KEY[validation.error])} />;
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await observeAuthOperation('oauth_consent_get_user', () => supabase.auth.getUser());

  const t = await getTranslations('oauth.consent');
  const clientName = validation.client.displayName;

  // 広告は全 scope なので client は write も要求してくる。実際に付与するのは
  // runtime gate が開いている client だけで、閉じていれば read へ降格する
  // （actions.ts 側でも同じ計算を再実行する。hidden field は信用しない）。
  const grantableScopes = resolveGrantableScopes(
    validation.scopes,
    await isConsentWriteEnabled(createOAuthDbClient(), validation.client.id),
  );
  const writeDowngraded = hasWriteScope(validation.scopes) && !hasWriteScope(grantableScopes);

  return (
    <div className="bg-card border-border-subtle w-full max-w-md rounded-lg border p-6 shadow-sm">
      <h1 className="text-foreground mb-2 text-lg font-medium">{t('heading', { clientName })}</h1>
      <p className="text-muted-foreground mb-6 text-sm leading-relaxed">
        {t('description', { clientName })}
      </p>

      <div className="border-border-subtle mb-4 rounded-lg border p-4">
        <p className="text-muted-foreground mb-2 text-xs font-medium tracking-wide uppercase">
          {t('scopesLabel')}
        </p>
        <ul className="text-foreground space-y-1 text-sm">
          {grantableScopes.map((scope) => (
            <li key={scope}>• {scopeLabel(t, scope)}</li>
          ))}
        </ul>
      </div>

      <p className="text-muted-foreground mb-6 text-xs leading-relaxed">
        {hasWriteScope(grantableScopes)
          ? t('writeNotice', { clientName })
          : writeDowngraded
            ? t('writeUnavailableNotice', { clientName })
            : t('readOnlyNotice', { clientName })}
      </p>

      {user?.email && (
        <p className="text-muted-foreground mb-4 text-xs">
          {t('userLabel', { email: user.email })}
        </p>
      )}

      <form action={processConsent} className="flex gap-2">
        <input type="hidden" name="client_id" value={validation.client.id} />
        <input type="hidden" name="redirect_uri" value={validation.redirectUri} />
        <input type="hidden" name="code_challenge" value={validation.codeChallenge} />
        <input type="hidden" name="scope" value={grantableScopes.join(' ')} />
        <input type="hidden" name="resource" value={validation.resourceUri} />
        {validation.state && <input type="hidden" name="state" value={validation.state} />}

        <Button type="submit" name="decision" value="deny" variant="outline" className="flex-1">
          {t('deny')}
        </Button>
        <Button type="submit" name="decision" value="approve" className="flex-1">
          {t('approve')}
        </Button>
      </form>
    </div>
  );
}

function scopeLabel(
  t: Awaited<ReturnType<typeof getTranslations<'oauth.consent'>>>,
  scope: SupportedScope,
): string {
  return t(`scope.${scope}`);
}
