'use client';

import { useState } from 'react';

import styles from './LandingPage.module.css';

interface JourneyCopy {
  label: string;
  first: string;
  next: string;
  later: string;
  reading: string;
  minuteUnit: string;
  firstThought: string;
  nextThought: string;
  completion1: string;
  completion2: string;
  plan: string;
  record: string;
  replay: string;
}

function Mark({ animated = false }: { animated?: boolean }) {
  return (
    <span className={styles.mark} aria-hidden="true">
      <span className={styles.markOutline} />
      <span className={animated ? styles.markInkAnimated : styles.markInk} />
    </span>
  );
}

export function HeroJourney({ copy }: { copy: JourneyCopy }) {
  const [run, setRun] = useState(0);

  return (
    <div className={styles.journey} role="group" aria-label={copy.label}>
      <div key={run} className={styles.journeyMotion}>
        <svg
          className={styles.journeyPath}
          viewBox="0 0 600 390"
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <path
            pathLength="1"
            d="M60 86 H172 Q195 86 195 109 V168 Q195 192 219 192 H340 Q364 192 364 215 V276 Q364 300 388 300 H535"
          />
        </svg>
        <div className={styles.journeyMoments}>
          <div className={styles.moment}>
            <span className={styles.momentMeta}>{copy.first}</span>
            <div className={styles.timePair}>
              <div className={styles.timeOutline}>
                <span>{copy.reading}</span>
                <small>30{copy.minuteUnit}</small>
              </div>
              <div className={styles.timeInk}>
                <span>{copy.reading}</span>
                <small>45{copy.minuteUnit}</small>
              </div>
            </div>
            <p>{copy.firstThought}</p>
          </div>
          <div className={styles.moment}>
            <span className={styles.momentMeta}>{copy.next}</span>
            <div className={styles.timePair}>
              <div className={styles.timeOutline}>
                <span>{copy.reading}</span>
                <small>45{copy.minuteUnit}</small>
              </div>
              <div className={styles.timeInk}>
                <span>{copy.reading}</span>
                <small>45{copy.minuteUnit}</small>
              </div>
            </div>
            <p>{copy.nextThought}</p>
          </div>
          <div className={styles.moment}>
            <span className={styles.momentMeta}>{copy.later}</span>
            <div className={styles.completion}>
              <Mark animated />
              <span>
                {copy.completion1}
                <br />
                <strong>{copy.completion2}</strong>
              </span>
            </div>
          </div>
        </div>
      </div>
      <div className={styles.journeyLegend}>
        <span>
          <i className={styles.legendOutline} aria-hidden="true" />
          {copy.plan}
        </span>
        <span>
          <i className={styles.legendSolid} aria-hidden="true" />
          {copy.record}
        </span>
        <button
          type="button"
          onClick={() => setRun((value) => value + 1)}
          className={styles.replayButton}
        >
          <span aria-hidden="true">↻</span> {copy.replay}
        </button>
      </div>
    </div>
  );
}

type DayStep = 'plan' | 'record' | 'next';

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

