import { dayoptProductUrls } from '@dayopt/config';

/** Keep preview onboarding on its matching Product deployment. */
export function productSignupUrl(
  productOrigin: string | undefined = process.env.NEXT_PUBLIC_PRODUCT_ORIGIN,
): string {
  if (!productOrigin) return dayoptProductUrls.signup;

  const url = new URL(productOrigin);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new Error('NEXT_PUBLIC_PRODUCT_ORIGIN must be an HTTPS origin');
  }

  return `${url.origin}/auth/signup`;
}

/** Login uses the same Product origin as registration. */
export function productLoginUrl(productOrigin?: string): string {
  return new URL('/auth/login', productSignupUrl(productOrigin)).href;
}
