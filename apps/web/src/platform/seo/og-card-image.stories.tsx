import { DAYOPT_BRAND } from '@dayopt/assets/brand';
import { OG_CARD_SIZE, OG_CATEGORIES, OG_LAYOUTS } from '@dayopt/assets/og';
import { OgCardImage, type OgCardImageProps } from '@dayopt/assets/og-card-image';
import type { Locale } from '@dayopt/i18n/routing';
import type { Meta, StoryObj } from '@storybook/nextjs-vite';

import { getOgCategoryLabel } from './og-category-label';

import './og-card-fonts.css';

type OgCardStoryArgs = Omit<OgCardImageProps, 'categoryLabel'> & { locale: Locale };

const STORYBOOK_SCREENSHOT = [
  'data:image/svg+xml,',
  encodeURIComponent(
    [
      '<svg xmlns="http://www.w3.org/2000/svg" width="960" height="640" viewBox="0 0 960 640">',
      '<rect width="960" height="640" fill="' + DAYOPT_BRAND.reverse + '"/>',
      '<rect width="960" height="72" fill="' + DAYOPT_BRAND.primary + '" fill-opacity="0.04"/>',
      '<rect width="210" height="640" y="72" fill="' +
        DAYOPT_BRAND.primary +
        '" fill-opacity="0.025"/>',
      '<g fill="none" stroke="' +
        DAYOPT_BRAND.primary +
        '" stroke-opacity="0.12" stroke-width="2">',
      '<path d="M210 72v568M360 160v430M490 160v430M620 160v430M750 160v430M880 160v430"/>',
      '<path d="M250 160h660M250 250h660M250 340h660M250 430h660M250 520h660M250 590h660"/>',
      '</g>',
      '<g fill="' + DAYOPT_BRAND.primary + '" fill-opacity="0.16">',
      '<rect x="28" y="24" width="108" height="24" rx="6"/>',
      '<rect x="28" y="112" width="126" height="12" rx="6"/>',
      '<rect x="28" y="148" width="142" height="12" rx="6"/>',
      '<rect x="28" y="184" width="118" height="12" rx="6"/>',
      '<rect x="28" y="220" width="132" height="12" rx="6"/>',
      '<rect x="388" y="185" width="82" height="52" rx="8"/>',
      '<rect x="648" y="275" width="92" height="52" rx="8"/>',
      '<rect x="518" y="365" width="88" height="52" rx="8"/>',
      '<rect x="778" y="455" width="94" height="52" rx="8"/>',
      '</g>',
      '</svg>',
    ].join(''),
  ),
].join('');

function OgCardPreview({ scale = 0.42, locale, ...props }: OgCardStoryArgs & { scale?: number }) {
  return (
    <div
      className="border-border overflow-hidden border"
      style={{
        width: OG_CARD_SIZE.width * scale,
        height: OG_CARD_SIZE.height * scale,
        minWidth: 0,
      }}
    >
      <div style={{ transform: 'scale(' + scale + ')', transformOrigin: 'top left' }}>
        <OgCardImage {...props} categoryLabel={getOgCategoryLabel(locale, props.category)} />
      </div>
    </div>
  );
}

function OgCardStory(props: OgCardStoryArgs) {
  return <OgCardPreview {...props} />;
}

const meta = {
  title: 'Web/Platform/SEO/OG Image',
  component: OgCardStory,
  tags: ['autodocs'],
  parameters: { layout: 'fullscreen' },
  argTypes: {
    category: { control: 'select', options: [...OG_CATEGORIES] },
    layout: { control: 'select', options: [...OG_LAYOUTS] },
    locale: { control: 'select', options: ['en', 'ja'] },
    screenshotSrc: { control: false },
  },
  render: (args) => <OgCardPreview {...args} />,
} satisfies Meta<typeof OgCardStory>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Docs向けの中央レイアウト。 */
export const Center: Story = {
  args: {
    title: '時間の使い方を、計画と記録から見直す',
    category: 'docs',
    layout: 'center',
    locale: 'ja',
  },
};

/** Journal向けの左寄せレイアウト。 */
export const Left: Story = {
  args: {
    title: '新しい記録と、日々を振り返る時間',
    category: 'journal',
    layout: 'left',
    locale: 'ja',
  },
};

/** Product向けのスクリーンショット付きレイアウト。 */
export const Screenshot: Story = {
  args: {
    title: 'Dayoptで計画と記録をひとつにつなぐ',
    category: 'product',
    layout: 'screenshot',
    screenshotSrc: STORYBOOK_SCREENSHOT,
    locale: 'ja',
  },
};

