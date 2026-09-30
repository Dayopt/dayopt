import { useId } from 'react';

import styles from './WeekTrace.module.css';

const sample = [
  { plan: 120, record: 150 },
  { plan: 180, record: 180 },
  { plan: 150, record: 135 },
  { plan: 150, record: 150 },
  { plan: 150, record: 180 },
  { plan: 90, record: 90 },
  { plan: 90, record: 105 },
] as const;

export interface WeekTraceCopy {
  label: string;
  days: string[];
  plan: string;
  record: string;
  minuteUnit: string;
  scale: string;
}

/** A sample week: 15h 30m planned and 16h 30m recorded independently. */
export function WeekTrace({ copy }: { copy: WeekTraceCopy }) {
  const name = useId();
  return (
    <figure className={styles.trace} aria-label={copy.label}>
      <div className={styles.legend} aria-hidden="true">
        <small>{copy.scale}</small>
        <span>
          <i />
          {copy.plan}
        </span>
        <span>
          <i />
          {copy.record}
        </span>
      </div>
      <div className={styles.days} role="radiogroup" aria-label={copy.label}>
        {sample.map((day, index) => (
          <label className={styles.day} key={index}>
            <input
              className={styles.dayInput}
              type="radio"
              name={name}
              value={index}
              data-index={index}
              defaultChecked={index === 0}
              aria-label={`${copy.days[index]}: ${copy.plan} ${day.plan} ${copy.minuteUnit}, ${copy.record} ${day.record} ${copy.minuteUnit}`}
            />
            <div className={styles.bars} aria-hidden="true">
              <i style={{ height: `${(day.plan / 180) * 100}%` }} />
              <i style={{ height: `${(day.record / 180) * 100}%` }} />
            </div>
            <span aria-hidden="true">{copy.days[index]}</span>
          </label>
        ))}
      </div>
      <figcaption className={styles.details}>
        {sample.map((day, index) => (
          <div className={styles.detail} data-index={index} key={index}>
            <span>{copy.days[index]}</span>
            <span>
              {copy.plan} <strong>{day.plan}</strong> {copy.minuteUnit}
            </span>
            <span>
              {copy.record} <strong>{day.record}</strong> {copy.minuteUnit}
            </span>
          </div>
        ))}
      </figcaption>
    </figure>
  );
}
