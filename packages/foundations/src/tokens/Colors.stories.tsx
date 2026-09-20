import { useEffect, useRef, useState } from 'react';

import type { Meta, StoryObj } from '@storybook/nextjs-vite';

const meta = {
  title: 'Shared/Foundations/Colors',
  parameters: {
    layout: 'fullscreen',
  },
  tags: ['docs-only'],
} satisfies Meta;

export default meta;
type Story = StoryObj;

/**
 * カラースウォッチコンポーネント
 *
 * Tailwind クラスをそのまま swatch 要素に適用する（bg-* は背景、text-* は
 * 文字サンプル、border-* は太枠）。以前は class 名から `var(--X)` を組み立てて
 * いたため、生 token を持たない state-hover 系が無背景になっていた。
 *
 * oklch 注釈は手書きせず、getComputedStyle の解決値を表示する
 * （手書き注釈が colors.css とのドリフト源だったため。現テーマの値のみ表示）。
 */
function ColorSwatch({
  tailwindClass,
  description,
  on,
}: {
  tailwindClass: string;
  description?: string;
  /** text-* サンプルの下に敷く背景クラス（例: text-*-foreground には accent 面） */
  on?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [resolved, setResolved] = useState('');
  const kind = tailwindClass.startsWith('text-')
    ? 'text'
    : tailwindClass.startsWith('border-')
      ? 'border'
      : 'bg';

  // deps なし: テーマ切替による再レンダー後に解決値を読み直す（同値なら bail out）
  useEffect(() => {
    if (!ref.current) return;
    const style = getComputedStyle(ref.current);
    setResolved(
      kind === 'text'
        ? style.color
        : kind === 'border'
          ? style.borderTopColor
          : style.backgroundColor,
    );
  });

  return (
    <div className="flex items-center gap-4 py-2">
      {kind === 'text' ? (
        <div
          ref={ref}
          className={`${tailwindClass} ${on ?? 'bg-background'} border-border flex size-12 shrink-0 items-center justify-center rounded-lg border text-lg font-medium`}
        >
          Aa
        </div>
      ) : kind === 'border' ? (
        <div
          ref={ref}
          className={`${tailwindClass} bg-background size-12 shrink-0 rounded-lg border-4`}
        />
      ) : (
        <div
          ref={ref}
          className={`${tailwindClass} border-border size-12 shrink-0 rounded-lg border`}
        />
      )}
      <div className="min-w-0 flex-1">
        <code className="text-sm font-medium">{tailwindClass}</code>
        {description && <p className="text-muted-foreground mt-1 text-xs">{description}</p>}
        {resolved && <p className="mt-1 font-mono text-xs opacity-40">{resolved}</p>}
      </div>
    </div>
  );
}

// カラーグループコンポーネント
function ColorGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-8">
      <h2 className="border-border mb-4 border-b pb-2 text-lg font-medium">{title}</h2>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">{children}</div>
    </div>
  );
}

