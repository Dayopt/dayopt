import 'server-only';

/**
 * Product contact delivery.
 *
 * Contact PII exists only in the Resend payload and the support mailbox. Logs and
 * Sentry receive technical context only.
 */

import { dayoptContact, dayoptContactDeliverySources } from '@dayopt/config';
import { z } from 'zod';

import { env } from '@/env';
import { logger } from '@/lib/logger';
import { ServiceError } from '@/lib/trpc/errors';

import type { ContactCategory, ContactFormInput } from '../types';

const RESEND_API_KEY = env.RESEND_API_KEY;
const RESEND_FROM_EMAIL = env.RESEND_FROM_EMAIL;
const VERCEL_ENV = env.VERCEL_ENV;
const CONTACT_EMAIL_TIMEOUT_MS = 10_000;
const RESEND_EMAILS_ENDPOINT = 'https://api.resend.com/emails';

const categoryLabels: Record<ContactCategory, string> = {
  bug: 'Bug',
  feature: 'Feature',
  question: 'Question',
  other: 'Other',
};

const emailAddressSchema = z
  .string()
  .trim()
  .max(254)
  .email()
  .refine((value) => !/[\r\n,]/u.test(value));
const senderEmailSchema = emailAddressSchema.refine((value) => {
  const normalized = value.toLowerCase();
  const domain = normalized.slice(normalized.lastIndexOf('@') + 1);
  return domain === 'dayopt.app';
});
const resendSuccessSchema = z.object({ id: z.string().min(1) });

interface ContactEmailParams {
  userEmail: string;
  userName: string;
  input: ContactFormInput;
}

export type DeliverContactFeedbackResult = {
  delivered: true;
};

function getEmailConfiguration(): { apiKey: string; from: string } {
  if (VERCEL_ENV !== 'production') {
    throw new ServiceError(
      'CONTACT_DELIVERY_FAILED',
      'Contact email delivery is available only in Production',
    );
  }

  const apiKey = RESEND_API_KEY?.trim();
  const fromResult = senderEmailSchema.safeParse(RESEND_FROM_EMAIL);

  if (!apiKey || !fromResult.success || fromResult.data === 'onboarding@resend.dev') {
    throw new ServiceError(
      'CONTACT_DELIVERY_FAILED',
      'Contact email configuration is missing or invalid',
    );
  }

  return { apiKey, from: fromResult.data };
}

/** Send one authenticated Product contact submission through Resend. */
export async function sendContactEmail(params: ContactEmailParams): Promise<void> {
  const { apiKey, from } = getEmailConfiguration();
  const replyToResult = emailAddressSchema.safeParse(params.userEmail);
  if (!replyToResult.success) {
    throw new ServiceError('CONTACT_DELIVERY_FAILED', 'Contact email reply address is invalid');
  }

  const { userName, input } = params;
  const categoryLabel = categoryLabels[input.category];
  const environment = input.environment;
  const text = [
    'Authenticated submission from the Dayopt Product contact form.',
    '',
    `Category: ${categoryLabel}`,
    `Name: ${userName}`,
    `Email: ${replyToResult.data}`,
    '',
    'Environment:',
    `- App Version: ${environment.appVersion}`,
    `- OS: ${environment.os}`,
    `- Browser: ${environment.browser}`,
    `- Timezone: ${environment.timezone}`,
    `- Language: ${environment.language}`,
    '',
    'Message:',
    input.message,
  ].join('\n');

  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), CONTACT_EMAIL_TIMEOUT_MS);

  try {
    const response = await fetch(RESEND_EMAILS_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': `contact-product-${input.submissionId}`,
      },
      body: JSON.stringify({
        from: `Dayopt Contact <${from}>`,
        to: [dayoptContact.supportEmail],
        reply_to: replyToResult.data,
        subject: `[Dayopt Contact][Product][${categoryLabel}]`,
        text,
        tags: [
          { name: 'source', value: dayoptContactDeliverySources.product },
          { name: 'category', value: input.category },
        ],
      }),
      signal: abortController.signal,
    });

    if (abortController.signal.aborted) {
      throw new Error('Contact email delivery timed out');
    }

    if (!response.ok) {
      throw new ServiceError(
        'CONTACT_DELIVERY_FAILED',
        'Contact email provider returned an unsuccessful response',
      );
    }

    let responseBody: unknown;
    let responseParseError: SyntaxError | undefined;
    try {
      responseBody = await response.json();
    } catch (error) {
      if (abortController.signal.aborted) throw error;
      responseParseError = new SyntaxError('Contact email provider returned invalid JSON');
      responseBody = null;
    }

    if (abortController.signal.aborted || !resendSuccessSchema.safeParse(responseBody).success) {
      if (abortController.signal.aborted) {
        throw new Error('Contact email delivery timed out');
      }
      throw new ServiceError(
        'CONTACT_DELIVERY_FAILED',
        'Contact email provider returned an unsuccessful response',
        responseParseError ? { cause: responseParseError } : undefined,
      );
    }
  } catch (error) {
    if (abortController.signal.aborted) {
      throw new Error('Contact email delivery timed out');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

/** Deliver feedback while keeping failures retryable at the tRPC boundary. */
export async function deliverContactFeedback(
  params: ContactEmailParams,
): Promise<DeliverContactFeedbackResult> {
  try {
    await sendContactEmail(params);
    return { delivered: true };
  } catch (error) {
    const originalError =
      error instanceof Error ? error : new Error('Unknown contact delivery failure');

    logger.error('Contact feedback email delivery failed', {
      category: params.input.category,
      errorType: originalError.name,
    });

    throw originalError;
  }
}