/** 短い英語見出しは大きな1行で表示。 */
export const ShortTitle = {
  args: { title: 'MCP Authentication', category: 'docs', layout: 'center', locale: 'en' },
} satisfies Story;

/** 長い英語見出しを単語の境界で2行に整える。 */
export const LongEnglishTitle = {
  args: {
    title: 'Build a calmer daily routine with plans you can actually keep',
    category: 'journal',
    layout: 'left',
    locale: 'en',
  },
} satisfies Story;

/** 長い日本語見出しは句読点と語の区切りを考慮して整える。 */
export const LongJapaneseTitle = {
  args: {
    title: '忙しい毎日でも無理なく続けられる、計画と記録を使った時間の振り返り方',
    category: 'journal',
    layout: 'left',
    locale: 'ja',
  },
} satisfies Story;

/** 日英混在の見出しと括弧を含む中央レイアウト。 */
export const MixedTitle = {
  args: {
    title: 'Dayopt MCPで始める、AIと一緒に計画・記録を振り返る方法（入門ガイド）',
    category: 'docs',
    layout: 'center',
    locale: 'ja',
  },
} satisfies Story;

/** 狭いスクリーンショット併設時は、長文を最大3行で表示。 */
export const LongScreenshotTitle = {
  args: {
    title: 'Make room for meaningful work by bringing your daily plans and records together',
    category: 'product',
    layout: 'screenshot',
    screenshotSrc: STORYBOOK_SCREENSHOT,
    locale: 'en',
  },
} satisfies Story;

/** Release向けの週カレンダー背景。 */
export const Release = {
  args: {
    title: 'A little closer to the day you had in mind',
    category: 'release',
    layout: 'left',
    locale: 'en',
  },
} satisfies Story;

/** 実際のカテゴリ色で、予定・記録の単独レーンと並列ペアを3日分表示。 */
export const WeekView = {
  args: {
    title: 'Make plans you can actually keep',
    category: 'journal',
    layout: 'left',
    locale: 'en',
  },
  render: (args) => <OgCardPreview {...args} scale={0.72} />,
} satisfies Story;

/** 3つのOGカードレイアウトと言語ごとのカテゴリ表示を一覧できます。 */
export const AllPatterns: Story = {
  args: {
    title: '時間の使い方を、計画と記録から見直す',
    category: 'docs',
    layout: 'center',
    locale: 'ja',
  },
  render: () => (
    <div className="flex flex-col gap-8 p-8">
      <section className="flex flex-wrap gap-6">
        <OgCardPreview
          title="時間の使い方を、計画と記録から見直す"
          category="docs"
          layout="center"
          locale="ja"
          scale={0.36}
        />
        <OgCardPreview
          title="Review your time through plans and records"
          category="docs"
          layout="center"
          locale="en"
          scale={0.36}
        />
      </section>
      <section className="flex flex-wrap gap-6">
        <OgCardPreview
          title="新しい記録と、日々を振り返る時間"
          category="journal"
          layout="left"
          locale="ja"
          scale={0.36}
        />
        <OgCardPreview
          title="A new record, and time to reflect on each day"
          category="journal"
          layout="left"
          locale="en"
          scale={0.36}
        />
      </section>
      <section className="flex flex-wrap gap-6">
        <OgCardPreview
          title="Dayoptで計画と記録をひとつにつなぐ"
          category="product"
          layout="screenshot"
          screenshotSrc={STORYBOOK_SCREENSHOT}
          locale="ja"
          scale={0.36}
        />
        <OgCardPreview
          title="Bring plans and records together with Dayopt"
          category="product"
          layout="screenshot"
          screenshotSrc={STORYBOOK_SCREENSHOT}
          locale="en"
          scale={0.36}
        />
      </section>
      <section className="flex flex-wrap gap-6">
        <OgCardPreview {...ShortTitle.args} scale={0.36} />
        <OgCardPreview {...MixedTitle.args} scale={0.36} />
      </section>
      <section className="flex flex-wrap gap-6">
        <OgCardPreview {...LongJapaneseTitle.args} scale={0.36} />
        <OgCardPreview {...LongEnglishTitle.args} scale={0.36} />
      </section>
      <section className="flex flex-wrap gap-6">
        <OgCardPreview {...LongScreenshotTitle.args} scale={0.36} />
        <OgCardPreview {...Release.args} scale={0.36} />
      </section>
      <section className="flex flex-wrap gap-6">
        <OgCardPreview {...WeekView.args} scale={0.36} />
      </section>
    </div>
  ),
};
