import { ContentTypography } from '@web/shell/layout/ContentTypography';
import type { ReactNode } from 'react';

export default function SearchLayout({ children }: { children: ReactNode }) {
  return <ContentTypography>{children}</ContentTypography>;
}
