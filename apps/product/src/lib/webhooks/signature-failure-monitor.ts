import { captureUnexpectedError } from '@/lib/sentry';

const SIGNATURE_FAILURE_CAPTURE_WINDOW_MS = 60_000;

const lastCaptureAtBySource = new Map<string, number>();

interface CaptureWebhookSignatureFailureParams {
  feature: string;
  route: string;
  source: string;
  now?: number;
}

/**
 * Webhook 署名エラーを source ごとに 60 秒に 1 回だけ通知する。
 *
 * 署名・header・payload・provider の例外は Sentry へ渡さず、設定不整合を診断するための
 * 固定 context だけを記録する。外部から無効 request を連打されても通知を増幅しない。
 */
export function captureWebhookSignatureFailure({
  feature,
  route,
  source,
  now = Date.now(),
}: CaptureWebhookSignatureFailureParams): void {
  const lastCaptureAt = lastCaptureAtBySource.get(source);
  if (lastCaptureAt !== undefined && now - lastCaptureAt < SIGNATURE_FAILURE_CAPTURE_WINDOW_MS) {
    return;
  }

  lastCaptureAtBySource.set(source, now);
  captureUnexpectedError(new Error('Webhook signature verification failed'), {
    feature,
    operation: 'signature_verification',
    route,
    source,
  });
}

export function resetWebhookSignatureFailureCaptureForTestsOnly(): void {
  lastCaptureAtBySource.clear();
}
