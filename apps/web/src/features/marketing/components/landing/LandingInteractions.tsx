import { LogoArtwork } from '@dayopt/assets/logo-artwork';
import { Fragment, useId, type ReactNode } from 'react';

import { ClosingMarkReplay } from './ClosingMarkReplay';
import styles from './LandingPage.module.css';

interface CalendarCopy {
  controlsLabel: string;
  stepPlan: string;
  stepRecord: string;
  stepNext: string;
  figureLabel: string;
  sample: string;
  dateFirst: string;
  dateNext: string;
  weekdayFirst: string;
  weekdayNext: string;
  learning: string;
  work: string;
  life: string;
  reading: string;
  language: string;
  development: string;
  meeting: string;
  walking: string;
  minuteUnit: string;
  template: string;
  templateName: string;
  insightPlan1: string;
  insightPlan2: string;
  insightPlanCopy: string;
  insightRecord1: string;
  insightRecord2: string;
  insightRecordCopy: string;
  insightNext1: string;
  insightNext2: string;
  insightNextCopy: string;
  plan: string;
  record: string;
  recordPending: string;
  recordPrevious: string;
  sameTimeline: string;
}

/** Browser-native choices keep this sample usable before hydration and without JS. */
export function CalendarDemo({ copy }: { copy: CalendarCopy }) {
  const name = useId();
  const steps = [
    { id: 'plan', label: copy.stepPlan },
    { id: 'record', label: copy.stepRecord },
    { id: 'next', label: copy.stepNext },
  ] as const;
  return (
    <div className={styles.calendarDemo}>
      <div className={styles.experienceControls} role="radiogroup" aria-label={copy.controlsLabel}>
        {steps.map((item, index) => (
          <label key={item.id}>
            <input
              className={styles.nativeChoice}
              type="radio"
              name={name}
              value={item.id}
              data-calendar-step={item.id}
              aria-label={item.label}
              defaultChecked={item.id === 'record'}
            />
            <span aria-hidden="true">0{index + 1}</span>
            {item.label}
          </label>
        ))}
      </div>
      <CalendarScene copy={copy} />
    </div>
  );
}

function CalendarAlternatives({ first, next }: { first: ReactNode; next: ReactNode }) {
  return (
    <>
      <span data-calendar-content="first">{first}</span>
      <span data-calendar-content="next">{next}</span>
    </>
  );
}

function CalendarScene({ copy }: { copy: CalendarCopy }) {
  const descriptions = [
    {
      value: 'plan',
      count: '01',
      content: [copy.insightPlan1, copy.insightPlan2, copy.insightPlanCopy],
    },
    {
      value: 'record',
      count: '02',
      content: [copy.insightRecord1, copy.insightRecord2, copy.insightRecordCopy],
    },
    {
      value: 'next',
      count: '03',
      content: [copy.insightNext1, copy.insightNext2, copy.insightNextCopy],
    },
  ];
  return (
    <figure className={styles.productWindow} aria-label={copy.figureLabel}>
      <div className={styles.productToolbar}>
        <strong>dayopt</strong>
        <span>
          <CalendarAlternatives first={copy.dateFirst} next={copy.dateNext} />
        </span>
        <small>{copy.sample}</small>
      </div>
      <div className={styles.experienceBody}>
        <aside className={styles.experienceSidebar} aria-hidden="true">
          <div>
            <p>
              <i className={styles.blueDot} />
              {copy.learning}
            </p>
            <span>{copy.reading}</span>
            <span>{copy.language}</span>
          </div>
          <div>
            <p>
              <i className={styles.indigoDot} />
              {copy.work}
            </p>
            <span>{copy.development}</span>
            <span>{copy.meeting}</span>
          </div>
          <div>
            <p>
              <i className={styles.amberDot} />
              {copy.life}
            </p>
            <span>{copy.walking}</span>
          </div>
          <p>{copy.template}</p>
          <span>{copy.templateName}</span>
        </aside>
        <div className={styles.experienceCalendar}>
          <div className={styles.experienceDay}>
            <span>
              <CalendarAlternatives first={copy.weekdayFirst} next={copy.weekdayNext} />
            </span>
            <b>
              <CalendarAlternatives first={'10'} next={'11'} />
            </b>
          </div>
          <div className={styles.timeGrid}>
            <div className={styles.hours} aria-hidden="true">
              <span>09:00</span>
              <span>10:00</span>
              <span>11:00</span>
              <span>12:00</span>
            </div>
            <div className={styles.events}>
              <div className={styles.readingPlan}>
                <strong>{copy.reading}</strong>
                <small>
                  <CalendarAlternatives
                    first={'30' + copy.minuteUnit}
                    next={'45' + copy.minuteUnit}
                  />
                </small>
              </div>
              <div className={styles.readingRecord} data-calendar-content="record">
                <strong>{copy.reading}</strong>
                <small>45{copy.minuteUnit}</small>
              </div>
              <div className={styles.developmentPlan}>
                <strong>{copy.development}</strong>
                <small>60{copy.minuteUnit}</small>
              </div>
              <div className={styles.developmentRecord} data-calendar-content="record">
                <strong>{copy.development}</strong>
                <small>60{copy.minuteUnit}</small>
              </div>
              <div className={styles.walkPlan}>
                <strong>{copy.walking}</strong>
                <small>30{copy.minuteUnit}</small>
              </div>
            </div>
          </div>
        </div>
        <aside className={styles.experienceInsight} aria-live="polite" aria-atomic="true">
          {descriptions.map(({ value, count, content }) => (
            <Fragment key={value}>
              <span className={styles.stepCount} data-calendar-content={value}>
                {count}
              </span>
              <p data-calendar-content={value}>
                {content[0]}
                <br />
                {content[1]}
              </p>
              <span data-calendar-content={value}>{content[2]}</span>
            </Fragment>
          ))}
          <div className={styles.experienceMeasure}>
            <div>
              <i className={styles.legendOutline} aria-hidden="true" />
              {copy.plan}{' '}
              <CalendarAlternatives first={'30' + copy.minuteUnit} next={'45' + copy.minuteUnit} />
            </div>
            <div>
              <i className={styles.legendSolid} aria-hidden="true" />
              <span data-calendar-content="plan">{copy.recordPending}</span>
              <span data-calendar-content="record">
                {copy.record} 45{copy.minuteUnit}
              </span>
              <span data-calendar-content="next">{copy.recordPrevious}</span>
            </div>
          </div>
        </aside>
      </div>
      <figcaption className={styles.calendarNote}>
        <span>
          <i className={styles.legendOutline} aria-hidden="true" />
          {copy.plan}
          <i className={styles.legendSolid} aria-hidden="true" />
          {copy.record}
        </span>
        <span>{copy.sameTimeline}</span>
      </figcaption>
    </figure>
  );
}

