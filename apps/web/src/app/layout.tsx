import { generateEnhancedMetadata } from '@web/components/seo/EnhancedSEO';
import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = generateEnhancedMetadata({
  title: 'Dayopt — Give your day shape.',
  description:
    'Your plans and records, together in one calendar. See your time and shape your next day.',
  keywords: ['timeboxing', 'calendar', 'time tracking', 'planning', 'daily review'],
  type: 'website',
});

// HTML は locale が確定する layout、またはルートのエラー画面が描画する。
// headers() を参照せず、公開ページの静的配信を維持する。
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return children;
}
