import { captureUnexpectedError } from '@/lib/sentry';
import { toast } from '@/lib/toast';

/** Checkout 復帰後も契約状態が反映されなかったことを利用者と運用へ同時に伝える。 */
export function reportBillingReturnPollTimeout(message: string): void {
  toast.error(message);
  captureUnexpectedError(new Error('Billing return poll timed out'), {
    feature: 'billing',
    operation: 'billing_return_poll_timeout',
    source: 'stripe_checkout',
  });
}