interface TemplateCopy {
  saved: string;
  sample: string;
  name: string;
  reading: string;
  development: string;
  walking: string;
  minuteUnit: string;
  sourceNote: string;
  apply: string;
  reset: string;
  help: string;
  target: string;
  before: string;
  after: string;
  placeholderReading: string;
  placeholderDevelopment: string;
  placeholderWalking: string;
  feedbackBefore: string;
  feedbackAfter: string;
  evidence: string;
}

export function TemplateDemo({ copy }: { copy: TemplateCopy }) {
  const rows = [
    {
      time: '09:00',
      name: copy.reading,
      placeholder: copy.placeholderReading,
      duration: '45' + copy.minuteUnit,
      kind: 'blue',
    },
    {
      time: '10:00',
      name: copy.development,
      placeholder: copy.placeholderDevelopment,
      duration: '60' + copy.minuteUnit,
      kind: 'indigo',
    },
    {
      time: '11:30',
      name: copy.walking,
      placeholder: copy.placeholderWalking,
      duration: '30' + copy.minuteUnit,
      kind: 'amber',
    },
  ];

  return (
    <div className={styles.templateDemo}>
      <div className={styles.templateSource}>
        <p className={styles.demoOverline}>
          {copy.saved} <span>{copy.sample}</span>
        </p>
        <h3>{copy.name}</h3>
        <ol className={styles.savedRhythm}>
          {rows.map((row) => (
            <li key={row.time}>
              <time>{row.time}</time>
              <span>{row.name}</span>
            </li>
          ))}
        </ol>
        <p className={styles.rhythmNote}>{copy.sourceNote}</p>
        <details className={styles.templateSwitch}>
          <summary className={styles.templateApply}>
            <span data-template-state="before">
              {copy.apply} <span aria-hidden="true">→</span>
            </span>
            <span data-template-state="after">
              {copy.reset} <span aria-hidden="true">↻</span>
            </span>
          </summary>
          <span className={styles.nativeChoice}>{copy.after}</span>
        </details>
        <p className={styles.templateHelp}>{copy.help}</p>
      </div>
      <div className={styles.templateTarget}>
        <div className={styles.templateTargetHead}>
          <strong>{copy.target}</strong>
          <span>
            <span data-template-state="before">{copy.before}</span>
            <span data-template-state="after">{copy.after}</span>
          </span>
        </div>
        <div className={styles.templateTimeline}>
          {rows.map((row) => (
            <div className={styles.rhythmRow} key={row.time}>
              <time>{row.time}</time>
              <div>
                <span
                  className={styles.rhythmPlan}
                  data-kind={row.kind}
                  data-template-state="after"
                >
                  <b>{row.name}</b>
                  <span>{row.duration}</span>
                </span>
                <span className={styles.rhythmPlaceholder} data-template-state="before">
                  {row.placeholder}
                </span>
              </div>
            </div>
          ))}
        </div>
        <p className={styles.templateResult} aria-live="polite">
          <span data-template-state="before">{copy.feedbackBefore}</span>
          <span data-template-state="after">{copy.feedbackAfter}</span>
        </p>
        <p className={styles.templateEvidence}>{copy.evidence}</p>
      </div>
    </div>
  );
}

export function ClosingMark({ label }: { label: string }) {
  return (
    <ClosingMarkReplay label={label} className={styles.closingMark}>
      <LogoArtwork variant="mark" width={100} height={100} />
    </ClosingMarkReplay>
  );
}