export function CalendarDemo({ copy }: { copy: CalendarCopy }) {
  const [step, setStep] = useState<DayStep>('record');
  const steps: Array<{ id: DayStep; label: string }> = [
    { id: 'plan', label: copy.stepPlan },
    { id: 'record', label: copy.stepRecord },
    { id: 'next', label: copy.stepNext },
  ];
  const insight = {
    plan: [copy.insightPlan1, copy.insightPlan2, copy.insightPlanCopy],
    record: [copy.insightRecord1, copy.insightRecord2, copy.insightRecordCopy],
    next: [copy.insightNext1, copy.insightNext2, copy.insightNextCopy],
  }[step];

  return (
    <>
      <div className={styles.experienceControls} role="group" aria-label={copy.controlsLabel}>
        {steps.map((item, index) => (
          <button
            key={item.id}
            type="button"
            aria-pressed={step === item.id}
            onClick={() => setStep(item.id)}
          >
            <span>0{index + 1}</span>
            {item.label}
          </button>
        ))}
      </div>
      <figure className={styles.productWindow} data-step={step} aria-label={copy.figureLabel}>
        <div className={styles.productToolbar}>
          <strong>dayopt</strong>
          <span>{step === 'next' ? copy.dateNext : copy.dateFirst}</span>
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
              <span>{step === 'next' ? copy.weekdayNext : copy.weekdayFirst}</span>
              <b>{step === 'next' ? '11' : '10'}</b>
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
                  <small>{step === 'next' ? '45' + copy.minuteUnit : '30' + copy.minuteUnit}</small>
                </div>
                {step === 'record' && (
                  <div className={styles.readingRecord}>
                    <strong>{copy.reading}</strong>
                    <small>45{copy.minuteUnit}</small>
                  </div>
                )}
                <div className={styles.developmentPlan}>
                  <strong>{copy.development}</strong>
                  <small>60{copy.minuteUnit}</small>
                </div>
                {step === 'record' && (
                  <div className={styles.developmentRecord}>
                    <strong>{copy.development}</strong>
                    <small>60{copy.minuteUnit}</small>
                  </div>
                )}
                <div className={styles.walkPlan}>
                  <strong>{copy.walking}</strong>
                  <small>30{copy.minuteUnit}</small>
                </div>
              </div>
            </div>
          </div>
          <aside className={styles.experienceInsight} aria-live="polite" aria-atomic="true">
            <span className={styles.stepCount}>
              0{steps.findIndex((item) => item.id === step) + 1}
            </span>
            <p>
              {insight[0]}
              <br />
              {insight[1]}
            </p>
            <span>{insight[2]}</span>
            <div className={styles.experienceMeasure}>
              <div>
                <i className={styles.legendOutline} aria-hidden="true" />
                {copy.plan} {step === 'next' ? '45' + copy.minuteUnit : '30' + copy.minuteUnit}
              </div>
              <div>
                <i className={styles.legendSolid} aria-hidden="true" />
                {step === 'plan'
                  ? copy.recordPending
                  : step === 'next'
                    ? copy.recordPrevious
                    : copy.record + ' 45' + copy.minuteUnit}
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
    </>
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
  const [applied, setApplied] = useState(false);
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
    <div className={styles.templateDemo} data-applied={applied}>
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
        <button type="button" className={styles.templateApply} onClick={() => setApplied(!applied)}>
          {applied ? copy.reset : copy.apply}
          <span aria-hidden="true">{applied ? '↻' : '→'}</span>
        </button>
        <p className={styles.templateHelp}>{copy.help}</p>
      </div>
      <div className={styles.templateTarget}>
        <div className={styles.templateTargetHead}>
          <strong>{copy.target}</strong>
          <span>{applied ? copy.after : copy.before}</span>
        </div>
        <div className={styles.templateTimeline}>
          {rows.map((row) => (
            <div className={styles.rhythmRow} key={row.time}>
              <time>{row.time}</time>
              <div>
                {applied ? (
                  <span className={styles.rhythmPlan} data-kind={row.kind}>
                    <b>{row.name}</b>
                    <span>{row.duration}</span>
                  </span>
                ) : (
                  <span className={styles.rhythmPlaceholder}>{row.placeholder}</span>
                )}
              </div>
            </div>
          ))}
        </div>
        <p className={styles.templateResult} aria-live="polite">
          {applied ? copy.feedbackAfter : copy.feedbackBefore}
        </p>
        <p className={styles.templateEvidence}>{copy.evidence}</p>
      </div>
    </div>
  );
}

export function ClosingMark({ label }: { label: string }) {
  const [run, setRun] = useState(0);
  return (
    <button
      type="button"
      className={styles.closingMark}
      aria-label={label}
      onClick={() => setRun((value) => value + 1)}
    >
      <span key={run}>
        <Mark animated />
      </span>
    </button>
  );
}
