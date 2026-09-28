# OGP fonts

OGP images embed Source Sans 3 Semibold (Latin) and Noto Sans JP Medium (Japanese).
Storybook serves the same static TTFs from `/og-fonts` to keep previews and PNGs aligned.
Both are distributed under the accompanying SIL Open Font Licenses.

Downloaded from Google Fonts on 2026-09-28 using the static TTF responses for:
`https://fonts.googleapis.com/css2?family=Source+Sans+3:wght@600&family=Noto+Sans+JP:wght@500`.

- Source Sans 3 v19: `https://fonts.gstatic.com/s/sourcesans3/v19/nwpBtKy2OAdR1K-IwhWudF-R9QMylBJAV3Bo8Kxm7FEN.ttf`
- Noto Sans JP v56: `https://fonts.gstatic.com/s/notosansjp/v56/-F6jfjtqLzI2JPCgQBnw7HFyzSD-AsregP8VFCMj75s.ttf`

`src/og-font-widths.ts` stores ASCII advance widths divided by `unitsPerEm`,
read from Source Sans 3's `cmap`/`hmtx` tables. Update these when replacing the font.
Japanese glyphs use a conservative one-em estimate when balancing title lines.
Next app tracing includes these files for server image generation.
