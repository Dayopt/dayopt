import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  loggerError: vi.fn(),
}));

vi.mock('@/lib/logger', () => ({
  logger: {
    log: vi.fn(),
    error: mocks.loggerError,
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

async function importService(envOverrides: Record<string, string> = {}) {
  vi.resetModules();
  vi.stubEnv('VERCEL_ENV', envOverrides.VERCEL_ENV ?? 'production');
  vi.stubEnv('RESEND_API_KEY', envOverrides.RESEND_API_KEY ?? 'resend-test-key');
  vi.stubEnv('RESEND_FROM_EMAIL', envOverrides.RESEND_FROM_EMAIL ?? 'noreply@dayopt.app');
  return import('./contact-service');
}

const defaultParams = {
  userEmail: 'test@example.com',
  userName: 'Test User',
  input: {
    submissionId: '550e8400-e29b-41d4-a716-446655440000',
    category: 'bug' as const,
    message: 'Something is broken',
    environment: {
      appVersion: '0.19.0',
      os: 'macOS 15.0',
      browser: 'Chrome 120.0',
      timezone: 'Asia/Tokyo',
      language: 'ja',
    },
  },
};

describe('sendContactEmail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.fetch.mockImplementation(async () => Response.json({ id: 'email-1' }));
    vi.stubGlobal('fetch', mocks.fetch);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('sends a fixed-header plain-text Product contact email', async () => {
    const { sendContactEmail } = await importService();

    await sendContactEmail(defaultParams);

    expect(mocks.fetch).toHaveBeenCalledOnce();
    const [url, request] = mocks.fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.resend.com/emails');
    expect(request).toMatchObject({
      method: 'POST',
      headers: {
        Authorization: 'Bearer resend-test-key',
        'Content-Type': 'application/json',
        'Idempotency-Key': 'contact-product-550e8400-e29b-41d4-a716-446655440000',
      },
      signal: expect.any(AbortSignal),
    });
    const body = JSON.parse(String(request.body)) as Record<string, unknown>;
    expect(body).toEqual({
      from: 'Dayopt Contact <noreply@dayopt.app>',
      to: ['support@dayopt.app'],
      reply_to: 'test@example.com',
      subject: '[Dayopt Contact][Product][Bug]',
      text: [
        'Authenticated submission from the Dayopt Product contact form.',
        '',
        'Category: Bug',
        'Name: Test User',
        'Email: test@example.com',
        '',
        'Environment:',
        '- App Version: 0.19.0',
        '- OS: macOS 15.0',
        '- Browser: Chrome 120.0',
        '- Timezone: Asia/Tokyo',
        '- Language: ja',
        '',
        'Message:',
        'Something is broken',
      ].join('\n'),
      tags: [
        { name: 'source', value: 'contact-product' },
        { name: 'category', value: 'bug' },
      ],
    });
    expect(body).not.toHaveProperty('html');
    expect(body).not.toHaveProperty('headers');
    expect(body).not.toHaveProperty('attachments');
  });

  it('accepts another sender on the verified apex Dayopt domain', async () => {
    const { sendContactEmail } = await importService({
      RESEND_FROM_EMAIL: 'contact-sender@dayopt.app',
    });

    await sendContactEmail(defaultParams);

    const request = mocks.fetch.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(request.body)) as { from: string };
    expect(body.from).toBe('Dayopt Contact <contact-sender@dayopt.app>');
  });

  it.each(['preview', 'development', ''])(
    'refuses delivery outside Vercel Production even when credentials exist (%s)',
    async (vercelEnv) => {
      const { sendContactEmail } = await importService({ VERCEL_ENV: vercelEnv });

      await expect(sendContactEmail(defaultParams)).rejects.toMatchObject({
        code: 'CONTACT_DELIVERY_FAILED',
        message: 'Contact email delivery is available only in Production',
      });
      expect(mocks.fetch).not.toHaveBeenCalled();
    },
  );

  it.each([
    { RESEND_API_KEY: '', RESEND_FROM_EMAIL: 'noreply@dayopt.app' },
    { RESEND_API_KEY: 'resend-test-key', RESEND_FROM_EMAIL: '' },
    { RESEND_API_KEY: 'resend-test-key', RESEND_FROM_EMAIL: 'onboarding@resend.dev' },
    { RESEND_API_KEY: 'resend-test-key', RESEND_FROM_EMAIL: 'sender@example.com' },
    { RESEND_API_KEY: 'resend-test-key', RESEND_FROM_EMAIL: 'sender@notdayopt.app' },
    { RESEND_API_KEY: 'resend-test-key', RESEND_FROM_EMAIL: 'sender@dayopt.app.example.com' },
    { RESEND_API_KEY: 'resend-test-key', RESEND_FROM_EMAIL: 'noreply@send.dayopt.app' },
  ])('fails closed when email configuration is invalid', async (envOverrides) => {
    const { sendContactEmail } = await importService(envOverrides);

    await expect(sendContactEmail(defaultParams)).rejects.toMatchObject({
      code: 'CONTACT_DELIVERY_FAILED',
      message: 'Contact email configuration is missing or invalid',
    });
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('rejects a reply address that could add another recipient', async () => {
    const { sendContactEmail } = await importService();

    await expect(
      sendContactEmail({ ...defaultParams, userEmail: 'a@example.com,b@example.com' }),
    ).rejects.toMatchObject({
      code: 'CONTACT_DELIVERY_FAILED',
      message: 'Contact email reply address is invalid',
    });
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('maps every category to a fixed non-PII subject', async () => {
    const { sendContactEmail } = await importService();
    const categories = [
      ['bug', 'Bug'],
      ['feature', 'Feature'],
      ['question', 'Question'],
      ['other', 'Other'],
    ] as const;

    for (const [category, label] of categories) {
      await sendContactEmail({
        ...defaultParams,
        input: { ...defaultParams.input, category },
      });
      const request = mocks.fetch.mock.calls.at(-1)?.[1] as RequestInit | undefined;
      const body = JSON.parse(String(request?.body)) as { subject: string };
      expect(body.subject).toBe(`[Dayopt Contact][Product][${label}]`);
    }
  });

  it('normalizes a provider-returned error without retaining its body', async () => {
    const { sendContactEmail } = await importService();
    mocks.fetch.mockResolvedValue(
      Response.json(
        { message: `provider echoed ${defaultParams.userEmail} ${defaultParams.input.message}` },
        { status: 422 },
      ),
    );

    const error = await sendContactEmail(defaultParams).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: 'CONTACT_DELIVERY_FAILED',
      message: 'Contact email provider returned an unsuccessful response',
    });
    expect(JSON.stringify(error)).not.toContain(defaultParams.userEmail);
    expect(JSON.stringify(error)).not.toContain(defaultParams.input.message);
  });

  it('rejects a malformed successful provider response without an email ID', async () => {
    const { sendContactEmail } = await importService();
    mocks.fetch.mockResolvedValue(Response.json({ unexpected: true }));

    await expect(sendContactEmail(defaultParams)).rejects.toMatchObject({
      code: 'CONTACT_DELIVERY_FAILED',
      message: 'Contact email provider returned an unsuccessful response',
    });
  });

  it('retains a safe SyntaxError cause for invalid provider JSON without response PII', async () => {
    const privateResponse = `private ${defaultParams.userEmail} ${defaultParams.input.message}`;
    const { sendContactEmail } = await importService();
    mocks.fetch.mockResolvedValue(
      new Response(privateResponse, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const error = await sendContactEmail(defaultParams).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: 'CONTACT_DELIVERY_FAILED',
      message: 'Contact email provider returned an unsuccessful response',
      cause: expect.objectContaining({
        name: 'SyntaxError',
        message: 'Contact email provider returned invalid JSON',
      }),
    });
    const serializedError = `${String(error)}\n${String((error as Error).cause)}\n${
      (error as Error).cause instanceof Error ? ((error as Error).cause as Error).stack : ''
    }`;
    expect(serializedError).not.toContain(defaultParams.userEmail);
    expect(serializedError).not.toContain(defaultParams.input.message);
    expect(serializedError).not.toContain(privateResponse);
  });

  it('stops waiting after ten seconds while retaining the idempotency key for retry', async () => {
    vi.useFakeTimers();
    const { sendContactEmail } = await importService();
    mocks.fetch.mockImplementation(
      (_url: unknown, options: RequestInit) =>
        new Promise((_resolve, reject) => {
          if (!(options.signal instanceof AbortSignal)) throw new Error('Missing abort signal');
          options.signal.addEventListener(
            'abort',
            () => reject(new DOMException('The operation was aborted', 'AbortError')),
            { once: true },
          );
        }),
    );

    const delivery = sendContactEmail(defaultParams);
    const assertion = expect(delivery).rejects.toThrow('Contact email delivery timed out');
    await vi.advanceTimersByTimeAsync(10_000);

    await assertion;
    const request = mocks.fetch.mock.calls[0]?.[1] as RequestInit;
    expect(request.headers).toMatchObject({
      'Idempotency-Key': 'contact-product-550e8400-e29b-41d4-a716-446655440000',
    });
    expect(request.signal).toBeInstanceOf(AbortSignal);
    expect(request.signal?.aborted).toBe(true);
  });

  it('also aborts when response headers arrive but the response body stalls', async () => {
    vi.useFakeTimers();
    const { sendContactEmail } = await importService();
    mocks.fetch.mockImplementation(async (_url: unknown, options: RequestInit) => {
      if (!(options.signal instanceof AbortSignal)) throw new Error('Missing abort signal');
      return {
        ok: true,
        json: () =>
          new Promise((_resolve, reject) => {
            options.signal?.addEventListener(
              'abort',
              () => reject(new DOMException('The operation was aborted', 'AbortError')),
              { once: true },
            );
          }),
      } as Response;
    });

    const delivery = sendContactEmail(defaultParams);
    const assertion = expect(delivery).rejects.toThrow('Contact email delivery timed out');
    await vi.advanceTimersByTimeAsync(10_000);

    await assertion;
  });

  it('preserves a thrown transport Error for the tRPC adapter capture', async () => {
    const { sendContactEmail } = await importService();
    const original = new TypeError('fetch failed');
    mocks.fetch.mockRejectedValue(original);

    await expect(sendContactEmail(defaultParams)).rejects.toBe(original);
  });
});

describe('deliverContactFeedback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.fetch.mockImplementation(async () => Response.json({ id: 'email-1' }));
    vi.stubGlobal('fetch', mocks.fetch);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('returns only the stable delivery result on success', async () => {
    const { deliverContactFeedback } = await importService();

    await expect(deliverContactFeedback(defaultParams)).resolves.toEqual({ delivered: true });
    expect(mocks.loggerError).not.toHaveBeenCalled();
  });

  it('logs only technical context and rethrows the original transport Error', async () => {
    const { deliverContactFeedback } = await importService();
    const original = new TypeError('fetch failed');
    mocks.fetch.mockRejectedValue(original);

    await expect(deliverContactFeedback(defaultParams)).rejects.toBe(original);

    expect(mocks.loggerError).toHaveBeenCalledWith('Contact feedback email delivery failed', {
      category: 'bug',
      errorType: 'TypeError',
    });
    expect(JSON.stringify(mocks.loggerError.mock.calls)).not.toContain(defaultParams.userEmail);
    expect(JSON.stringify(mocks.loggerError.mock.calls)).not.toContain(defaultParams.input.message);
    expect(JSON.stringify(mocks.loggerError.mock.calls)).not.toContain(defaultParams.userName);
  });

  it('leaves the tRPC adapter as the single Sentry report boundary', async () => {
    const { deliverContactFeedback } = await importService({
      RESEND_API_KEY: '',
      RESEND_FROM_EMAIL: '',
    });

    await expect(deliverContactFeedback(defaultParams)).rejects.toMatchObject({
      code: 'CONTACT_DELIVERY_FAILED',
    });
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.loggerError).toHaveBeenCalledOnce();
  });
});
