/** Safe public error code; no dependency on server-only error classes. */
export function isBillingAccessEndedError(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('data' in error)) return false;
  const data = error.data;
  return (
    !!data &&
    typeof data === 'object' &&
    'serviceCode' in data &&
    data.serviceCode === 'BILLING_ACCESS_ENDED'
  );
}
