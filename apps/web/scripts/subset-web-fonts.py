"""Build same-family web font subsets; all other glyphs use the existing full fonts.

Install fonttools[woff]==4.60.2 in a temporary virtual environment, then pass
the upstream SourceSans3[wght].ttf and NotoSansJP[wght].ttf paths. See the
fonts README for source URLs, hashes, licensing, and the full command.
"""

import json
import hashlib
from io import BytesIO
from pathlib import Path
import sys

from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont


WEB = Path(__file__).resolve().parents[1]
OUTPUT = WEB / "src/styles/fonts"
OUTPUT.mkdir(parents=True, exist_ok=True)
PUBLIC = WEB / "public/fonts"
PUBLIC.mkdir(parents=True, exist_ok=True)
body_fonts = []
body_faces = []


def strings(value):
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        return "".join(strings(item) for item in value)
    if isinstance(value, dict):
        return "".join(strings(item) for item in value.values())
    return ""


text = "".join(
    strings(json.loads((WEB / f"messages/{locale}/{namespace}.json").read_text()))
    for locale in ("en", "ja")
    for namespace in ("common", "marketing")
)
symbols = "©↗↺↓→↔…—–·"
latin = set(range(32, 127)) | {ord(char) for char in text + symbols if ord(char) < 0x3000}
japanese = {ord(char) for char in text + symbols if ord(char) > 127}
hero_copy = json.loads((WEB / "messages/ja/marketing.json").read_text())["marketing"]["landing"]["hero"]
hero = {ord(char) for char in hero_copy["title1"] + hero_copy["title2"] + symbols}

for source, name, codepoints, family, weight in (
    (sys.argv[1], "SourceSans3-web.woff2", latin, "Dayopt Web Latin", None),
    (sys.argv[2], "NotoSansJP-web400.woff2", japanese, "Dayopt Web JP Regular", 400),
    (sys.argv[2], "NotoSansJP-web500.woff2", japanese, "Dayopt Web JP Medium", 500),
    (sys.argv[2], "NotoSansJP-hero.woff2", hero, "Dayopt Web JP Hero", 400),
):
    font = TTFont(source)
    font.recalcTimestamp = False
    if weight is not None:
        # The original web face exposes JP weights 400 and 500. Retain those
        # exact instances without shipping unused variable-weight masters.
        instantiateVariableFont(font, {"wght": weight}, inplace=True)
    # Serialize once to apply TrueType's integer coordinate rounding before
    # comparing outlines. Weight instancing uses floats in memory.
    original_bytes = BytesIO()
    font.save(original_bytes)
    font = TTFont(BytesIO(original_bytes.getvalue()))
    font.recalcTimestamp = False
    wanted = codepoints & set(font.getBestCmap())
    cmap = font.getBestCmap()
    original_shapes = {
        point: (list(font["glyf"][cmap[point]].getCoordinates(font["glyf"])[0]),
                font["hmtx"].metrics[cmap[point]])
        for point in wanted
    }
    options = subset.Options()
    options.flavor = "woff2"
    # Preserve default horizontal shaping, kerning and ligatures. The site's
    # text is horizontal; vertical-only alternates need not ship in the subset.
    options.layout_features = [feature for feature in options.layout_features
                               if feature not in {"vert", "vrt2", "vpal", "vhal", "vchw", "valt", "vkrn"}]
    options.drop_tables += ["vhea", "vmtx"]
    options.name_IDs = ["*"]
    options.name_languages = ["*"]
    subsetter = subset.Subsetter(options=options)
    subsetter.populate(unicodes=wanted)
    subsetter.subset(font)
    # The OFL reserves "Source". A subset is a derivative, so use internal names
    # without that reserved name. Glyphs and metrics at each weight stay unchanged.
    for record in font["name"].names:
        if record.nameID in (1, 3, 4, 6, 16, 25):
            value = family.replace(" ", "") if record.nameID in (6, 25) else family
            record.string = value.encode(record.getEncoding())
    font.flavor = "woff2"
    output = OUTPUT / name
    font.save(output)
    actual = TTFont(output)
    assert wanted <= set(actual.getBestCmap()), "Generated font lost required glyphs"
    assert ("fvar" in actual) == (weight is None), "Unexpected weight representation"
    actual_cmap = actual.getBestCmap()
    for point, shape in original_shapes.items():
        actual_name = actual_cmap[point]
        assert shape == (list(actual["glyf"][actual_name].getCoordinates(actual["glyf"])[0]),
                         actual["hmtx"].metrics[actual_name]), "Subset changed glyph shape or width"
    print(f"{name}: {len(wanted)} codepoints, {output.stat().st_size} bytes")
    if name in ("NotoSansJP-web400.woff2", "NotoSansJP-web500.woff2"):
        # A hash in the public URL keeps immutable cache headers safe on updates.
        digest = hashlib.sha256(output.read_bytes()).hexdigest()[:12]
        target = PUBLIC / f"NotoSansJP-web{weight}-{digest}.woff2"
        target.write_bytes(output.read_bytes())
        output.unlink()
        href = f"/fonts/{target.name}"
        body_fonts.append(href)
        body_faces.append(f'''@font-face {{
  font-family: 'Dayopt Web JP';
  font-style: normal;
  font-weight: {weight};
  font-display: swap;
  src: url('{href}') format('woff2');
}}''')

(OUTPUT / "japanese-body.css").write_text("/* Generated by scripts/subset-web-fonts.py. */\n" + "\n\n".join(body_faces) + "\n")
(OUTPUT / "preloads.ts").write_text("// Generated by scripts/subset-web-fonts.py. Preload only for Japanese pages.\nexport const japaneseBodyFonts = [\n" + "".join(f"  '{href}',\n" for href in body_fonts) + "] as const;\n")
