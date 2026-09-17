import { dayoptPlans, dayoptPricing } from '@dayopt/billing';
import { Button } from '@dayopt/components';
import { dayoptProductUrls } from '@dayopt/config';
import { Link } from '@dayopt/i18n/navigation';
import { getTranslations } from 'next-intl/server';

import { CalendarDemo, ClosingMark, HeroJourney, TemplateDemo } from './LandingInteractions';
import styles from './LandingPage.module.css';

interface LandingPageProps {
  locale: string;
}

function SectionTitle({
  number,
  kicker,
  first,
  second,
  id,
}: {
  number: string;
  kicker: string;
  first: string;
  second: string;
  id: string;
}) {
  return (
    <div className={styles.sectionTitle}>
      <p className={styles.kicker}>
        <span>{number}</span>
        {kicker}
      </p>
      <h2 id={id}>
        {first}
        <br />
        {second}
      </h2>
    </div>
  );
}

export async function LandingPage({ locale }: LandingPageProps) {
  const t = await getTranslations({ locale, namespace: 'marketing' });
  const freeFeatures = t.raw('pricing.plans.free.features') as string[];
  const proHighlights = t.raw('pricing.plans.pro.highlights') as string[];
  const signup = dayoptProductUrls.signup;

  return (
    <div className={styles.landing} data-locale={locale}>
      <section className={styles.hero} aria-labelledby="landing-title">
        <div className={styles.heroIntro}>
          <h1 id="landing-title">
            {t('landing.hero.title1')}
            <br />
            <span>{t('landing.hero.title2')}</span>
          </h1>
          <p>
            {t('landing.hero.body1')}
            <br /> {t('landing.hero.body2')}
          </p>
          <div className={styles.heroActions}>
            <Button variant="primary" size="lg" asChild>
              <a href={signup}>
                {t('landing.hero.cta')} <span aria-hidden="true">↗</span>
              </a>
            </Button>
            <a className={styles.textLink} href="#calendar-preview">
              {t('landing.hero.demo')} <span aria-hidden="true">↓</span>
            </a>
          </div>
        </div>
        <HeroJourney
          copy={{
            label: t('landing.hero.journeyLabel'),
            first: t('landing.hero.first'),
            next: t('landing.hero.next'),
            later: t('landing.hero.later'),
            reading: t('landing.hero.reading'),
            minuteUnit: t('landing.hero.minuteUnit'),
            firstThought: t('landing.hero.firstThought'),
            nextThought: t('landing.hero.nextThought'),
            completion1: t('landing.hero.completion1'),
            completion2: t('landing.hero.completion2'),
            plan: t('landing.hero.plan'),
            record: t('landing.hero.record'),
            replay: t('landing.hero.replay'),
          }}
        />
      </section>

      <section className={styles.section} id="calendar-preview" aria-labelledby="calendar-title">
        <div className={styles.content}>
          <div className={styles.sectionLead}>
            <SectionTitle
              number="01"
              kicker={t('landing.calendar.kicker')}
              first={t('landing.calendar.title1')}
              second={t('landing.calendar.title2')}
              id="calendar-title"
            />
            <p>
              {t('landing.calendar.body1')}
              <br />
              {t('landing.calendar.body2')}
            </p>
          </div>
          <CalendarDemo
            copy={{
              controlsLabel: t('landing.calendar.controlsLabel'),
              stepPlan: t('landing.calendar.stepPlan'),
              stepRecord: t('landing.calendar.stepRecord'),
              stepNext: t('landing.calendar.stepNext'),
              figureLabel: t('landing.calendar.figureLabel'),
              sample: t('landing.calendar.sample'),
              dateFirst: t('landing.calendar.dateFirst'),
              dateNext: t('landing.calendar.dateNext'),
              weekdayFirst: t('landing.calendar.weekdayFirst'),
              weekdayNext: t('landing.calendar.weekdayNext'),
              learning: t('landing.calendar.learning'),
              work: t('landing.calendar.work'),
              life: t('landing.calendar.life'),
              reading: t('landing.calendar.reading'),
              language: t('landing.calendar.language'),
              development: t('landing.calendar.development'),
              meeting: t('landing.calendar.meeting'),
              walking: t('landing.calendar.walking'),
              minuteUnit: t('landing.hero.minuteUnit'),
              template: t('landing.calendar.template'),
              templateName: t('landing.calendar.templateName'),
              insightPlan1: t('landing.calendar.insightPlan1'),
              insightPlan2: t('landing.calendar.insightPlan2'),
              insightPlanCopy: t('landing.calendar.insightPlanCopy'),
              insightRecord1: t('landing.calendar.insightRecord1'),
              insightRecord2: t('landing.calendar.insightRecord2'),
              insightRecordCopy: t('landing.calendar.insightRecordCopy'),
              insightNext1: t('landing.calendar.insightNext1'),
              insightNext2: t('landing.calendar.insightNext2'),
              insightNextCopy: t('landing.calendar.insightNextCopy'),
              plan: t('landing.hero.plan'),
              record: t('landing.hero.record'),
              recordPending: t('landing.calendar.recordPending'),
              recordPrevious: t('landing.calendar.recordPrevious'),
              sameTimeline: t('landing.calendar.sameTimeline'),
            }}
          />
          <div className={styles.sectionLinks}>
            <Link href="/docs/plan/calendar">
              {t('landing.calendar.guide')} <span aria-hidden="true">↗</span>
            </Link>
            <a href="#google-calendar">
              {t('landing.calendar.google')} <span aria-hidden="true">↗</span>
            </a>
          </div>
        </div>
      </section>

      <section className={styles.section} id="activities" aria-labelledby="activities-title">
        <div className={styles.content}>
          <div className={styles.sectionLead}>
            <SectionTitle
              number="02"
              kicker={t('landing.activities.kicker')}
              first={t('landing.activities.title1')}
              second={t('landing.activities.title2')}
              id="activities-title"
            />
            <p>{t('landing.activities.body')}</p>
          </div>
          <div className={styles.activityLibrary} aria-label={t('landing.activities.exampleLabel')}>
            {[
              {
                name: t('landing.activities.learning'),
                kind: 'blue',
                items: [t('landing.activities.reading'), t('landing.activities.language')],
              },
              {
                name: t('landing.activities.work'),
                kind: 'indigo',
                items: [t('landing.activities.development'), t('landing.activities.meeting')],
              },
              {
                name: t('landing.activities.life'),
                kind: 'amber',
                items: [t('landing.activities.walking'), t('landing.activities.cooking')],
              },
            ].map((group) => (
              <div className={styles.activityGroup} key={group.kind}>
                <p>
                  <i data-kind={group.kind} aria-hidden="true" />
                  {group.name} <small>{t('landing.activities.category')}</small>
                </p>
                <ul>
                  {group.items.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
          <div className={styles.activityFoot}>
            <p>
              {t('landing.activities.foot1')}
              <br />
              <Link href="/docs/organize/activities">
                {t('landing.activities.guide')} <span aria-hidden="true">↗</span>
              </Link>
            </p>
            <p>{t('landing.activities.foot2')}</p>
          </div>
        </div>
      </section>

      <section className={styles.section} id="learning" aria-labelledby="learning-title">
        <div className={styles.content}>
          <div className={styles.sectionLead}>
            <SectionTitle
              number="03"
              kicker={t('landing.templates.kicker')}
              first={t('landing.templates.title1')}
              second={t('landing.templates.title2')}
              id="learning-title"
            />
            <p>{t('landing.templates.body')}</p>
          </div>
          <TemplateDemo
            copy={{
              saved: t('landing.templates.saved'),
              sample: t('landing.templates.sample'),
              name: t('landing.templates.name'),
              reading: t('landing.templates.reading'),
              development: t('landing.templates.development'),
              walking: t('landing.templates.walking'),
              minuteUnit: t('landing.hero.minuteUnit'),
              sourceNote: t('landing.templates.sourceNote'),
              apply: t('landing.templates.apply'),
              reset: t('landing.templates.reset'),
              help: t('landing.templates.help'),
              target: t('landing.templates.target'),
              before: t('landing.templates.before'),
              after: t('landing.templates.after'),
              placeholderReading: t('landing.templates.placeholderReading'),
              placeholderDevelopment: t('landing.templates.placeholderDevelopment'),
              placeholderWalking: t('landing.templates.placeholderWalking'),
              feedbackBefore: t('landing.templates.feedbackBefore'),
              feedbackAfter: t('landing.templates.feedbackAfter'),
              evidence: t('landing.templates.evidence'),
            }}
          />
          <details className={styles.featureDetail}>
            <summary>{t('landing.templates.detailQuestion')}</summary>
            <p>{t('landing.templates.detailAnswer')}</p>
          </details>
        </div>
      </section>

      <section className={styles.section} id="review" aria-labelledby="review-title">
        <div className={styles.content}>
          <div className={styles.sectionLead}>
            <SectionTitle
              number="04"
              kicker={t('landing.review.kicker')}
              first={t('landing.review.title1')}
              second={t('landing.review.title2')}
              id="review-title"
            />
            <p>{t('landing.review.body')}</p>
          </div>
          <div className={styles.reviewPaper}>
            <div className={styles.reviewTop}>
              <strong>{t('landing.review.paperTitle')}</strong>
              <span>{t('landing.review.paperDate')}</span>
            </div>
            <div className={styles.reviewTotal}>
              <span>{t('landing.review.totalLabel')}</span>
              <p>
                <strong>16</strong> {t('landing.review.hour')} <strong>30</strong>{' '}
                {t('landing.review.minute')}
              </p>
              <span>{t('landing.review.totalNote')}</span>
            </div>
            <div className={styles.reviewColumns}>
              <div>
                <p className={styles.reportLabel}>{t('landing.review.allocation')}</p>
                {[
                  {
                    label: t('landing.review.development'),
                    duration: '12h',
                    kind: 'indigo',
                    width: '88%',
                  },
                  {
                    label: t('landing.review.reading'),
                    duration: '3h',
                    kind: 'blue',
                    width: '22%',
                  },
                  {
                    label: t('landing.review.walking'),
                    duration: '1h 30m',
                    kind: 'amber',
                    width: '11%',
                  },
                ].map((row) => (
                  <div className={styles.reportRow} key={row.kind}>
                    <span>{row.label}</span>
                    <div className={styles.reportBar}>
                      <i data-kind={row.kind} style={{ width: row.width }} />
                    </div>
                    <strong>{row.duration}</strong>
                  </div>
                ))}
                <p className={styles.reportNote}>{t('landing.review.allocationNote')}</p>
              </div>
              <div>
                <p className={styles.reportLabel}>{t('landing.review.comparison')}</p>
                <div className={styles.reviewReading}>
                  <span>{t('landing.review.reading')}</span>
                  <strong>{t('landing.review.comparisonValues')}</strong>
                </div>
                <p className={styles.reviewInsight}>{t('landing.review.insight')}</p>
                <p className={styles.reportNote}>{t('landing.review.comparisonNote')}</p>
              </div>
            </div>
            <div className={styles.reviewBottom}>
              <div>
                <p className={styles.reportLabel}>{t('landing.review.quality')}</p>
                <p>{t('landing.review.qualityNote')}</p>
              </div>
              <div>
                <p className={styles.reportLabel}>{t('landing.review.next')}</p>
                <p>{t('landing.review.nextNote')}</p>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className={styles.quietNote} id="philosophy">
        <span className={styles.roomLine} aria-hidden="true">
          <i />
        </span>
        <p>{t('landing.philosophy.title')}</p>
        <span>{t('landing.philosophy.body')}</span>
        <Link href="/docs/faq/philosophy">
          {t('landing.philosophy.guide')} <span aria-hidden="true">↗</span>
        </Link>
      </section>

      <section
        className={styles.integrations}
        id="integrations"
        aria-labelledby="integrations-title"
      >
        <div className={styles.content}>
          <div className={styles.sectionLead}>
            <SectionTitle
              number="05"
              kicker={t('landing.integrations.kicker')}
              first={t('landing.integrations.title1')}
              second={t('landing.integrations.title2')}
              id="integrations-title"
            />
            <p>{t('landing.integrations.body')}</p>
          </div>
          <div className={styles.googleBridge} id="google-calendar">
            <div>
              <p className={styles.kicker}>{t('landing.integrations.googleKicker')}</p>
              <h3>
                {t('landing.integrations.googleTitle1')}
                <br />
                {t('landing.integrations.googleTitle2')}
              </h3>
              <p>{t('landing.integrations.googleBody')}</p>
              <p className={styles.googleRule}>{t('landing.integrations.googleRule')}</p>
            </div>
            <div
              className={styles.googleDiagram}
              role="img"
              aria-label={t('landing.integrations.googleRule')}
            >
              <div>
                <span>{t('landing.integrations.googleSource')}</span>
                <div className={styles.googleSources}>
                  <span>{t('landing.integrations.googleWork')}</span>
                  <span>{t('landing.integrations.googlePersonal')}</span>
                </div>
                <small>{t('landing.integrations.googleAccounts')}</small>
              </div>
              <span aria-hidden="true">→</span>
              <div>
                <span>Dayopt</span>
                <div className={styles.externalExample}>
                  <strong>{t('landing.calendar.meeting')}</strong>
                  <small>11:00 — 11:30</small>
                  <span>{t('landing.integrations.googleSample')}</span>
                </div>
              </div>
            </div>
            <details className={styles.featureDetail}>
              <summary>{t('landing.integrations.googleDetailQuestion')}</summary>
              <p>{t('landing.integrations.googleDetailAnswer')}</p>
            </details>
          </div>
          <div className={styles.mcpSection} id="connections">
            <div>
              <p className={styles.kicker}>{t('landing.integrations.mcpKicker')}</p>
              <h3>
                {t('landing.integrations.mcpTitle1')}
                <br />
                {t('landing.integrations.mcpTitle2')}
              </h3>
              <p>{t('landing.integrations.mcpBody')}</p>
              <div className={styles.mcpFacts}>
                <p>
                  <b>{t('landing.integrations.read')}</b>
                  <span>{t('landing.integrations.readBody')}</span>
                </p>
                <p>
                  <b>{t('landing.integrations.write')}</b>
                  <span>{t('landing.integrations.writeBody')}</span>
                </p>
              </div>
              <p className={styles.mcpFoot}>{t('landing.integrations.mcpFoot')}</p>
            </div>
            <div className={styles.conversation}>
              <div className={styles.conversationHead}>
                <span>{t('landing.integrations.chatTitle')}</span>
                <small>{t('landing.integrations.chatSample')}</small>
              </div>
              <p>
                <span>{t('landing.integrations.you')}</span>
                {t('landing.integrations.question')}
              </p>
              <div className={styles.connectionLine}>
                <span>Dayopt</span>
                <i aria-hidden="true" />
                <span>{t('landing.integrations.ai')}</span>
              </div>
              <div className={styles.contextSlip}>
                <span>{t('landing.integrations.context')}</span>
                <p>{t('landing.integrations.contextBody')}</p>
              </div>
              <p>
                <span>{t('landing.integrations.ai')}</span>
                {t('landing.integrations.answer')}
                <br />
                <small>{t('landing.integrations.answerDetail')}</small>
              </p>
              <p className={styles.chatDisclaimer}>{t('landing.integrations.chatDisclaimer')}</p>
            </div>
          </div>
        </div>
      </section>

      <section className={styles.section} id="pricing" aria-labelledby="pricing-title">
        <div className={styles.content}>
          <div className={styles.sectionLead}>
            <SectionTitle
              number="06"
              kicker={t('landing.pricing.kicker')}
              first={t('landing.pricing.title1')}
              second={t('landing.pricing.title2')}
              id="pricing-title"
            />
            <p>{t('landing.pricing.body')}</p>
          </div>
          <div className={styles.pricingGrid}>
            <div className={styles.priceCard}>
              <div>
                <p className={styles.priceName}>{t('pricing.plans.free.name')}</p>
                <p className={styles.priceTagline}>{t('landing.pricing.freeLabel')}</p>
              </div>
              <p className={styles.priceAmount}>
                {dayoptPricing[dayoptPlans.free.id].displayPrice}
              </p>
              <p>{t('pricing.plans.free.description')}</p>
              <ul>
                {freeFeatures.map((feature) => (
                  <li key={feature}>{feature}</li>
                ))}
              </ul>
              <Button variant="outline" size="lg" asChild>
                <a href={signup}>
                  {t('pricing.plans.free.cta')} <span aria-hidden="true">↗</span>
                </a>
              </Button>
            </div>
            <div className={styles.priceCard}>
              <div>
                <p className={styles.priceName}>{t('pricing.plans.pro.name')}</p>
                <p className={styles.priceTagline}>{t('landing.pricing.proLabel')}</p>
              </div>
              <p className={styles.priceAmount}>
                {dayoptPricing[dayoptPlans.pro.id].displayPrice}{' '}
                <span>{t('landing.pricing.period')}</span>
              </p>
              <p>{t('pricing.trialNote')}</p>
              <ul>
                {proHighlights.map((feature) => (
                  <li key={feature}>{feature}</li>
                ))}
              </ul>
              <Button variant="primary" size="lg" asChild>
                <a href={signup}>
                  {t('pricing.plans.pro.cta')} <span aria-hidden="true">↗</span>
                </a>
              </Button>
            </div>
          </div>
        </div>
      </section>

      <section className={styles.section} id="faq" aria-labelledby="faq-title">
        <div className={styles.content}>
          <div className={styles.faqGrid}>
            <div>
              <SectionTitle
                number=""
                kicker={t('landing.faq.kicker')}
                first={t('landing.faq.title1')}
                second={t('landing.faq.title2')}
                id="faq-title"
              />
              <p>{t('landing.faq.guideIntro')}</p>
              <div className={styles.faqLinks}>
                <Link href="/docs/getting-started">
                  {t('landing.faq.guide')} <span aria-hidden="true">↗</span>
                </Link>
                <Link href="/docs/faq">
                  {t('landing.faq.all')} <span aria-hidden="true">↗</span>
                </Link>
              </div>
            </div>
            <div className={styles.faqList}>
              {[
                { question: t('landing.faq.q1'), answer: t('landing.faq.a1') },
                { question: t('landing.faq.q2'), answer: t('landing.faq.a2') },
                { question: t('landing.faq.q3'), answer: t('landing.faq.a3') },
                { question: t('landing.faq.q4'), answer: t('landing.faq.a4') },
                { question: t('landing.faq.q5'), answer: t('landing.faq.a5') },
                { question: t('landing.faq.q6'), answer: t('landing.faq.a6') },
              ].map((item) => (
                <details key={item.question}>
                  <summary>{item.question}</summary>
                  <p>{item.answer}</p>
                </details>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section className={styles.closing} id="next-day" aria-labelledby="closing-title">
        <ClosingMark label={t('landing.closing.replay')} />
        <h2 id="closing-title">
          {t('landing.closing.title1')}
          <br />
          <span>{t('landing.closing.title2')}</span>
        </h2>
        <p>{t('landing.closing.body')}</p>
        <Button variant="primary" size="lg" asChild>
          <a href={signup}>
            {t('landing.hero.cta')} <span aria-hidden="true">↗</span>
          </a>
        </Button>
        <small>{t('landing.closing.note')}</small>
      </section>
    </div>
  );
}
