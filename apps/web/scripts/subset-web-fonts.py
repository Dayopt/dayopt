"""Build same-family web font subsets; all other glyphs use the existing full fonts.

Install fonttools[woff]==4.60.2 in a temporary virtual environment, then pass
the upstream SourceSans3[wght].ttf and NotoSansJP[wght].ttf paths. See the
fonts README for source URLs, hashes, licensing, and the full command.
"""

import json
import hashlib
import base64
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
ja_common = json.loads((WEB / "messages/ja/common.json").read_text())
ja_landing = json.loads((WEB / "messages/ja/marketing.json").read_text())["marketing"]["landing"]
common = ja_common["common"]
banner = common["cookies"]["banner"]
header_text = "".join(common["navigation"][key] for key in ("home", "blog", "docs")) + common["actions"]["login"] + common["actions"]["signup"]
# Chromium renders the immediately following calendar scene within its native
# content-visibility look-ahead. Include that scene's default state, too, so it
# cannot force the large deferred character sets into the first visit.
calendar = ja_landing["calendar"]
calendar_first = "".join(calendar[key] for key in ("kicker", "title1", "title2", "body1", "body2", "stepPlan", "stepRecord", "stepNext", "sample", "dateFirst", "weekdayFirst", "insightRecordCopy", "guide", "google"))
# The distant footer uses content-visibility and requests its glyphs on approach.
# Do not let its controls enlarge fonts needed by the first visible scene.
critical_text = header_text + strings(banner) + strings(ja_landing["hero"]) + strings(ja_landing["experience"]) + calendar_first + symbols
critical_400 = japanese & {ord(char) for char in critical_text}
medium_text = header_text + banner["title"] + banner["necessaryOnly"] + banner["allowAnalytics"] + ja_landing["hero"]["cta"] + "".join(ja_landing["experience"][key] for key in ("plan", "record", "reading", "minuteUnit")) + "".join(calendar[key] for key in ("reading", "development", "walking", "insightRecord1", "insightRecord2"))
critical_500 = japanese & {ord(char) for char in medium_text}

for source, name, codepoints, family, weight in (
    (sys.argv[1], "SourceSans3-web.woff2", latin, "Dayopt Web Latin", None),
    (sys.argv[2], "NotoSansJP-critical400.woff2", critical_400, "Dayopt Web JP Critical Regular", 400),
    (sys.argv[2], "NotoSansJP-critical500.woff2", critical_500, "Dayopt Web JP Critical Medium", 500),
    (sys.argv[2], "NotoSansJP-body400.woff2", japanese - critical_400, "Dayopt Web JP Body Regular", 400),
    (sys.argv[2], "NotoSansJP-body500.woff2", japanese - critical_500, "Dayopt Web JP Body Medium", 500),
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
    if name.startswith(("NotoSansJP-critical", "NotoSansJP-body")):
        # A hash in the public URL keeps immutable cache headers safe on updates.
        digest = hashlib.sha256(output.read_bytes()).hexdigest()[:12]
        target = PUBLIC / f"{Path(name).stem}-{digest}.woff2"
        target.write_bytes(output.read_bytes())
        output.unlink()
        href = f"/fonts/{target.name}"
        if name.startswith("NotoSansJP-critical"):
            body_fonts.append(href)
        unicode_range = ", ".join(f"U+{point:X}" for point in sorted(wanted))
        body_faces.append(f'''@font-face {{
  font-family: 'Dayopt Web JP';
  font-style: normal;
  font-weight: {weight};
  font-display: swap;
  src: url('{href}') format('woff2');
  unicode-range: {unicode_range};
}}''')

(OUTPUT / "japanese-body.css").write_text("/* Generated by scripts/subset-web-fonts.py. */\n" + "\n\n".join(body_faces) + "\n")

# Keep the original hero glyphs in the critical stylesheet. This tiny subset
# avoids a font request before the main heading can use the intended typeface.
hero_data = base64.b64encode((OUTPUT / "NotoSansJP-hero.woff2").read_bytes()).decode("ascii")
(OUTPUT / "japanese-hero.css").write_text(
    "/* Generated by scripts/subset-web-fonts.py. */\n"
    "@font-face {\n"
    '  font-family: "Dayopt Web JP Hero";\n'
    "  font-style: normal;\n"
    "  font-weight: 400;\n"
    "  font-display: swap;\n"
    f"  src: url('data:font/woff2;base64,{hero_data}') format('woff2');\n"
    "}\n"
)
(OUTPUT / "preloads.ts").write_text("// Generated by scripts/subset-web-fonts.py. Preload only for Japanese pages.\nexport const japaneseBodyFonts = [\n" + "".join(f"  '{href}',\n" for href in body_fonts) + "] as const;\n")
