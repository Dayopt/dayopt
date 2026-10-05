'use client';

import { Button, Input, Label, RadioGroup, RadioGroupItem, Textarea } from '@dayopt/components';
import { Link } from '@dayopt/i18n/navigation';
import { zodResolver } from '@hookform/resolvers/zod';
import { Turnstile, isTurnstileEnabled } from '@web/lib/turnstile';
import { CheckCircle } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useRef, useState } from 'react';
import { Controller, useForm, type Resolver } from 'react-hook-form';
import { z } from 'zod';

import { submitContactRequest } from './contact-client';

const CATEGORY_OPTIONS = ['bug', 'feature', 'question', 'other'] as const;

function createContactSchema(t: ReturnType<typeof useTranslations<'marketing.contact'>>) {
  return z.object({
    name: z.string().trim().min(1, t('form.name.required')).max(50, t('form.name.maxLength')),
    email: z
      .string()
      .trim()
      .min(1, t('form.email.invalid'))
      .max(254, t('form.email.invalid'))
      .email(t('form.email.invalid'))
      .refine((value) => !/[\r\n,]/u.test(value), t('form.email.invalid')),
    category: z.enum(CATEGORY_OPTIONS, { error: t('form.category.required') }),
    message: z.string().min(10, t('form.message.minLength')).max(1000, t('form.message.maxLength')),
    website: z.string().max(0).optional(),
  });
}

type ContactFormValues = z.infer<ReturnType<typeof createContactSchema>>;

type SubmissionAttempt = {
  submissionId: string;
  payloadKey: string;
};

function getSubmissionPayloadKey(data: ContactFormValues): string {
  return JSON.stringify([data.name, data.email, data.category, data.message]);
}

/** 必須ラベルコンポーネント（デジタル庁ガイドライン準拠） */
function RequiredBadge() {
  const t = useTranslations('marketing.contact');
  return (
    <span className="text-destructive ml-2 text-sm font-normal">{t('form.requiredBadge')}</span>
  );
}

/** サポートテキストコンポーネント */
function SupportText({ children, id }: { children: React.ReactNode; id: string }) {
  return (
    <p id={id} className="text-muted-foreground text-sm">
      {children}
    </p>
  );
}

/** エラーテキストコンポーネント（デジタル庁ガイドライン準拠: ＊を冒頭に付与） */
function ErrorText({ children, id }: { children: React.ReactNode; id: string }) {
  return (
    <p id={id} className="text-destructive text-sm">
      ＊{children}
    </p>
  );
}

