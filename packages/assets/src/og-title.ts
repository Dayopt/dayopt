import { OG_LATIN_WIDTHS } from './og-font-widths';

const wordSegmenter = new Intl.Segmenter('ja', { granularity: 'word' });
const graphemeSegmenter = new Intl.Segmenter('ja', { granularity: 'grapheme' });
const CANNOT_START =
  /^[・、。，．？！：；）」』】〉》〕］｝ーぁぃぅぇぉっゃゅょァィゥェォッャュョ.,!?;:)/\]}]/u;
const PARTICLES = new Set(['を', 'が', 'は', 'に', 'へ', 'と', 'の', 'で', 'も', 'や']);
const CANNOT_END = /[（「『【〈《〔［｛([{]$/u;
const ENGLISH_JOINER =
  /(?:^|\s)(?:a|an|the|and|or|but|with|of|to|for|in|on|at|by|from|your|our|my|their)$/iu;

function canStartLine(text: string): boolean {
  const firstWord = wordSegmenter.segment(text)[Symbol.iterator]().next().value?.segment;
  return !CANNOT_START.test(text) && !PARTICLES.has(firstWord ?? '');
}

function measure(text: string): number {
  return [...text].reduce((width, char) => width + (OG_LATIN_WIDTHS[char] ?? 1), 0);
}

/** Choose explicit lines, shared by browser previews and Satori (no CSS line-clamp). */
export function composeOgTitle(title: string, width: number, compact = false) {
  const text = title.replace(/\s+/gu, ' ').trim();
  const japanese = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text);
  const maxFontSize = compact ? (japanese ? 48 : 56) : japanese ? 72 : 92;
  // Allow for shaping differences and glyph overhang, even with negative tracking.
  const availableWidth = width * 0.96;
  const fit = (lines: string[]) =>
    Math.min(maxFontSize, Math.floor(availableWidth / Math.max(...lines.map(measure), 1)));

  if (measure(text) * maxFontSize <= availableWidth) {
    return { lines: [text], fontSize: maxFontSize, japanese };
  }

  const boundaries = [...wordSegmenter.segment(text)]
    .map(({ index }) => index)
    .filter((index) => index > 0);

  function splitAtBestBoundary(value: string, candidates: number[]): string[] {
    let best = [value];
    let bestScore = Infinity;
    for (const index of candidates) {
      const left = value.slice(0, index).trim();
      const right = value.slice(index).trim();
      if (!left || !right || CANNOT_END.test(left) || !canStartLine(right)) continue;
      const leftWidth = measure(left);
      const rightWidth = measure(right);
      // Prefer balanced lines, with a small preference for punctuation boundaries.
      const punctuation = /[、。,:;.!?]$/u.test(left) ? 0.85 : 1;
      const danglingWord = ENGLISH_JOINER.test(left) ? 1.2 : 1;
      const score =
        (Math.max(leftWidth, rightWidth) + Math.abs(leftWidth - rightWidth) * 0.2) *
        punctuation *
        danglingWord;
      if (score < bestScore) {
        best = [left, right];
        bestScore = score;
      }
    }
    return best;
  }

  let lines = splitAtBestBoundary(text, boundaries);
  // URLs / long unspaced words still fit; never split a surrogate pair or combining mark.
  if (lines.length === 1) {
    lines = splitAtBestBoundary(
      text,
      [...graphemeSegmenter.segment(text)].map(({ index }) => index),
    );
  }

  // A narrow screenshot column can use three lines instead of illegibly small text.
  if (compact && fit(lines) < 32) {
    let bestScore = Infinity;
    for (const first of boundaries) {
      const left = text.slice(0, first).trim();
      const rest = text.slice(first).trimStart();
      if (!left || CANNOT_END.test(left) || !canStartLine(rest)) continue;
      const tail = splitAtBestBoundary(
        rest,
        [...wordSegmenter.segment(rest)].map(({ index }) => index),
      );
      if (tail.length !== 2) continue;
      const candidate = [left, ...tail];
      const widths = candidate.map(measure);
      const score = Math.max(...widths) + (Math.max(...widths) - Math.min(...widths)) * 0.2;
      if (score < bestScore) {
        bestScore = score;
        lines = candidate;
      }
    }
  }

  return { lines, fontSize: fit(lines), japanese };
}
