const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const SEED_USER_ID = '00000000-0000-0000-0000-000000000001';
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

const CLOUD_PREFIXES = {
  'critical-path': 'E2E_PREVIEW_DESKTOP_USER_ID',
  'mobile-critical-path': 'E2E_PREVIEW_MOBILE_USER_ID',
} as const;

type PreviewCloudIdentityEnvironment = Readonly<Record<string, string | undefined>>;

function invalidCloudIdentity(): never {
  throw new Error('Preview Cloud identity configuration is invalid');
}

function isUsableUserId(value: string | undefined): value is string {
  return (
    typeof value === 'string' && UUID.test(value) && value !== SEED_USER_ID && value !== NIL_UUID
  );
}

/**
 * Resolve the predeclared Auth user ID for the two Cloud critical-path fixtures.
 * Local runs return undefined so the existing random-ID behavior remains unchanged.
 */
export function resolvePreviewCloudUserId(
  prefix: string,
  env: PreviewCloudIdentityEnvironment = process.env,
): string | undefined {
  const cloudIntent = env.E2E_PREVIEW_CLOUD_INTENT;
  if (cloudIntent === undefined || cloudIntent === '' || cloudIntent === '0') return undefined;
  if (cloudIntent !== '1') return invalidCloudIdentity();

  const selectedIdName = Object.hasOwn(CLOUD_PREFIXES, prefix)
    ? CLOUD_PREFIXES[prefix as keyof typeof CLOUD_PREFIXES]
    : undefined;
  const runId = env.E2E_PREVIEW_RUN_ID;
  const desktopId = env.E2E_PREVIEW_DESKTOP_USER_ID;
  const mobileId = env.E2E_PREVIEW_MOBILE_USER_ID;
  if (
    !selectedIdName ||
    !runId ||
    !UUID.test(runId) ||
    !isUsableUserId(desktopId) ||
    !isUsableUserId(mobileId) ||
    desktopId.toLowerCase() === mobileId.toLowerCase()
  ) {
    return invalidCloudIdentity();
  }

  return env[selectedIdName]!.toLowerCase();
}