export const AllColors: Story = {
  render: () => (
    <div>
      <h1 className="mb-4 text-2xl font-medium">カラートークン</h1>

      {/* ── 設計原則 ── */}
      <div className="bg-card border-border mb-8 rounded-lg border p-6">
        <h2 className="mb-4 text-lg font-medium">設計原則</h2>
        <p className="text-muted-foreground mb-4 text-sm">
          oklch(L C H) の3軸がそれぞれ1つの役割を持つ。
        </p>
        <div className="mb-4 space-y-1 font-mono text-sm">
          <div>
            <span className="text-muted-foreground">L軸</span> = 空間（浮く/沈む）
          </div>
          <div>
            <span className="text-muted-foreground">H軸</span> = 意味（blue=primary, amber=warning,
            green=success, red=destructive）
          </div>
          <div>
            <span className="text-muted-foreground">C軸</span> = 強度（tint=薄い, accent=強い）
          </div>
        </div>
        <div className="text-muted-foreground space-y-1 text-xs">
          <p>
            <span className="text-foreground font-medium">判断フロー:</span> 1. この面はどこ？→
            Surface（4択） 2. 色で意味を伝える？→ No なら neutral で終了 3. どの強さ？→ tint /
            accent
          </p>
          <p>
            <span className="text-foreground font-medium">Light:</span> Surface — 紙 warm H75
            C0.005。card も純白ではない（L0.99）。インク（テキスト）は無彩色のまま
          </p>
          <p>
            <span className="text-foreground font-medium">Dark:</span> Surface — warm H60 C0.008。
            テキストはオフホワイト L0.90（純白にしない）。Border — alpha-based（black/α, white/α）
          </p>
        </div>
      </div>

      {/* ━━ 1. Neutral ━━ */}
      <h2 className="text-muted-foreground mb-6 text-xs font-medium tracking-widest uppercase">
        1. Neutral — 9割のUIはここで完結
      </h2>

      <ColorGroup title="Surface">
        <ColorSwatch tailwindClass="bg-container" description="沈む: sidebar, footer" />
        <ColorSwatch tailwindClass="bg-background" description="基準: page" />
        <ColorSwatch tailwindClass="bg-card" description="浮く: card, dialog" />
        <ColorSwatch tailwindClass="bg-muted" description="窪み: input, well" />
        <ColorSwatch tailwindClass="bg-overlay" description="scrim: modal背景" />
      </ColorGroup>

      <ColorGroup title="Text">
        <ColorSwatch tailwindClass="text-foreground" description="主要" />
        <ColorSwatch tailwindClass="text-muted-foreground" description="補助" />
      </ColorGroup>

      <ColorGroup title="Border">
        <ColorSwatch
          tailwindClass="border-border"
          description="構造的な区切り（sidebar, input, divider）"
        />
        <ColorSwatch
          tailwindClass="border-border-subtle"
          description="Raised/Overlayの縁（card, dialog, popover）"
        />
      </ColorGroup>

      {/* ━━ 2. Semantic ━━ */}
      <h2 className="text-muted-foreground mt-8 mb-6 text-xs font-medium tracking-widest uppercase">
        2. Semantic — 意味があるときだけ
      </h2>
      <p className="text-muted-foreground -mt-4 mb-6 text-xs">
        destructive/warning/success は同じ L/C 構造で H だけ変化。info は neutral（低彩度）。
      </p>

      <ColorGroup title="Destructive (H25)">
        <ColorSwatch tailwindClass="bg-destructive-tint" description="tint" />
        <ColorSwatch tailwindClass="bg-destructive" description="accent" />
        <ColorSwatch
          tailwindClass="text-destructive-foreground"
          description="accent面上の文字"
          on="bg-destructive"
        />
      </ColorGroup>

      <ColorGroup title="Warning (H70)">
        <ColorSwatch tailwindClass="bg-warning-tint" description="tint" />
        <ColorSwatch tailwindClass="bg-warning" description="accent" />
        <ColorSwatch
          tailwindClass="text-warning-foreground"
          description="accent面上の文字"
          on="bg-warning"
        />
      </ColorGroup>

      <ColorGroup title="Success (H150)">
        <ColorSwatch tailwindClass="bg-success-tint" description="tint" />
        <ColorSwatch tailwindClass="bg-success" description="accent" />
        <ColorSwatch
          tailwindClass="text-success-foreground"
          description="accent面上の文字"
          on="bg-success"
        />
      </ColorGroup>

      <ColorGroup title="Info (neutral)">
        <ColorSwatch tailwindClass="bg-info-tint" description="tint（neutral）" />
        <ColorSwatch tailwindClass="bg-info" description="accent（neutral）" />
        <ColorSwatch
          tailwindClass="text-info-foreground"
          description="accent面上の文字"
          on="bg-info"
        />
      </ColorGroup>

      {/* ━━ 3. Primary ━━ */}
      <h2 className="text-muted-foreground mt-8 mb-6 text-xs font-medium tracking-widest uppercase">
        3. Primary — ブランドアクション
      </h2>
      <p className="text-muted-foreground -mt-4 mb-6 text-xs">
        紺（インク）。色相は --hue-brand 259.8145 で固定し、明度と彩度だけで調整する。
      </p>

      <ColorGroup title="Primary">
        <ColorSwatch tailwindClass="bg-primary" description="主要アクションの背景" />
        <ColorSwatch tailwindClass="text-primary-text" description="リンク・選択文字" />
        <ColorSwatch
          tailwindClass="text-primary-foreground"
          description="Primary上のテキスト"
          on="bg-primary"
        />
      </ColorGroup>

      {/* ━━ 4. State ━━ */}
      <h2 className="text-muted-foreground mt-8 mb-6 text-xs font-medium tracking-widest uppercase">
        4. State — インタラクション
      </h2>
      <p className="text-muted-foreground -mt-4 mb-6 text-xs">
        foreground ベースの半透明オーバーレイ。oklch(from var(--foreground) l c h / α%)。
      </p>

      <ColorGroup title="State Layer（半透明）">
        <ColorSwatch tailwindClass="bg-state-hover" description="hover" />
        <ColorSwatch tailwindClass="bg-state-pressed" description="pressed" />
        <ColorSwatch tailwindClass="bg-state-selected" description="selected" />
        <ColorSwatch tailwindClass="bg-state-dragged" description="dragged" />
      </ColorGroup>

      <ColorGroup title="State Active（塗りつぶし）">
        <ColorSwatch tailwindClass="bg-state-active" description="選択中" />
        <ColorSwatch
          tailwindClass="text-state-active-foreground"
          description="アクティブ状態テキスト"
          on="bg-state-active"
        />
      </ColorGroup>

      <ColorGroup title="塗りボタン用ホバー（accent / 90%）">
        <ColorSwatch tailwindClass="bg-primary-hover" description="primary" />
        <ColorSwatch tailwindClass="bg-destructive-hover" description="destructive" />
        <ColorSwatch tailwindClass="bg-warning-hover" description="warning" />
        <ColorSwatch tailwindClass="bg-success-hover" description="success" />
        <ColorSwatch tailwindClass="bg-info-hover" description="info" />
      </ColorGroup>

      {/* ━━ 5. Domain ━━ */}
      <h2 className="text-muted-foreground mt-8 mb-6 text-xs font-medium tracking-widest uppercase">
        5. Domain — Dayopt 固有
      </h2>

      <ColorGroup title="Category Colors（oklch統一 L/C、Hのみ変化）">
        {/* Base: L=0.65 C=0.18 / Dark: L=0.78 C=0.15（例外: teal, gray） */}
        {/* Tailwind 静的抽出用 safelist（下の bg-category-${name} は動的クラスのため）:
            bg-category-red bg-category-orange bg-category-amber bg-category-green bg-category-teal
            bg-category-blue bg-category-indigo bg-category-violet bg-category-pink bg-category-gray */}
        {[
          { name: 'red', hue: 25 },
          { name: 'orange', hue: 55 },
          { name: 'amber', hue: 80 },
          { name: 'green', hue: 145 },
          { name: 'teal', hue: 185, note: 'sRGB色域制限' },
          { name: 'blue', hue: 240, note: 'デフォルト' },
          { name: 'indigo', hue: 280 },
          { name: 'violet', hue: 310 },
          { name: 'pink', hue: 350 },
          { name: 'gray', hue: 250, note: 'achromatic' },
        ].map(({ name, note }) => (
          <ColorSwatch
            key={name}
            tailwindClass={`bg-category-${name}`}
            description={`${name}${note ? `（${note}）` : ''}`}
          />
        ))}
      </ColorGroup>

      <ColorGroup title="Temporal（現在時刻）">
        <ColorSwatch tailwindClass="bg-now-indicator" description="now line, now 時刻バッジ背景" />
        <ColorSwatch tailwindClass="bg-now-indicator-foreground" description="foreground" />
        <ColorSwatch tailwindClass="bg-now-indicator-muted" description="other days line" />
      </ColorGroup>

      <ColorGroup title="Chart（比較用5色）">
        <ColorSwatch tailwindClass="bg-chart-1" />
        <ColorSwatch tailwindClass="bg-chart-2" />
        <ColorSwatch tailwindClass="bg-chart-3" />
        <ColorSwatch tailwindClass="bg-chart-4" />
        <ColorSwatch tailwindClass="bg-chart-5" />
      </ColorGroup>

      {/* ━━ 6. Aliases ━━ */}
      <h2 className="text-muted-foreground mt-8 mb-6 text-xs font-medium tracking-widest uppercase">
        6. Aliases — shadcn/ui 互換
      </h2>

      <ColorGroup title="Aliases">
        <ColorSwatch tailwindClass="bg-secondary" description="= bg-container" />
        <ColorSwatch tailwindClass="bg-accent" description="= bg-state-active" />
        <ColorSwatch tailwindClass="text-card-foreground" description="= text-foreground" />
      </ColorGroup>
    </div>
  ),
};

