'use client';

import { type CSSProperties, useEffect, useId, useRef, useState } from 'react';

import styles from './DayCanvas.module.css';

export interface DayCanvasCopy {
  label: string;
  sample: string;
  dayFirst: string;
  dayNext: string;
  plan: string;
  record: string;
  reading: string;
  minuteUnit: string;
  previousRecord: string;
  pending: string;
  controlsLabel: string;
  stepPlan: string;
  stepRecord: string;
  stepNext: string;
  reset: string;
  planTitle: string;
  planBody: string;
  recordTitle: string;
  recordBody: string;
  nextTitle: string;
  nextBody: string;
  room: string;
  help: string;
  probeLabel: string;
  probePlan: string;
  probeBoth: string;
  probeRecord: string;
  probeNext: string;
  probeRoom: string;
}

type DayStep = 'plan' | 'record' | 'next';

/** Independent sample plans and records, on the same sixty-minute scale. */
export function DayCanvas({
  copy,
  initialStep = 'record',
}: {
  copy: DayCanvasCopy;
  initialStep?: DayStep;
}) {
  const [step, setStep] = useState<DayStep>(initialStep);
  const [probeMinute, setProbeMinute] = useState(30);
  const probeId = useId();
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = root.current;
    if (
      !element ||
      !window.matchMedia('(min-width: 1024px) and (prefers-reduced-motion: no-preference)').matches
    )
      return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const bounds = element.getBoundingClientRect();
      const progress = Math.min(
        1,
        Math.max(0, (window.innerHeight - bounds.top) / (window.innerHeight + bounds.height)),
      );
      element.style.setProperty('--scene-progress', String(progress));
    };
    const onScroll = () => {
      if (!frame) frame = window.requestAnimationFrame(update);
    };
    update();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.cancelAnimationFrame(frame);
    };
  }, []);

  const next = step === 'next';
  const duration = next ? 45 : 30;
  const probeTime = probeMinute === 60 ? '10:00' : `09:${String(probeMinute).padStart(2, '0')}`;
  const probeFeedback = next
    ? probeMinute < 45
      ? copy.probeNext
      : copy.probeRoom
    : probeMinute < 30
      ? step === 'plan'
        ? copy.probePlan
        : copy.probeBoth
      : probeMinute < 45 && step === 'record'
        ? copy.probeRecord
        : copy.probeRoom;
  const descriptions = {
    plan: [copy.planTitle, copy.planBody],
    record: [copy.recordTitle, copy.recordBody],
    next: [copy.nextTitle, copy.nextBody],
  };
  const steps = [
    { value: 'plan', label: copy.stepPlan },
    { value: 'record', label: copy.stepRecord },
    { value: 'next', label: copy.stepNext },
  ] as const;

  return (
    <div
      ref={root}
      className={styles.canvas}
      data-step={step}
      style={{ '--probe-minute': probeMinute } as CSSProperties}
    >
      <div className={styles.topline}>
        <span>
          <i aria-hidden="true" />
          {copy.sample}
        </span>
        <span>{next ? copy.dayNext : copy.dayFirst}</span>
        <button
          type="button"
          className={styles.reset}
          onClick={() => {
            setStep(initialStep);
            setProbeMinute(30);
          }}
        >
          <span aria-hidden="true">↺</span>
          {copy.reset}
        </button>
      </div>
      <div className={styles.stage}>
        <figure
          className={styles.timeStudy}
          aria-label={
            step === 'record' ? copy.label : `${descriptions[step][0]} ${descriptions[step][1]}`
          }
        >
          <div className={styles.clock} aria-hidden="true">
            {['09:00', '09:15', '09:30', '09:45', '10:00'].map((time) => (
              <span key={time}>{time}</span>
            ))}
          </div>
          <div className={styles.lanes}>
            <div className={styles.lane}>
              <div className={styles.laneHeading}>
                <i className={styles.outlineKey} aria-hidden="true" />
                {next ? `${copy.dayNext} · ${copy.plan}` : copy.plan}
              </div>
              <div className={styles.rail}>
                <div
                  className={styles.plan}
                  data-plan-duration={duration}
                  style={{ height: `${(duration / 60) * 100}%` }}
                >
                  <span>{copy.reading}</span>
                  <p>
                    <strong>{duration}</strong>
                    <small>{copy.minuteUnit}</small>
                  </p>
                  <time>09:00 — {next ? '09:45' : '09:30'}</time>
                </div>
                <span className={styles.room}>{copy.room}</span>
              </div>
            </div>
            <div className={styles.lane}>
              <div className={styles.laneHeading}>
                <i className={styles.solidKey} aria-hidden="true" />
                {next ? copy.previousRecord : copy.record}
              </div>
              <div className={styles.rail}>
                {step !== 'plan' ? (
                  <div
                    className={styles.record}
                    data-record-duration="45"
                    data-record-day={next ? 'previous' : 'same'}
                  >
                    <span>{copy.reading}</span>
                    <p>
                      <strong>45</strong>
                      <small>{copy.minuteUnit}</small>
                    </p>
                    <time>09:00 — 09:45</time>
                    <svg
                      className={styles.inkLines}
                      viewBox="0 0 240 360"
                      preserveAspectRatio="none"
                      aria-hidden="true"
                      focusable="false"
                    >
                      {Array.from({ length: 45 }, (_, minute) => (
                        <line
                          key={minute}
                          x1={minute % 15 === 0 ? 0 : 200}
                          x2="240"
                          y1={minute * 8}
                          y2={minute * 8}
                        />
                      ))}
                    </svg>
                  </div>
                ) : (
                  <p className={styles.pending}>{copy.pending}</p>
                )}
              </div>
            </div>
          </div>
          <span className={styles.probeLine} aria-hidden="true" />
          <div className={styles.probe}>
            <label htmlFor={probeId}>{copy.probeLabel}</label>
            <input
              id={probeId}
              type="range"
              min="0"
              max="60"
              step="1"
              value={probeMinute}
              aria-label={copy.probeLabel}
              aria-valuetext={`${probeTime}. ${probeFeedback}`}
              onChange={(event) => setProbeMinute(Number(event.target.value))}
            />
            <output htmlFor={probeId} aria-live="off">
              <time>{probeTime}</time>
              <span>{probeFeedback}</span>
            </output>
          </div>
        </figure>
        <div className={styles.insight} aria-live="polite" aria-atomic="true">
          <span className={styles.index}>
            {String(steps.findIndex((item) => item.value === step) + 1).padStart(2, '0')} / 03
          </span>
          <div className={styles.descriptions}>
            {steps.map((item) => (
              <div
                key={item.value}
                className={styles.description}
                data-active={step === item.value}
                aria-hidden={step !== item.value}
              >
                <h2>{descriptions[item.value][0]}</h2>
                <p>{descriptions[item.value][1]}</p>
              </div>
            ))}
          </div>
          <div className={styles.measure} aria-hidden="true">
            <i />
            <i />
            <i />
          </div>
        </div>
      </div>
      <div className={styles.controls} role="group" aria-label={copy.controlsLabel}>
        {steps.map((item, index) => (
          <button
            key={item.value}
            type="button"
            aria-pressed={step === item.value}
            onClick={() => setStep(item.value)}
          >
            <span className={styles.controlNumber} aria-hidden="true">
              0{index + 1}
            </span>
            <span>{item.label}</span>
            <span className={styles.controlArrow} aria-hidden="true">
              ↗
            </span>
          </button>
        ))}
      </div>
      <p className={styles.help}>{copy.help}</p>
    </div>
  );
}
