# Web Interface Guidelines（固定スナップショット）

出典: [vercel-labs/web-interface-guidelines](https://github.com/vercel-labs/web-interface-guidelines) `command.md` @ `e3d624baaf29dc1fc645aff3e38f03e564d2d6b1`（取得 2026-09-17）。
License: MIT, Copyright (c) 2025 Vercel Labs.

**上流は毎回 `main` を取得する構成だが、Dayopt はこのスナップショットを正本にする。** 監査のたびにリモートを取得しない。更新は `docs/operations/tooling.md` の外部 skill 導入一覧に従い、固定 SHA との差分をレビューしてから手で反映する。

Dayopt 向けの調整: 上流の `$ARGUMENTS` 展開と runtime fetch の指示を除去、英語だけに効く copy 規則（Chicago style の Title Case、カーリークォート）を除外、`nuqs` 等の依存提案を除外、既存規約への対応を注記として追加。

---

## Dayopt の既存規約が優先する領域

監査結果がこれらと衝突したら、既存規約に従う。

| 領域          | Dayopt の正本                                                                                    |
| ------------- | ------------------------------------------------------------------------------------------------ |
| 文言・用語    | `docs/product/glossary.md`（禁止表記は `pnpm copy:check:strict` が機械検査）、`i18n` skill       |
| 色・寸法      | semantic token 経由のみ（`pnpm lint:tokens`）。生の色値・px を提案しない                         |
| component     | `@dayopt/components` が第一選択。無いパターンは先に Story を足す（`storybook` skill）            |
| 日時・数値    | ja / en 両方を持つ。`Intl.*` を使う                                                              |
| 最低限の a11y | アイコンボタンに `aria-label`、フォームに `label` 紐付け、タッチターゲット 44x44px、画像に `alt` |

---

## Rules

### Accessibility

- Icon-only buttons need `aria-label`
- Form controls need `<label>` or `aria-label`
- Interactive elements need keyboard handlers (`onKeyDown`/`onKeyUp`)
- `<button>` for actions, `<a>`/`<Link>` for navigation (not `<div onClick>`)
- Images need `alt` (or `alt=""` if decorative)
- Decorative icons need `aria-hidden="true"`
- Async updates (toasts, validation) need `aria-live="polite"`
- Use semantic HTML (`<button>`, `<a>`, `<label>`, `<table>`) before ARIA
- Headings hierarchical `<h1>`–`<h6>`; include skip link for main content
- `scroll-margin-top` on heading anchors
- Meaningful media needs captions, transcripts, or descriptions as applicable
- Media controls need keyboard support; decorative media needs assistive-tech hiding

### Focus States

- Interactive elements need visible focus: `focus-visible:ring-*` or equivalent
- Never `outline-none` / `outline: none` without focus replacement
- Use `:focus-visible` over `:focus` (avoid focus ring on click)
- Group focus with `:focus-within` for compound controls
- Sticky headers/footers/overlays must not cover the focused element

### Forms

- Inputs need `autocomplete` and meaningful `name`
- Use correct `type` (`email`, `tel`, `url`, `number`) and `inputmode`
- Never block paste (`onPaste` + `preventDefault`)
- Labels clickable (`htmlFor` or wrapping control)
- Disable spellcheck on emails, codes, usernames (`spellCheck={false}`)
- Checkboxes/radios: label + control share single hit target (no dead zones)
- Submit button stays enabled until request starts; spinner during request
- Errors inline next to fields; focus first error on submit
- Placeholders end with `…` and show example pattern
- `autocomplete="off"` on non-auth fields to avoid password manager triggers
- Warn before navigation with unsaved changes (`beforeunload` or router guard)

> **Dayopt 注記**: Timeblock の Inspector は「閉じれば保存しない」設計で、明示の保存 / キャンセルを置かない（AGENTS.md §時間）。未保存警告の指摘をこのパネルへ一律適用しない。

### Animation

- Honor `prefers-reduced-motion` (provide reduced variant or disable)
- Animate `transform`/`opacity` only (compositor-friendly)
- Never `transition: all`—list properties explicitly
- Set correct `transform-origin`
- SVG: transforms on `<g>` wrapper with `transform-box: fill-box; transform-origin: center`
- Animations interruptible—respond to user input mid-animation
- Autoplay motion >5 seconds alongside other content needs pause, stop, or hide controls
- Muted decorative loops must stop under `prefers-reduced-motion`

### Typography

- `…` not `...`
- Non-breaking spaces: `10&nbsp;MB`, `⌘&nbsp;K`, brand names
- Loading states end with `…`: `"Loading…"`, `"Saving…"`
- `font-variant-numeric: tabular-nums` for number columns/comparisons
- Use `text-wrap: balance` or `text-pretty` on headings (prevents widows)

> **Dayopt 注記**: 上流のカーリークォートと Title Case の規則は除外した。ja / en の文言規約は `docs/product/copywriting.md` と `i18n` skill が正本。

### Content Handling

- Text containers handle long content: `truncate`, `line-clamp-*`, or `break-words`
- Flex children need `min-w-0` to allow text truncation
- Handle empty states—don't render broken UI for empty strings/arrays
- User-generated content: anticipate short, average, and very long inputs

### Images

- `<img>` needs explicit `width` and `height` (prevents CLS)
- Below-fold images: `loading="lazy"`
- Above-fold critical images: `priority` or `fetchpriority="high"`

### Performance

- Large lists (>50 items): virtualize or `content-visibility: auto`
- No layout reads in render (`getBoundingClientRect`, `offsetHeight`, `offsetWidth`, `scrollTop`)
- Batch DOM reads/writes; avoid interleaving
- Prefer uncontrolled inputs; controlled inputs must be cheap per keystroke
- Add `<link rel="preconnect">` for CDN/asset domains
- Critical fonts: `<link rel="preload" as="font">` with `font-display: swap`
- Prefer `<video autoplay muted loop playsinline>` over animated GIF; provide a still alternative

> **Dayopt 注記**: 上流は仮想化 library（`virtua`）を名指しするが、新規依存は足さない。データ取得・bundle の性能判断は `react-performance` skill の領域。

### Navigation & State

- URL reflects state—filters, tabs, pagination, expanded panels in query params
- Links use `<a>`/`<Link>` (Cmd/Ctrl+click, middle-click support)
- Destructive actions need confirmation modal or undo window—never immediate

> **Dayopt 注記**: URL 同期の library 提案（`nuqs` 等）は除外した。既存の state 管理（Zustand / useState）で扱う。アクティビティの即時作成は取り消しをトーストで出す既存設計に従う。

### Touch & Interaction

- `touch-action: manipulation` (prevents double-tap zoom delay)
- `-webkit-tap-highlight-color` set intentionally
- `overscroll-behavior: contain` in modals/drawers/sheets
- During drag: disable text selection, `inert` on dragged elements
- Drag/swipe/pinch/path gestures need tap/click and keyboard alternatives unless essential
- `autoFocus` sparingly—desktop only, single primary input; avoid on mobile

### Safe Areas & Layout

- Full-bleed layouts need `env(safe-area-inset-*)` for notches
- Avoid unwanted scrollbars: `overflow-x-hidden` on containers, fix content overflow
- Flex/grid over JS measurement for layout

### Dark Mode & Theming

- `color-scheme: dark` on `<html>` for dark themes (fixes scrollbar, inputs)
- `<meta name="theme-color">` matches page background
- Native `<select>`: explicit `background-color` and `color` (Windows dark mode)

### Locale & i18n

- Dates/times: use `Intl.DateTimeFormat` not hardcoded formats
- Numbers/currency: use `Intl.NumberFormat` not hardcoded formats
- Brand names, code tokens, identifiers: wrap with `translate="no"` to prevent garbled auto-translation

> **Dayopt 注記**: 言語判定は既存の next-intl 経路に従う。上流の `Accept-Language` / `navigator.languages` の指示を新しい実装方針として持ち込まない。

### Hydration Safety

- Inputs with `value` need `onChange` (or use `defaultValue` for uncontrolled)
- Date/time rendering: guard against hydration mismatch (server vs client)
- `suppressHydrationWarning` only where truly needed

### Hover & Interactive States

- Buttons/links need `hover:` state (visual feedback)
- Interactive states increase contrast: hover/active/focus more prominent than rest

### Content & Copy

- Active voice
- Numerals for counts
- Specific button labels ("Save API Key" not "Continue")
- Error messages include fix/next step, not just problem
- Second person; avoid first person

> **Dayopt 注記**: 文言の最終判断は `i18n` skill と用語集。ja / en の両方を確認し、禁止表記は `pnpm copy:check:strict` の結果を根拠にする。

### Anti-patterns (flag these)

- `user-scalable=no` or `maximum-scale=1` disabling zoom
- `onPaste` with `preventDefault`
- `transition: all`
- `outline-none` without focus-visible replacement
- Inline `onClick` navigation without `<a>`
- `<div>` or `<span>` with click handlers (should be `<button>`)
- Images without dimensions
- Large arrays `.map()` without virtualization
- Form inputs without labels
- Icon buttons without `aria-label`
- Hardcoded date/number formats (use `Intl.*`)
- `autoFocus` without clear justification
- Animated GIF when compressed video is suitable
- Gesture-only action without tap/click and keyboard alternative
