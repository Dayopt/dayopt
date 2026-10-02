import styles from './ContentDesign.module.css';

/** 時間の輪郭と塗りを使った装飾。製品データを表す図ではない。 */
export function TimeArtwork({ variant = 0 }: { variant?: number }) {
  const offset = (variant % 4) * 24;
  return (
    <svg className={styles.artwork} viewBox="0 0 640 360" fill="none" aria-hidden="true">
      {[80, 160, 240, 320, 400, 480, 560].map((x) => (
        <path key={x} d={`M${x} 0V360`} className={styles.artworkGrid} />
      ))}
      {[90, 180, 270].map((y) => (
        <path key={y} d={`M0 ${y}H640`} className={styles.artworkGrid} />
      ))}
      {variant % 4 === 1 ? (
        <>
          <circle cx="320" cy="174" r="118" className={styles.artworkOutline} />
          <circle cx="320" cy="174" r="84" className={styles.artworkOutline} />
          <path d="M320 90A84 84 0 0 1 404 174H320Z" className={styles.artworkSolid} />
          <path d="M320 56V174L252 224" className={styles.artworkOutline} />
        </>
      ) : variant % 4 === 2 ? (
        <>
          {[0, 1, 2, 3, 4].map((step) => (
            <g key={step}>
              <rect
                x={96 + step * 88}
                y={56 + (step % 3) * 32}
                width="56"
                height={208 - (step % 3) * 32}
                className={styles.artworkOutline}
              />
              <rect
                x={100 + step * 88}
                y={104 + (step % 2) * 56}
                width="48"
                height={156 - (step % 2) * 56}
                className={styles.artworkSolid}
              />
            </g>
          ))}
        </>
      ) : variant % 4 === 3 ? (
        <>
          <rect x="120" y="56" width="368" height="240" className={styles.artworkOutline} />
          <rect x="144" y="80" width="320" height="192" className={styles.artworkOutline} />
          <rect x="168" y="104" width="272" height="144" className={styles.artworkOutline} />
          <rect x="192" y="128" width="224" height="96" className={styles.artworkSolid} />
        </>
      ) : (
        <>
          <rect
            x={80 + offset}
            y="65"
            width="240"
            height="72"
            rx="3"
            className={styles.artworkOutline}
          />
          <rect
            x={80 + offset}
            y="151"
            width="320"
            height="72"
            rx="3"
            className={styles.artworkSolid}
          />
          <rect
            x={432 - offset}
            y="237"
            width="128"
            height="58"
            rx="3"
            className={styles.artworkOutline}
          />
        </>
      )}
      <path d="M32 328H608" className={styles.artworkAxis} />
      {[80, 160, 240, 320, 400, 480, 560].map((x) => (
        <path key={x} d={`M${x} 320V336`} className={styles.artworkAxis} />
      ))}
    </svg>
  );
}