export function ContactForm() {
  const t = useTranslations('marketing.contact');
  const locale = useLocale();
  const [isSubmitted, setIsSubmitted] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [turnstileAttempt, setTurnstileAttempt] = useState(0);
  const submissionAttemptRef = useRef<SubmissionAttempt | null>(null);

  const turnstileEnabled = isTurnstileEnabled();
  const turnstileLocale: 'ja' | 'en' | 'auto' =
    locale === 'ja' ? 'ja' : locale === 'en' ? 'en' : 'auto';

  const contactSchema = createContactSchema(t);

  const {
    register,
    handleSubmit,
    watch,
    reset,
    control,
    formState: { errors, isSubmitting },
  } = useForm<ContactFormValues>({
    // monorepo (pnpm) で apps/product(zod3) と apps/web(zod4) を併存させているため、
    // @hookform/resolvers の zod adapter が strict 隔離下で型解決できない。
    // ランタイムは正常。zod version 統一は follow-up PR で対応する。
    resolver: zodResolver(contactSchema as never) as Resolver<ContactFormValues>,
    defaultValues: {
      name: '',
      email: '',
      message: '',
      website: '',
    },
  });

  const messageValue = watch('message') || '';

  async function onSubmit(data: ContactFormValues) {
    setSubmitError(null);
    const payloadKey = getSubmissionPayloadKey(data);
    const previousAttempt = submissionAttemptRef.current;
    const submissionId =
      previousAttempt?.payloadKey === payloadKey
        ? previousAttempt.submissionId
        : crypto.randomUUID();
    submissionAttemptRef.current = { submissionId, payloadKey };

    try {
      await submitContactRequest({ ...data, submissionId, turnstileToken });
      setIsSubmitted(true);
    } catch {
      setSubmitError(t('form.submitError'));
      setTurnstileToken(null);
      setTurnstileAttempt((attempt) => attempt + 1);
    }
  }

  function handleReset() {
    reset();
    setIsSubmitted(false);
    setSubmitError(null);
    setTurnstileToken(null);
    submissionAttemptRef.current = null;
  }

  if (isSubmitted) {
    return (
      <div className="text-center" role="status" aria-live="polite">
        <div className="bg-muted mx-auto mb-6 flex size-16 items-center justify-center rounded-full">
          <CheckCircle className="text-success size-8" aria-hidden="true" />
        </div>
        <h3 className="text-foreground mb-2 text-xl font-medium">{t('form.success.title')}</h3>
        <p className="text-muted-foreground mb-6">{t('form.success.description')}</p>
        <Button variant="outline" onClick={handleReset}>
          {t('form.success.newMessage')}
        </Button>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-6" noValidate>
      <div className="grid gap-6 sm:grid-cols-2">
        {/* お名前 */}
        <div className="space-y-2">
          <Label htmlFor="name">
            {t('form.name.label')}
            <RequiredBadge />
          </Label>
          <SupportText id="name-support">{t('form.name.support')}</SupportText>
          <Input
            id="name"
            autoComplete="name"
            aria-required="true"
            aria-invalid={!!errors.name}
            aria-describedby={errors.name ? 'name-error name-support' : 'name-support'}
            {...register('name')}
          />
          {errors.name && <ErrorText id="name-error">{errors.name.message}</ErrorText>}
        </div>

        {/* メールアドレス */}
        <div className="space-y-2">
          <Label htmlFor="email">
            {t('form.email.label')}
            <RequiredBadge />
          </Label>
          <SupportText id="email-support">{t('form.email.support')}</SupportText>
          <Input
            id="email"
            type="email"
            autoComplete="email"
            aria-required="true"
            aria-invalid={!!errors.email}
            aria-describedby={errors.email ? 'email-error email-support' : 'email-support'}
            {...register('email')}
          />
          {errors.email && <ErrorText id="email-error">{errors.email.message}</ErrorText>}
        </div>
      </div>

      {/* 問い合わせ種別 */}
      <div className="space-y-2">
        <Label>
          {t('form.category.label')}
          <RequiredBadge />
        </Label>
        <SupportText id="category-support">{t('form.category.support')}</SupportText>
        <Controller
          name="category"
          control={control}
          render={({ field }) => (
            <RadioGroup
              onValueChange={field.onChange}
              value={field.value}
              aria-required="true"
              aria-invalid={!!errors.category}
              aria-describedby={
                errors.category ? 'category-error category-support' : 'category-support'
              }
              className="grid grid-cols-2 gap-4"
            >
              {CATEGORY_OPTIONS.map((option) => (
                <div key={option} className="flex items-center gap-2">
                  <RadioGroupItem value={option} id={`category-${option}`} />
                  <Label htmlFor={`category-${option}`} className="font-normal">
                    {t(`form.category.options.${option}`)}
                  </Label>
                </div>
              ))}
            </RadioGroup>
          )}
        />
        {errors.category && <ErrorText id="category-error">{errors.category.message}</ErrorText>}
      </div>

      {/* Honeypot（bot対策・非表示フィールド） */}
      <div className="absolute -left-[9999px]" aria-hidden="true">
        <label htmlFor="website">Website</label>
        <input id="website" type="text" tabIndex={-1} autoComplete="off" {...register('website')} />
      </div>

      {/* メッセージ */}
      <div className="space-y-2">
        <Label htmlFor="message">
          {t('form.message.label')}
          <RequiredBadge />
        </Label>
        <SupportText id="message-support">{t('form.message.support')}</SupportText>
        <Textarea
          id="message"
          className="min-h-[150px] resize-none"
          aria-required="true"
          aria-invalid={!!errors.message}
          aria-describedby={errors.message ? 'message-error message-support' : 'message-support'}
          {...register('message')}
        />
        <div className="flex items-center justify-between">
          {errors.message && <ErrorText id="message-error">{errors.message.message}</ErrorText>}
          <span className="text-muted-foreground ml-auto text-xs" aria-live="polite">
            {messageValue.length}/1000 {t('form.message.charCount')}
          </span>
        </div>
      </div>

      {/* Cloudflare Turnstile（bot検証） */}
      {turnstileEnabled && (
        <div className="flex justify-center">
          <Turnstile
            key={turnstileAttempt}
            onSuccess={(token) => setTurnstileToken(token)}
            onError={() => setTurnstileToken(null)}
            onExpire={() => setTurnstileToken(null)}
            locale={turnstileLocale}
          />
        </div>
      )}

      {/* 送信エラー */}
      {submitError && (
        <div className="bg-muted text-destructive rounded-lg p-4 text-sm" role="alert">
          ＊{submitError}
        </div>
      )}

      {/* 送信ボタン */}
      <div className="flex flex-col gap-4">
        <Button
          type="submit"
          size="lg"
          className="w-full"
          disabled={isSubmitting || (turnstileEnabled && !turnstileToken)}
          aria-busy={isSubmitting}
        >
          {isSubmitting ? t('form.submitting') : t('form.submit')}
        </Button>

        <p className="text-muted-foreground text-center text-xs">
          {t('form.privacyNotice')}{' '}
          <Link href="/legal/privacy" className="text-primary hover:underline">
            {t('form.privacyLink')}
          </Link>
        </p>
      </div>
    </form>
  );
}