export const Surface: Story = {
  render: () => {
    const surfaces = [
      {
        token: 'container',
        role: '沈む',
        desc: 'サイドバー、セクション',
        light: 'oklch(0.95 0.005 75)',
        dark: 'oklch(0.15 0.008 60)',
        bg: 'bg-container',
      },
      {
        token: 'background',
        role: '基準',
        desc: 'ページ背景',
        light: 'oklch(0.97 0.005 75)',
        dark: 'oklch(0.18 0.008 60)',
        bg: 'bg-background',
      },
      {
        token: 'card',
        role: '浮く',
        desc: 'カード、ダイアログ',
        light: 'oklch(0.99 0.005 75)',
        dark: 'oklch(0.22 0.008 60)',
        bg: 'bg-card',
      },
    ] as const;

    const texts = [
      {
        token: 'foreground',
        role: '主要テキスト',
        light: 'oklch(0.13 0 0)',
        dark: 'oklch(0.90 0.005 70)',
      },
      {
        token: 'muted-foreground',
        role: '補助テキスト',
        light: 'oklch(0.40 0 0)',
        dark: 'oklch(0.68 0.005 60)',
      },
    ] as const;

    const shadowValues = {
      sm: {
        light: '0 0 0 1px oklch(0 0 0/0.03), 0 1px 3px oklch(0 0 0/0.03)',
        dark: '0 0 0 1px oklch(1 0 0/0.03), 0 1px 4px oklch(0 0 0/0.18)',
      },
      card: {
        light:
          '0 0 0 1px oklch(0 0 0/0.03), 0 1px 2px oklch(0 0 0/0.04), 0 4px 16px oklch(0 0 0/0.05)',
        dark: '0 0 0 1px oklch(1 0 0/0.04), 0 2px 8px oklch(0 0 0/0.25)',
      },
    } as const;

    return (
      <div>
        <h2 className="mb-2 text-xl font-medium">Surface 体系</h2>
        <p className="text-muted-foreground mb-1 text-sm">
          container(沈む) → background(基準) → card(浮く) + muted。Light は「紙」warm H75 C=0.005、
          Dark は warm H60 C=0.008。4面すべてが同じ温度を持つ。
        </p>
        <p className="text-muted-foreground mb-1 text-sm">
          card は純白ではない（L=0.99）。L=1.00 では chroma を持てないため、card だけ純白に残すと
          4面のうち1面で色温度が割れる。
        </p>
        <p className="text-muted-foreground mb-8 text-sm">
          テキストは純白にしない（dark foreground L=0.90 オフホワイト, C=0.005, H=70）。
        </p>

        {/* ── Elevation bar: 左=暗い → 右=明るい ── */}
        <h3 className="mb-4 font-medium">Elevation（左:沈む → 右:浮く）</h3>
        <p className="text-muted-foreground mb-2 text-xs">
          Storybook ツールバーの 🌙 で Light/Dark を切り替えると全プレビューが連動します。
        </p>
        <div className="mb-2 flex gap-0 overflow-hidden rounded-lg">
          {surfaces.map(({ token, bg, role }) => (
            <div
              key={token}
              className={`${bg} flex flex-1 flex-col items-center justify-center py-8`}
            >
              <div className="text-foreground text-sm font-medium">{token}</div>
              <div className="text-muted-foreground text-xs">← {role}</div>
            </div>
          ))}
        </div>
        <div className="mb-8 flex overflow-hidden rounded-lg">
          <div className="bg-muted flex flex-1 flex-col items-center justify-center py-4">
            <div className="text-foreground text-sm font-medium">muted</div>
            <div className="text-muted-foreground text-xs">入力欄・well</div>
          </div>
        </div>

        {/* ── App Layout Preview ── */}
        <h3 className="mb-4 font-medium">Preview</h3>
        <div
          className="bg-background border-border mb-8 grid overflow-hidden rounded-lg border"
          style={{ gridTemplateColumns: '80px 1fr', height: 200 }}
        >
          <div
            className="bg-container flex flex-col gap-1 border-r p-2"
            style={{ borderColor: 'var(--border)' }}
          >
            <div className="bg-foreground h-1.5 w-4/5 rounded-lg opacity-25" />
            <div className="bg-foreground h-1.5 w-3/5 rounded-lg opacity-25" />
            <div className="bg-foreground h-1.5 w-2/3 rounded-lg opacity-25" />
          </div>
          <div className="flex flex-col gap-2 p-4">
            <div
              className="bg-card flex flex-1 flex-col gap-2 rounded-lg p-4"
              style={{ boxShadow: 'var(--shadow-card)' }}
            >
              <div className="bg-foreground h-1.5 w-3/4 rounded-lg opacity-15" />
              <div className="bg-foreground h-1.5 w-1/2 rounded-lg opacity-15" />
              <div className="bg-muted h-7 rounded-lg" />
            </div>
          </div>
        </div>

        {/* ── Spec Tables ── */}
        <h3 className="mb-4 font-medium">Surface</h3>
        <div className="bg-card border-border mb-6 overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-border border-b">
                <th className="px-4 py-2 text-left text-xs font-medium">Token</th>
                <th className="px-4 py-2 text-left text-xs font-medium">Light</th>
                <th className="px-4 py-2 text-left text-xs font-medium">Dark (H60 C.008)</th>
                <th className="px-4 py-2 text-left text-xs font-medium">役割</th>
              </tr>
            </thead>
            <tbody className="text-muted-foreground">
              {[
                ...surfaces,
                {
                  token: 'muted',
                  role: '控えめ',
                  desc: '入力欄',
                  light: 'oklch(0.94 0.005 75)',
                  dark: 'oklch(0.25 0.008 60)',
                  bg: 'bg-muted',
                },
              ].map(({ token, light, dark, role, bg }) => (
                <tr key={token} className="border-border border-b">
                  <td className="px-4 py-2">
                    <div className="flex items-center gap-2">
                      <div className={`${bg} border-border size-5 shrink-0 rounded-lg border`} />
                      <code className="text-foreground text-xs">{token}</code>
                    </div>
                  </td>
                  <td className="px-4 py-2 font-mono text-xs">{light}</td>
                  <td className="px-4 py-2 font-mono text-xs">{dark}</td>
                  <td className="px-4 py-2 text-xs">← {role}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <h3 className="mb-4 font-medium">Text</h3>
        <div className="bg-card border-border mb-6 overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-border border-b">
                <th className="px-4 py-2 text-left text-xs font-medium">Token</th>
                <th className="px-4 py-2 text-left text-xs font-medium">Light</th>
                <th className="px-4 py-2 text-left text-xs font-medium">Dark</th>
                <th className="px-4 py-2 text-left text-xs font-medium">役割</th>
              </tr>
            </thead>
            <tbody className="text-muted-foreground">
              {texts.map(({ token, light, dark, role }) => (
                <tr key={token} className="border-border border-b">
                  <td className="px-4 py-2">
                    <code className="text-foreground text-xs">{token}</code>
                  </td>
                  <td className="px-4 py-2 font-mono text-xs">{light}</td>
                  <td className="px-4 py-2 font-mono text-xs">{dark}</td>
                  <td className="px-4 py-2 text-xs">{role}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Border + Shadow (visual + values) */}
        <h3 className="mb-4 font-medium">Border / Shadow</h3>
        <div className="bg-card border-border mb-2 overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-border border-b">
                <th className="px-4 py-2 text-left text-xs font-medium">Token</th>
                <th className="px-4 py-2 text-left text-xs font-medium">Light</th>
                <th className="px-4 py-2 text-left text-xs font-medium">Dark</th>
              </tr>
            </thead>
            <tbody className="text-muted-foreground">
              <tr className="border-border border-b">
                <td className="px-4 py-2">
                  <code className="text-foreground text-xs">border</code>
                </td>
                <td className="px-4 py-2 font-mono text-xs">oklch(0 0 0 / 0.06)</td>
                <td className="px-4 py-2 font-mono text-xs">oklch(1 0 0 / 0.07)</td>
              </tr>
              <tr className="border-border border-b">
                <td className="px-4 py-2">
                  <code className="text-foreground text-xs">shadow-sm</code>
                </td>
                <td className="px-4 py-2">
                  <div
                    className="bg-card inline-block size-8 rounded-lg"
                    style={{ boxShadow: 'var(--shadow-sm)' }}
                  />
                </td>
                <td className="px-4 py-2">
                  <div
                    className="bg-card inline-block size-8 rounded-lg"
                    style={{ boxShadow: 'var(--shadow-sm)' }}
                  />
                </td>
              </tr>
              <tr className="border-border border-b">
                <td className="px-4 py-2">
                  <code className="text-foreground text-xs">shadow-card</code>
                </td>
                <td className="px-4 py-2">
                  <div
                    className="bg-card inline-block size-8 rounded-lg"
                    style={{ boxShadow: 'var(--shadow-card)' }}
                  />
                </td>
                <td className="px-4 py-2">
                  <div
                    className="bg-card inline-block size-8 rounded-lg"
                    style={{ boxShadow: 'var(--shadow-card)' }}
                  />
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <details className="text-muted-foreground mb-6 text-xs">
          <summary className="cursor-pointer py-2 font-medium">Shadow コピペ用 oklch 値</summary>
          <div className="bg-card border-border mt-2 space-y-4 rounded-lg border p-4 font-mono">
            <div>
              <div className="text-foreground mb-1 font-sans text-xs font-medium">
                shadow-sm (light)
              </div>
              <div className="break-all">{shadowValues.sm.light}</div>
            </div>
            <div>
              <div className="text-foreground mb-1 font-sans text-xs font-medium">
                shadow-sm (dark)
              </div>
              <div className="break-all">{shadowValues.sm.dark}</div>
            </div>
            <div>
              <div className="text-foreground mb-1 font-sans text-xs font-medium">
                shadow-card (light)
              </div>
              <div className="break-all">{shadowValues.card.light}</div>
            </div>
            <div>
              <div className="text-foreground mb-1 font-sans text-xs font-medium">
                shadow-card (dark)
              </div>
              <div className="break-all">{shadowValues.card.dark}</div>
            </div>
          </div>
        </details>
      </div>
    );
  },
};

export const Semantic: Story = {
  render: () => {
    const semanticColors = [
      {
        name: 'Destructive',
        hue: 25,
        bg: 'bg-destructive',
        bgTint: 'bg-destructive-tint',
        text: 'text-destructive',
        fg: 'text-destructive-foreground',
        desc: '削除、エラー',
        lightAccent: 'oklch(0.54 0.18 25)',
        lightBg: 'oklch(0.96 0.015 25)',
        darkAccent: 'oklch(0.65 0.14 25)',
        darkBg: 'oklch(0.22 0.03 25)',
      },
      {
        name: 'Warning',
        hue: 70,
        bg: 'bg-warning',
        bgTint: 'bg-warning-tint',
        text: 'text-warning',
        fg: 'text-warning-foreground',
        desc: '警告、注意',
        lightAccent: 'oklch(0.55 0.16 70)',
        lightBg: 'oklch(0.97 0.015 70)',
        darkAccent: 'oklch(0.72 0.14 70)',
        darkBg: 'oklch(0.22 0.03 70)',
      },
      {
        name: 'Success',
        hue: 150,
        bg: 'bg-success',
        bgTint: 'bg-success-tint',
        text: 'text-success',
        fg: 'text-success-foreground',
        desc: '成功、完了',
        lightAccent: 'oklch(0.5 0.15 150)',
        lightBg: 'oklch(0.95 0.02 150)',
        darkAccent: 'oklch(0.65 0.12 150)',
        darkBg: 'oklch(0.22 0.03 150)',
      },
      {
        name: 'Info',
        hue: 'neutral',
        bg: 'bg-info',
        bgTint: 'bg-info-tint',
        text: 'text-info',
        fg: 'text-info-foreground',
        desc: '情報（neutral）',
        lightAccent: 'oklch(0.55 0.02 260)',
        lightBg: 'oklch(0.96 0.005 260)',
        darkAccent: 'oklch(0.65 0.02 260)',
        darkBg: 'oklch(0.22 0.01 260)',
      },
    ] as const;

    return (
      <div>
        <h2 className="mb-2 text-xl font-medium">Semantic Colors（bg + accent 体系）</h2>
        <p className="text-muted-foreground mb-6 text-sm">
          destructive/warning/success は同じ L/C 構造で hue のみ変化。info は
          neutral（低彩度）。accent(テキスト・アイコン用) + tint(薄い背景用) の2トークン体系。
        </p>

        {/* accent + bg tint swatches */}
        <div className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-4">
          {semanticColors.map(({ name, bg, bgTint, fg, desc }) => (
            <div key={name} className="border-border rounded-lg border p-4">
              <div className={`${bg} mb-2 flex h-10 items-center justify-center rounded-lg`}>
                <span className={`${fg} text-sm font-medium`}>accent</span>
              </div>
              <div className={`${bgTint} mb-2 flex h-10 items-center justify-center rounded-lg`}>
                <span className="text-foreground text-sm">bg</span>
              </div>
              <div className="text-foreground text-center font-medium">{name}</div>
              <div className="text-muted-foreground text-center text-xs">{desc}</div>
            </div>
          ))}
        </div>

        {/* oklch spec table */}
        <h3 className="mb-4 font-medium">oklch 値</h3>
        <div className="bg-card border-border mb-6 overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-border border-b">
                <th className="px-4 py-2 text-left text-xs font-medium">色</th>
                <th className="px-4 py-2 text-left text-xs font-medium">Hue</th>
                <th className="px-4 py-2 text-left text-xs font-medium">Light accent</th>
                <th className="px-4 py-2 text-left text-xs font-medium">Light bg</th>
                <th className="px-4 py-2 text-left text-xs font-medium">Dark accent</th>
                <th className="px-4 py-2 text-left text-xs font-medium">Dark bg</th>
              </tr>
            </thead>
            <tbody className="text-muted-foreground">
              {semanticColors.map(({ name, hue, lightAccent, lightBg, darkAccent, darkBg }) => (
                <tr key={name} className="border-border border-b">
                  <td className="text-foreground px-4 py-2 text-xs font-medium">{name}</td>
                  <td className="px-4 py-2 font-mono text-xs">{hue}</td>
                  <td className="px-4 py-2 font-mono text-xs">{lightAccent}</td>
                  <td className="px-4 py-2 font-mono text-xs">{lightBg}</td>
                  <td className="px-4 py-2 font-mono text-xs">{darkAccent}</td>
                  <td className="px-4 py-2 font-mono text-xs">{darkBg}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* テキスト on Surface（コントラストチェック） */}
        <h3 className="mb-4 text-lg font-medium">text-* on Surface</h3>
        <p className="text-muted-foreground mb-4 text-sm">
          badge outline 等で使われるパターン。card / background 上で 4.5:1+ を確保。
        </p>
        <div className="mb-8 grid grid-cols-1 gap-4 md:grid-cols-2">
          {semanticColors.map(({ name, text }) => (
            <div key={name} className="border-border flex gap-4 rounded-lg border p-4">
              <div className="bg-card flex flex-1 items-center justify-center rounded-lg p-4">
                <span className={`${text} font-medium`}>{name} on card</span>
              </div>
              <div className="bg-background flex flex-1 items-center justify-center rounded-lg p-4">
                <span className={`${text} font-medium`}>{name} on bg</span>
              </div>
            </div>
          ))}
        </div>

        {/* foreground 反転の説明 */}
        <div className="bg-card border-border rounded-lg border p-6">
          <h3 className="mb-2 font-medium">ダークモードの foreground 反転</h3>
          <p className="text-muted-foreground text-sm">
            ダークモードではセマンティックカラーの明度が上がるため、
            <code className="bg-container rounded-lg px-1">text-*-foreground</code>{' '}
            が白→ダーク文字に自動反転。 コンポーネント側の変更は不要。
          </p>
        </div>
      </div>
    );
  },
};

export const Text: Story = {
  render: () => {
    const neutralTexts = [
      {
        token: 'text-foreground',
        cls: 'text-foreground',
        label: '主要（見出し、本文）',
        light: 'oklch(0.13 0 0)',
        dark: 'oklch(0.90 0.005 70)',
      },
      {
        token: 'text-muted-foreground',
        cls: 'text-muted-foreground',
        label: '補助（説明、キャプション）',
        light: 'oklch(0.40 0 0)',
        dark: 'oklch(0.68 0.005 60)',
      },
    ] as const;

    const semanticTexts = [
      { token: 'text-primary-text', cls: 'text-primary-text', label: 'リンク、アクション' },
      { token: 'text-destructive', cls: 'text-destructive', label: 'エラー H25' },
      { token: 'text-warning', cls: 'text-warning', label: '警告 H70' },
      { token: 'text-success', cls: 'text-success', label: '成功 H150' },
      { token: 'text-info', cls: 'text-info', label: '情報 H260' },
    ] as const;

    return (
      <div>
        <h1 className="mb-2 text-2xl font-medium">テキストカラー</h1>
        <p className="text-muted-foreground mb-2 text-sm">
          Neutral 2段階で9割のUIが完結。Semantic は意味があるときだけ。
        </p>
        <p className="text-muted-foreground mb-8 text-sm">
          Dark: 純白にしない（L=0.90 オフホワイト, C=0.005, H=70）。
        </p>

        {/* ── Hierarchy bar ── */}
        <h3 className="mb-4 font-medium">Hierarchy（左:主要 → 右:補助）</h3>
        <div className="bg-background border-border mb-8 flex overflow-hidden rounded-lg border">
          <div className="flex flex-1 flex-col items-center justify-center py-8">
            <span className="text-foreground text-lg font-medium">foreground</span>
            <span className="text-foreground text-sm">主要テキスト</span>
          </div>
          <div className="flex flex-1 flex-col items-center justify-center py-8">
            <span className="text-muted-foreground text-lg font-medium">muted-foreground</span>
            <span className="text-muted-foreground text-sm">補助テキスト</span>
          </div>
        </div>

        {/* ── Contrast check: on card / on background ── */}
        <h3 className="mb-4 font-medium">コントラスト確認</h3>
        <p className="text-muted-foreground mb-2 text-xs">
          Storybook ツールバーの 🌙 で Light/Dark を切り替えて確認。
        </p>
        <div className="mb-8 grid grid-cols-2 gap-4">
          <div className="bg-card rounded-lg p-6" style={{ boxShadow: 'var(--shadow-card)' }}>
            <div className="text-muted-foreground mb-1 text-xs">on card</div>
            <p className="text-foreground text-sm font-medium">foreground — 見出しや本文に使用</p>
            <p className="text-muted-foreground mt-2 text-sm">
              muted-foreground — 説明文やキャプション
            </p>
          </div>
          <div className="bg-background border-border rounded-lg border p-6">
            <div className="text-muted-foreground mb-1 text-xs">on background</div>
            <p className="text-foreground text-sm font-medium">foreground — 見出しや本文に使用</p>
            <p className="text-muted-foreground mt-2 text-sm">
              muted-foreground — 説明文やキャプション
            </p>
          </div>
        </div>

        {/* ── Spec table: Neutral ── */}
        <h3 className="mb-4 font-medium">Neutral</h3>
        <div className="bg-card border-border mb-6 overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-border border-b">
                <th className="px-4 py-2 text-left text-xs font-medium">Token</th>
                <th className="px-4 py-2 text-left text-xs font-medium">Light</th>
                <th className="px-4 py-2 text-left text-xs font-medium">Dark</th>
                <th className="px-4 py-2 text-left text-xs font-medium">役割</th>
              </tr>
            </thead>
            <tbody className="text-muted-foreground">
              {neutralTexts.map(({ token, cls, light, dark, label }) => (
                <tr key={token} className="border-border border-b">
                  <td className="px-4 py-2">
                    <div className="flex items-center gap-2">
                      <div className={`${cls} size-4 shrink-0 rounded-full bg-current`} />
                      <code className="text-foreground text-xs">{token}</code>
                    </div>
                  </td>
                  <td className="px-4 py-2 font-mono text-xs">{light}</td>
                  <td className="px-4 py-2 font-mono text-xs">{dark}</td>
                  <td className="px-4 py-2 text-xs">{label}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* ── Spec table: Semantic ── */}
        <h3 className="mb-4 font-medium">Semantic（意味があるときだけ）</h3>
        <p className="text-muted-foreground mb-2 text-xs">
          値は Color &gt; Semantic の accent と同じ。text-* と bg-* が同一トークンを参照。
        </p>
        <div className="bg-card border-border mb-6 rounded-lg border">
          <div className="grid grid-cols-2 gap-4 p-4 md:grid-cols-5">
            {semanticTexts.map(({ token, cls, label }) => (
              <div key={token} className="flex flex-col items-center gap-2">
                <div
                  className={`${cls} bg-background border-border flex size-12 items-center justify-center rounded-lg border text-lg font-medium`}
                >
                  Aa
                </div>
                <code className="text-xs">{token.replace('text-', '')}</code>
                <span className="text-muted-foreground text-xs">{label}</span>
              </div>
            ))}
          </div>
        </div>

        {/* ── Usage guide ── */}
        <h3 className="mb-4 font-medium">使い分けガイド</h3>
        <div className="bg-card border-border rounded-lg border p-6">
          <div className="grid gap-6 md:grid-cols-2">
            <div className="border-success space-y-2 border-l-4 pl-4">
              <p className="text-success font-medium">Do</p>
              <pre className="text-muted-foreground text-xs leading-relaxed">{`// 主要テキスト
<h1 className="text-foreground">見出し</h1>

// 補助テキスト
<p className="text-muted-foreground">説明</p>

// リンク
<a className="text-primary-text">リンク</a>

// エラーメッセージ
<p className="text-destructive">入力エラー</p>`}</pre>
            </div>
            <div className="border-destructive space-y-2 border-l-4 pl-4">
              <p className="text-destructive font-medium">Don&apos;t</p>
              {/* 表示テキストにマーカーを混ぜないため、禁止例の行だけ配列へ出して行単位で許可する */}
              <pre className="text-muted-foreground text-xs leading-relaxed">
                {[
                  '// ❌ 直接カラー',
                  '<h1 className="text-gray-900">見出し</h1>', // lint-tokens-allow: 禁止例の提示
                  '',
                  '// ❌ opacity で階層を作る',
                  '<p className="text-foreground opacity-50">説明</p>',
                  '',
                  '// ❌ 意味なく semantic を使う',
                  '<p className="text-success">普通のテキスト</p>',
                ].join('\n')}
              </pre>
            </div>
          </div>
        </div>
      </div>
    );
  },
};

export const Tags: Story = {
  render: () => {
    const tags: ReadonlyArray<{ name: string; hue: number; note?: string }> = [
      { name: 'blue', hue: 240, note: 'デフォルト' },
      { name: 'green', hue: 145 },
      { name: 'red', hue: 25 },
      { name: 'amber', hue: 80 },
      { name: 'violet', hue: 310 },
      { name: 'pink', hue: 350 },
      { name: 'teal', hue: 185, note: 'C=0.13（sRGB色域制限）' },
      { name: 'orange', hue: 55 },
      { name: 'gray', hue: 250, note: 'achromatic C=0.02' },
      { name: 'indigo', hue: 280 },
    ];

    return (
      <div>
        <h1 className="mb-2 text-2xl font-medium">タグカラー</h1>
        <p className="text-muted-foreground mb-2 text-sm">
          ユーザーがタグに設定できる10色。oklch 統一 L/C で Hue のみ変化。
        </p>
        <p className="text-muted-foreground mb-8 text-sm">
          Light: L=0.65 C=0.18 → Dark: L=0.78 C=0.15（明度+0.13, 彩度-0.03）。
        </p>

        {/* ── Base + Tint 並列表示 ── */}
        <h3 className="mb-4 font-medium">Base / Tint 一覧</h3>
        <div className="bg-card border-border mb-6 overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-border border-b">
                <th className="px-4 py-2 text-left text-xs font-medium">色</th>
                <th className="px-4 py-2 text-left text-xs font-medium">Base</th>
                <th className="px-4 py-2 text-left text-xs font-medium">Tint</th>
                <th className="px-4 py-2 text-left text-xs font-medium">Hue</th>
                <th className="px-4 py-2 text-left text-xs font-medium">Light base</th>
                <th className="px-4 py-2 text-left text-xs font-medium">Dark base</th>
              </tr>
            </thead>
            <tbody className="text-muted-foreground">
              {tags.map(({ name, hue, note }) => (
                <tr key={name} className="border-border border-b">
                  <td className="px-4 py-2 text-xs font-medium capitalize">{name}</td>
                  <td className="px-4 py-2">
                    <div
                      className="size-6 rounded-lg"
                      style={{ backgroundColor: `var(--category-${name})` }}
                    />
                  </td>
                  <td className="px-4 py-2">
                    <div
                      className="border-border size-6 rounded-lg border"
                      style={{ backgroundColor: `var(--category-${name}-tint)` }}
                    />
                  </td>
                  <td className="px-4 py-2 font-mono text-xs">
                    {hue}
                    {note && (
                      <span className="text-muted-foreground ml-1 font-sans text-xs">{note}</span>
                    )}
                  </td>
                  <td className="px-4 py-2 font-mono text-xs">
                    oklch(0.65 {name === 'teal' ? '0.13' : name === 'gray' ? '0.02' : '0.18'} {hue})
                  </td>
                  <td className="px-4 py-2 font-mono text-xs">
                    oklch(0.78 {name === 'teal' ? '0.11' : name === 'gray' ? '0.02' : '0.15'} {hue})
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* ── Tint 構造 ── */}
        <h3 className="mb-4 font-medium">Tint（EntryCard 背景色）</h3>
        <p className="text-muted-foreground mb-2 text-xs">
          Light: L=0.92 C=0.05。Dark: L=0.28 C=0.06（低明度でも色味を識別可能）。
        </p>
        <div className="mb-8 flex flex-wrap gap-2">
          {tags.map(({ name }) => (
            <div
              key={name}
              className="border-border flex h-16 w-20 flex-col items-center justify-center rounded-lg border"
              style={{ backgroundColor: `var(--category-${name}-tint)` }}
            >
              <span className="text-foreground text-xs font-medium">{name}</span>
              <span className="text-muted-foreground text-xs">tint</span>
            </div>
          ))}
        </div>

        {/* ── 使用例 ── */}
        <h3 className="mb-4 font-medium">使用例</h3>
        <div className="bg-card border-border rounded-lg border p-6">
          <div className="mb-4 flex flex-wrap gap-2">
            {tags.map(({ name }) => (
              <span
                key={name}
                className="rounded-full border px-2 py-1 text-sm capitalize"
                style={{ borderColor: `var(--category-${name})`, color: `var(--category-${name})` }}
              >
                {name}
              </span>
            ))}
          </div>
          <p className="text-muted-foreground text-xs">
            <code>border-category-*</code> + <code>text-category-*</code> でアウトラインバッジ。
            EntryCard 背景は <code>bg-category-*-tint</code>。
          </p>
        </div>
      </div>
    );
  },
};

export const DosDonts: Story = {
  render: () => {
    const rules = [
      {
        title: '1. セマンティックトークンを使う',
        doCode: 'bg-destructive text-destructive-foreground',
        dontCode: 'bg-red-500 text-white', // lint-tokens-allow: 禁止例の提示
        reason:
          'oklch の値を直接書かない。トークン経由で使う。直接指定するとダークモード切替、将来の色調整が全部壊れる。',
      },
      {
        title: '2. Surface の階層を守る',
        doCode: 'container(沈む) → background(基準) → card(浮く)',
        dontCode: 'card の中に background、background の中に card',
        reason:
          '判断基準: ユーザーの目がそこに行くべきか？ 行くべき → card（浮かせる）。行かなくていい → container / muted（沈める）。',
      },
      {
        title: '3. 色は意味があるときだけつける',
        doCode: 'ほとんどのUIは neutral（surface + text-foreground）で完結',
        dontCode: '意味なく色をつけて画面をカラフルにする',
        reason:
          '色を足す前に「これを灰色にしたら情報が失われるか？」と問う。失われないなら neutral のまま。9割のUIは Step 1 で終わる。',
      },
      {
        title: '4. Semantic の色と意味を一致させる',
        doCode: '成功→green、エラー→red、警告→amber、情報→blue',
        dontCode: '成功を青で、エラーを黄色で表示',
        reason: '色の意味が揺れると、ユーザーが毎回「この色は何？」と考える負荷が発生する。',
      },
      {
        title: '5. 色だけで情報を伝えない',
        doCode: '<CheckCircle /> 完了 — 色+アイコン+テキストの三重伝達',
        dontCode: '<span className="text-success">完了</span> — 色だけ',
        reason: 'WCAG 1.4.1: 色を唯一の視覚的手段にしない。色覚多様性のユーザーが識別できない。',
      },
      {
        title: '6. テキストコントラストを確保する',
        doCode: 'text-foreground on bg-card\ntext-primary-foreground on bg-primary',
        dontCode: 'text-muted-foreground on bg-primary\nopacity-50 のテキスト',
        reason:
          'WCAG AA: コントラスト比 4.5:1 以上。Dark のテキストは L=0.90（オフホワイト）なので暗い背景との比率を確認する。',
      },
      {
        title: '7. Semantic の強度を用途に合わせる',
        doCode: '背景にうっすら → bg-info-tint\nはっきり → bg-info\nテキスト → text-info',
        dontCode: 'accent（bg-info）をセクション全体の背景に\ntint（bg-info-tint）をボタンに',
        reason: '薄い色を広い面に、強い色を小さい要素に。逆にすると画面がうるさくなる。',
      },
      {
        title: '8. Dark で oklch を手動で反転しない',
        doCode: 'トークンを使う。Light/Dark の切替はトークンが処理する',
        dontCode: 'dark:bg-[oklch(0.22_0.008_60)] と直接書く',
        reason:
          '値を直接書くとトークンの体系から外れて、色調整時に見落とされる「野良の色」になる。',
      },
    ] as const;

    return (
      <div>
        <h1 className="mb-2 text-2xl font-medium">Do&apos;s &amp; Don&apos;ts</h1>
        <p className="text-muted-foreground mb-8">カラー使用のベストプラクティス。</p>

        <div className="grid max-w-5xl gap-6">
          {rules.map(({ title, doCode, dontCode, reason }) => (
            <section key={title} className="bg-card border-border rounded-lg border p-6">
              <h2 className="mb-4 text-lg font-medium">{title}</h2>
              <div className="grid gap-6 md:grid-cols-2">
                <div className="border-success space-y-2 border-l-4 pl-4">
                  <p className="text-success text-sm font-medium">Do</p>
                  <pre className="text-foreground text-xs whitespace-pre-wrap">{doCode}</pre>
                </div>
                <div className="border-destructive space-y-2 border-l-4 pl-4">
                  <p className="text-destructive text-sm font-medium">Don&apos;t</p>
                  <pre className="text-muted-foreground text-xs whitespace-pre-wrap">
                    {dontCode}
                  </pre>
                </div>
              </div>
              <p className="text-muted-foreground mt-4 text-sm">{reason}</p>
            </section>
          ))}
        </div>
      </div>
    );
  },
};

// ========================================
// CVD シミュレーション
// ========================================

const TAG_COLORS_FOR_CVD = [
  { name: 'Red', token: '--category-red', hue: 25 },
  { name: 'Orange', token: '--category-orange', hue: 55 },
  { name: 'Amber', token: '--category-amber', hue: 80 },
  { name: 'Green', token: '--category-green', hue: 145 },
  { name: 'Teal', token: '--category-teal', hue: 185 },
  { name: 'Blue', token: '--category-blue', hue: 240 },
  { name: 'Indigo', token: '--category-indigo', hue: 280 },
  { name: 'Violet', token: '--category-violet', hue: 310 },
  { name: 'Pink', token: '--category-pink', hue: 350 },
  { name: 'Gray', token: '--category-gray', hue: 250 },
] as const;

/**
 * SVG filter で色覚特性をシミュレーション
 * @see https://www.inf.ufrgs.br/~oliveira/pubs_files/CVD_Simulation/CVD_Simulation.html
 */
const CVD_FILTERS = {
  protanopia: {
    label: 'Protanopia（1型: 赤錐体なし）',
    matrix:
      '0.152286 1.052583 -0.204868 0 0  0.114503 0.786281 0.099216 0 0  -0.003882 -0.048116 1.051998 0 0  0 0 0 1 0',
  },
  deuteranopia: {
    label: 'Deuteranopia（2型: 緑錐体なし）',
    matrix:
      '0.367322 0.860646 -0.227968 0 0  0.280085 0.672501 0.047413 0 0  -0.011820 0.042940 0.968881 0 0  0 0 0 1 0',
  },
  tritanopia: {
    label: 'Tritanopia（3型: 青錐体なし）',
    matrix:
      '1.255528 -0.076749 -0.178779 0 0  -0.078411 0.930809 0.147602 0 0  0.004733 0.691367 0.303900 0 0  0 0 0 1 0',
  },
} as const;

const PROBLEMATIC_PAIRS: Array<{
  colors: [string, string];
  cvdType: string;
  risk: string;
}> = [
  { colors: ['Red', 'Green'], cvdType: 'Deuteranopia', risk: '高' },
  { colors: ['Amber', 'Green'], cvdType: 'Protan / Deutan', risk: '高' },
  { colors: ['Red', 'Amber'], cvdType: 'Deuteranopia', risk: '中' },
  { colors: ['Violet', 'Pink'], cvdType: 'Tritanopia', risk: '中' },
];

function CvdColorRow({ filterId }: { filterId: string | null }) {
  return (
    <div className="flex gap-2" style={filterId ? { filter: `url(#${filterId})` } : undefined}>
      {TAG_COLORS_FOR_CVD.map((c) => (
        <div key={c.name} className="flex flex-col items-center gap-1">
          <div className="size-10 rounded-full" style={{ backgroundColor: `var(${c.token})` }} />
          <span className="text-muted-foreground text-xs">{c.name}</span>
        </div>
      ))}
    </div>
  );
}

export const ColorVisionDeficiency: Story = {
  render: function CvdSimulation() {
    return (
      <div className="bg-background p-8">
        <h2 className="text-foreground mb-2 text-2xl font-medium">
          色覚多様性（CVD）シミュレーション
        </h2>
        <p className="text-muted-foreground mb-8 text-sm">
          タグカラー10色を各色覚特性でシミュレーション表示。テキストラベルが常時表示されるため、色のみに依存しない設計。
        </p>

        {/* SVG filters */}
        <svg className="absolute size-0" aria-hidden>
          <defs>
            {Object.entries(CVD_FILTERS).map(([id, { matrix }]) => (
              <filter key={id} id={`cvd-${id}`}>
                <feColorMatrix type="matrix" values={matrix} />
              </filter>
            ))}
          </defs>
        </svg>

        <div className="flex flex-col gap-8">
          {/* 正常色覚 */}
          <section>
            <h3 className="text-foreground mb-2 text-sm font-medium">正常色覚</h3>
            <CvdColorRow filterId={null} />
          </section>

          {/* 各CVDタイプ */}
          {Object.entries(CVD_FILTERS).map(([id, { label }]) => (
            <section key={id}>
              <h3 className="text-foreground mb-2 text-sm font-medium">{label}</h3>
              <CvdColorRow filterId={`cvd-${id}`} />
            </section>
          ))}

          {/* 注意すべきペア */}
          <section>
            <h3 className="text-foreground mb-4 text-sm font-medium">注意すべき色ペア</h3>
            <div className="grid grid-cols-2 gap-4">
              {PROBLEMATIC_PAIRS.map(({ colors, cvdType, risk }) => (
                <div
                  key={colors.join('-')}
                  className="border-border flex items-center gap-4 rounded-lg border p-4"
                >
                  <div className="flex gap-1">
                    {colors.map((colorName) => {
                      const c = TAG_COLORS_FOR_CVD.find((t) => t.name === colorName);
                      return (
                        <div
                          key={colorName}
                          className="size-8 rounded-full"
                          style={{ backgroundColor: c ? `var(${c.token})` : undefined }}
                        />
                      );
                    })}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-foreground text-sm font-medium">{colors.join(' ↔ ')}</p>
                    <p className="text-muted-foreground text-xs">
                      {cvdType} — リスク: {risk}
                    </p>
                  </div>
                </div>
              ))}
            </div>
            <p className="text-muted-foreground mt-4 text-xs">
              緩和策: タグ名テキストが常時表示、オプションのタグアイコン、色選択UIに色名ラベル
            </p>
          </section>
        </div>
      </div>
    );
  },
};
