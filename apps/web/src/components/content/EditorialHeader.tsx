import type { ReactNode } from 'react';
import styles from './ContentDesign.module.css';
import { TimeArtwork } from './TimeArtwork';

/** 公開ページのタイトルと導入を、Home と同じ余白と文字組みで示す。 */
export function EditorialHeader({
  eyebrow,
  title,
  description,
  children,
  artwork = false,
}: {
  eyebrow: string;
  title: string;
  description?: string;
  children?: ReactNode;
  artwork?: boolean;
}) {
  return (
    <header className={styles.pageHeader} data-artwork={artwork || undefined}>
      <div className={styles.headerCopy}>
        <p className={styles.eyebrow}>{eyebrow}</p>
        <h1>{title}</h1>
        {description && <p className={styles.introduction}>{description}</p>}
        {children}
      </div>
      {artwork && (
        <div className={styles.headerArtwork}>
          <TimeArtwork />
        </div>
      )}
    </header>
  );
}
