# Web font delivery

These are glyph subsets of the existing Source Sans 3 and Noto Sans JP families,
not a different typeface. They cover the current `common` and `marketing` messages
in English and Japanese. Source Sans 3 retains its variable weight axis. Japanese
uses the same 400 / 500 instances as before; their glyph outlines and advance
widths are preserved. Content routes (docs, blog, legal, contact, search) additionally
load a variable subset containing the characters in current MDX and messages.
Blog metadata, Blog body, Docs, and legal copy additionally have collection
faces before that general fallback. The Blog metadata/body faces have disjoint
character ranges: listings fetch only metadata glyphs, while articles can fetch
the rest. All collections retain the source variable weight axis and pass the
same outline/advance checks. This avoids loading an unrelated collection of
characters for a reading page, and dozens of Unicode-range font requests.
The remaining glyphs of that same Japanese font are one deferred local fallback,
including arbitrary search queries and form input. It follows the current-copy
faces in the font stack, so those faces satisfy known characters first. Its face
declaration does not repeat thousands of Unicode ranges on every content page.
The content subset is generated
alongside the other subsets, with the same glyph and metrics checks, and loaded
only by ContentTypography. It is not preloaded on the LP.
The LP covers its current localized copy with the subsets and does not load the
full Japanese font's large Unicode-range stylesheet.

The Latin subset is preloaded. The Japanese H1 face shares the preloaded regular subset with the body;
its face declaration preserves the original heading baseline without a duplicate font.
Japanese pages additionally preload the first-view characters for both body weights
using content-hashed public URLs; English pages do not preload them. Other characters
use disjoint Unicode ranges and load when their text is rendered. The first-view
sets cover the hero, its time demo, navigation, footer, and consent controls; the
default calendar scene also belongs to Chromium's offscreen rendering look-ahead.
Other daily-use states load their remaining characters when they are displayed.
The long LP uses
native `content-visibility: auto` for sections below the hero, retaining their
complete server-rendered content and native anchor / search / focus behavior. The previous
full-font Latin preloads are disabled to avoid downloading the same characters
twice. All subsets use `font-display: swap`. The full Japanese fallback uses its
variable weight range instead of duplicated 400 / 500 declarations.

Sources (Google Fonts upstream, downloaded 2026-09-30):

- https://github.com/google/fonts/blob/main/ofl/sourcesans3/SourceSans3%5Bwght%5D.ttf
- https://github.com/google/fonts/blob/main/ofl/notosansjp/NotoSansJP%5Bwght%5D.ttf

Each is distributed under its accompanying SIL Open Font License. The derivative
font names are `Dayopt Web Latin` and `Dayopt Web JP` to respect the reserved name
in the license. The site continues to use Source Sans 3 / Noto Sans JP glyphs.

Upstream SHA-256:

```text
Source Sans 3: 042fe2cc0b933e328410d7acbd0aa6a1873dca5aef81875f4bc214b08825c7b9
Noto Sans JP: c2f3b4d463500a2ddcd3849cded1fceeb9fd6d1c32e6cbecd568453ba50fc68f
```

To regenerate after editing the messages:

```sh
python3 -m venv /tmp/dayopt-font-tools
/tmp/dayopt-font-tools/bin/pip install 'fonttools[woff]==4.60.2'
curl -fL 'https://raw.githubusercontent.com/google/fonts/main/ofl/sourcesans3/SourceSans3%5Bwght%5D.ttf' -o /tmp/SourceSans3-variable.ttf
curl -fL 'https://raw.githubusercontent.com/google/fonts/main/ofl/notosansjp/NotoSansJP%5Bwght%5D.ttf' -o /tmp/NotoSansJP-variable.ttf
/tmp/dayopt-font-tools/bin/python apps/web/scripts/subset-web-fonts.py /tmp/SourceSans3-variable.ttf /tmp/NotoSansJP-variable.ttf
pnpm exec prettier --write apps/web/src/styles/fonts/japanese-body.css apps/web/src/styles/fonts/japanese-hero.css apps/web/src/styles/fonts/preloads.ts
```

The generator reads all current MDX and message files. Regenerate after editing
public content as well as messages. The generator checks actual output `cmap` coverage, each font's expected weight
representation, and every requested glyph's coordinates and horizontal metrics
against its original instance. Vertical-only alternates and metrics are omitted
because the site uses horizontal text. Refresh the upstream hashes and licenses
when replacing the sources. Commit the generated body CSS / preload manifest
alongside the fonts, removing superseded hashed body files.
