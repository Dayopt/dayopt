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


docs_introduction = (WEB / "content/docs/ja/getting-started/index.mdx").read_text().split("---", 2)[2].split("\n## ", 1)[0]
text = docs_introduction + "".join(
    strings(json.loads((WEB / f"messages/{locale}/{namespace}.json").read_text()))
    for locale in ("en", "ja")
    for namespace in ("common", "marketing")
)
symbols = "©↗↺↓→↔…—–·"
latin = set(range(32, 127)) | {ord(char) for char in text + symbols if ord(char) < 0x3000}
japanese = {ord(char) for char in text + symbols if ord(char) > 127}
content_text = "".join(file.read_text() for file in (WEB / "content").rglob("*.mdx")) + "".join(
    strings(json.loads(file.read_text())) for file in (WEB / "messages").rglob("*.json")
)
content_japanese = {ord(char) for char in content_text if ord(char) > 127} - japanese
full_japanese = set(TTFont(sys.argv[2]).getBestCmap()) - japanese - content_japanese - latin

# Collection-specific faces precede the general reading fallback. Blog listing
# metadata and article text are disjoint so the index need not load article glyphs.
def characters(copy):
    return {ord(char) for char in copy if ord(char) > 127} - japanese

blog_files = [file.read_text() for file in (WEB / "content/blog").rglob("*.mdx")]
blog_metadata_text = "".join(copy.split("---", 2)[1] +
    (copy.split("---", 2)[2][:500] if "\ndescription:" not in copy.split("---", 2)[1] else "")
    for copy in blog_files)
blog_metadata = characters(blog_metadata_text)
collection_faces = [
    ("blog-meta", "Dayopt Blog JP", blog_metadata),
    ("blog-body", "Dayopt Blog JP", characters("".join(blog_files)) - blog_metadata),
]
for collection, family in (("docs", "Dayopt Docs JP"), ("legal", "Dayopt Legal JP")):
    copy = "".join(file.read_text() for file in (WEB / f"content/{collection}").rglob("*.mdx"))
    message_file = WEB / f"messages/ja/{collection}.json"
    if message_file.exists():
        copy += strings(json.loads(message_file.read_text()))
    collection_faces.append((collection, family, characters(copy)))
collection_css = []

ja_common = json.loads((WEB / "messages/ja/common.json").read_text())
ja_landing = json.loads((WEB / "messages/ja/marketing.json").read_text())["marketing"]["landing"]
common = ja_common["common"]
banner = common["cookies"]["banner"]
header_text = "".join(common["navigation"][key] for key in ("home", "blog", "docs")) + common["actions"]["login"] + common["actions"]["signup"]
footer_text = strings(ja_common["footer"]["sections"]) + strings(ja_common["footer"]["legal"]) + common["navigation"]["contact"] + common["cookies"]["settings"]["trigger"]
# Chromium renders the immediately following calendar scene within its native
# content-visibility look-ahead. Include that scene's default state, too, so it
# cannot force the large deferred character sets into the first visit.
calendar = ja_landing["calendar"]
calendar_first = "".join(calendar[key] for key in ("kicker", "title1", "title2", "body1", "body2", "stepPlan", "stepRecord", "stepNext", "sample", "dateFirst", "weekdayFirst", "insightRecordCopy", "guide", "google"))
critical_text = header_text + footer_text + strings(banner) + strings(common["theme"]) + "日本語" + strings(ja_landing["hero"]) + strings(ja_landing["experience"]) + calendar_first + symbols
critical_text += strings(ja_common["blog"]["header"])
critical_text += docs_introduction
contact = json.loads((WEB / "messages/ja/marketing.json").read_text())["marketing"]["contact"]
critical_text += contact["title"] + contact["subtitle"]
critical_400 = japanese & {ord(char) for char in critical_text}
medium_text = header_text + strings(ja_common["footer"]["sections"]) + banner["title"] + banner["necessaryOnly"] + banner["allowAnalytics"] + ja_landing["hero"]["cta"] + "".join(ja_landing["experience"][key] for key in ("plan", "record", "reading", "minuteUnit")) + "".join(calendar[key] for key in ("reading", "development", "walking", "insightRecord1", "insightRecord2"))
critical_500 = japanese & {ord(char) for char in medium_text}

