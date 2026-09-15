/**
 * Markdown 内の生成ブロック（マーカー間だけを差し替える）。
 *
 * glossary.md の `glossary:generated:start / end` と同じ方式を、Architecture Map の
 * 複数 doc（architecture.md / invariants.md）で使い回すために切り出した。前文と手書きの
 * 注釈はそのまま残し、マーカー間だけを生成物で置き換える。
 */

export interface GeneratedBlockMarkers {
  start: string;
  end: string;
}

/**
 * マーカー文字列を組み立てる。`id` は doc 内で一意な識別子、`source` は読者へ示す正本。
 * 再生成 / 検証コマンドは固定（`pnpm architecture:generate` / `pnpm architecture:check`）。
 */
export function architectureMapMarkers(id: string, source: string): GeneratedBlockMarkers {
  return {
    start: `<!-- architecture-map:${id}:start — 正本 ${source} / 再生成 pnpm architecture:generate / 検証 pnpm architecture:check。この範囲は手編集しない -->`,
    end: `<!-- architecture-map:${id}:end -->`,
  };
}

export function replaceGeneratedBlock(
  markdown: string,
  markers: GeneratedBlockMarkers,
  generated: string,
  documentLabel: string,
): string {
  const startIndex = markdown.indexOf(markers.start);
  const endIndex = markdown.indexOf(markers.end);

  if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) {
    throw new Error(
      `${documentLabel} に生成マーカーが見つかりません（${markers.end}）。手で復元してください。`,
    );
  }

  const before = markdown.slice(0, startIndex);
  const after = markdown.slice(endIndex + markers.end.length);

  return `${before}${markers.start}\n\n${generated.trim()}\n\n${markers.end}${after}`;
}