for source, name, codepoints, family, weight in (
    (sys.argv[1], "SourceSans3-web.woff2", latin, "Dayopt Web Latin", None),
    (sys.argv[2], "NotoSansJP-critical400.woff2", critical_400, "Dayopt Web JP Critical Regular", 400),
    (sys.argv[2], "NotoSansJP-critical500.woff2", critical_500, "Dayopt Web JP Critical Medium", 500),
    (sys.argv[2], "NotoSansJP-body400.woff2", japanese - critical_400, "Dayopt Web JP Body Regular", 400),
    (sys.argv[2], "NotoSansJP-body500.woff2", japanese - critical_500, "Dayopt Web JP Body Medium", 500),
    (sys.argv[2], "NotoSansJP-content.woff2", content_japanese, "Dayopt Content JP", None),
    (sys.argv[2], "NotoSansJP-full.woff2", full_japanese, "Dayopt Content JP Full", None),
    *((sys.argv[2], f"NotoSansJP-{name}.woff2", points, family, None)
      for name, family, points in collection_faces),
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
    if name.startswith(("NotoSansJP-critical", "NotoSansJP-body", "NotoSansJP-content", "NotoSansJP-full", "NotoSansJP-blog", "NotoSansJP-docs", "NotoSansJP-legal")):
        # A hash in the public URL keeps immutable cache headers safe on updates.
        digest = hashlib.sha256(output.read_bytes()).hexdigest()[:12]
        target = PUBLIC / f"{Path(name).stem}-{digest}.woff2"
        target.write_bytes(output.read_bytes())
        output.unlink()
        href = f"/fonts/{target.name}"
        if name.startswith(("NotoSansJP-blog", "NotoSansJP-docs", "NotoSansJP-legal")):
            collection_css.append(f'''@font-face {{
  font-family: '{family}';
  font-style: normal;
  font-weight: 100 900;
  font-display: swap;
  src: url('{href}') format('woff2');
  unicode-range: {", ".join(f"U+{point:X}" for point in sorted(wanted))};
}}
''')
            continue
        if name.startswith("NotoSansJP-content"):
            (OUTPUT / "japanese-content.css").write_text(f'''/* Generated by scripts/subset-web-fonts.py. Content routes only. */
@font-face {{
  font-family: 'Dayopt Content JP';
  font-style: normal;
  font-weight: 100 900;
  font-display: swap;
  src: url('{href}') format('woff2');
  unicode-range: {", ".join(f"U+{point:X}" for point in sorted(wanted))};
}}
''')
            continue
        if name.startswith("NotoSansJP-full"):
            (OUTPUT / "japanese-full.css").write_text(f'''/* Generated by scripts/subset-web-fonts.py. Other characters only. */
@font-face {{
  font-family: 'Dayopt Content JP Full';
  font-style: normal;
  font-weight: 100 900;
  font-display: swap;
  src: url('{href}') format('woff2');
}}
''')
            continue
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

(OUTPUT / "japanese-collections.css").write_text("/* Generated by scripts/subset-web-fonts.py. */\n" + "\n".join(collection_css))

(OUTPUT / "japanese-body.css").write_text("/* Generated by scripts/subset-web-fonts.py. */\n" + "\n\n".join(body_faces) + "\n")

# The hero face retains its existing metrics while sharing the preloaded
# regular glyph file. No duplicate embedded font is necessary.
hero_href = body_fonts[0]
(OUTPUT / "japanese-hero.css").write_text(
    "/* Generated by scripts/subset-web-fonts.py. */\n"
    "@font-face {\n"
    '  font-family: "Dayopt Web JP Hero";\n'
    "  font-style: normal;\n"
    "  font-weight: 400;\n"
    "  font-display: swap;\n"
    f"  src: url('{hero_href}') format('woff2');\n"
    "}\n"
)
(OUTPUT / "preloads.ts").write_text("// Generated by scripts/subset-web-fonts.py. Preload only for Japanese pages.\nexport const japaneseBodyFonts = [\n" + "".join(f"  '{href}',\n" for href in body_fonts) + "] as const;\n")
