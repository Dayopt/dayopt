/**
 * learn:* block から、同じ Markdown 内の生成ブロック（図と読みやすい説明）を作る。
 *
 * GitHub や AI が .md を直接読んだ時にも、対話 UI と同じ内容が追えるようにするため。
 * 生成ブロックの外（見出し・手書きの注釈・JSON block）には触れない。
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';

import { format as formatWithPrettier, resolveConfig as resolvePrettierConfig } from 'prettier';

import {
  replaceGeneratedBlock,
  type GeneratedBlockMarkers,
} from '../architecture-map/generated-block.ts';
import {
  FAILURE_TAGS,
  JOURNEY_GROUPS,
  type CollectResult,
  type LearnJourney,
  type LearnRef,
  type LearnScreens,
  type LearnServices,
} from './data.ts';

const SOURCE_KINDS = new Set(['journey', 'services', 'screens']);

export function learnMarkers(kind: string): GeneratedBlockMarkers {
  const source = SOURCE_KINDS.has(kind)
    ? `このファイルの learn:${kind} の JSON`
    : `docs/learn/journeys の JSON（${kind}）`;
  return {
    start: `<!-- learn:generated:start — 正本 ${source} / 再生成 pnpm learn:generate / 検証 pnpm docs:check。この範囲は手編集しない -->`,
    end: '<!-- learn:generated:end -->',
  };
}

/** バッククォートを含む文字列も壊さない inline code。 */
export function inlineCode(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(longest + 1);
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${text}${pad}${fence}`;
}

function mermaidLabel(text: string): string {
  return `"${text.replace(/"/g, '#quot;').replace(/</g, '#lt;').replace(/>/g, '#gt;')}"`;
}

/** doc から repo path への相対リンク。括弧を含む App Router の path でも壊れないよう <> で包む。 */
export function relLink(docFile: string, repoPath: string): string {
  const from = dirname(docFile);
  const target = relative(from, repoPath).split('\\').join('/');
  return `<${target}>`;
}

function refLine(docFile: string, ref: LearnRef): string {
  const why = ref.why ? `（${ref.why}）` : '';
  return `[${inlineCode(ref.path)}](${relLink(docFile, ref.path)}) で ${inlineCode(ref.find)} を探す${why}`;
}

function refList(docFile: string, refs: readonly LearnRef[] | undefined, indent = ''): string[] {
  return (refs ?? []).map((ref) => `${indent}- ${refLine(docFile, ref)}`);
}

function tagLabel(kind: keyof typeof FAILURE_TAGS, key: string): string {
  const table = FAILURE_TAGS[kind] as Record<string, readonly [string, string]>;
  return table[key]?.[0] ?? key;
}

export function journeyMermaid(journey: LearnJourney, services: LearnServices['services']): string {
  const lines = ['flowchart TD'];
  for (const lane of journey.lanes) {
    lines.push(`  subgraph s_${lane}[${mermaidLabel(services[lane]?.label ?? lane)}]`);
    journey.hops.forEach((hop, index) => {
      if (hop.svc === lane)
        lines.push(`    n${index + 1}[${mermaidLabel(`${index + 1}. ${hop.short}`)}]`);
    });
    lines.push('  end');
  }
  journey.hops.forEach((hop, index) => {
    if (index === 0) return;
    const edge = hop.via ? ` -->|${mermaidLabel(hop.via)}| ` : ' --> ';
    lines.push(`  n${index}${edge}n${index + 1}`);
  });
  return ['```mermaid', ...lines, '```'].join('\n');
}

export function renderJourney(
  docFile: string,
  journey: LearnJourney,
  services: LearnServices['services'],
  journeyFiles: ReadonlyMap<string, string>,
): string {
  const out: string[] = [journey.intro, '', journeyMermaid(journey, services), ''];
  const lanes = journey.lanes.map((lane) => services[lane]?.label ?? lane).join(' / ');
  const failCount = journey.hops.reduce((sum, hop) => sum + hop.fails.length, 0);
  out.push(`通るサービス: ${lanes}。段 ${journey.hops.length}・失敗 ${failCount} 種。`);
  if (journey.twin) {
    const twinFile = journeyFiles.get(journey.twin);
    if (twinFile)
      out.push(
        '',
        `同じ操作を別の入口から行う経路: [${journey.twin}](${relLink(docFile, twinFile)})`,
      );
  }
  if (journey.lab)
    out.push(
      '',
      `壊して確かめる: [${journey.lab}](${relLink(docFile, `docs/learn/labs/${journey.lab}.md`)})`,
    );

  out.push('', '#### この経路を守るテスト', '');
  if (journey.tests?.length) out.push(...refList(docFile, journey.tests));
  else out.push('- 経路全体を通しで守るテストは紐付いていない（段ごとのテストを見る）');

  journey.hops.forEach((hop, index) => {
    out.push(
      '',
      `### ${index + 1}. ${hop.title}（${services[hop.svc]?.label ?? hop.svc}）`,
      '',
      hop.what,
      '',
    );
    if (hop.why) out.push(`- **なぜ必要か**: ${hop.why}`);
    if (hop.io) out.push(`- **入力 → 出力**: ${hop.io.in} → ${hop.io.out}`);
    if (hop.change) out.push(`- **ここを変えると**: ${hop.change}`);
    out.push('- **コード**:', ...refList(docFile, hop.refs, '  '));
    if (hop.tests?.length)
      out.push('- **この段を守るテスト**:', ...refList(docFile, hop.tests, '  '));
    for (const fail of hop.fails) {
      const summary = [
        `画面: ${tagLabel('screen', fail.tags.screen)}`,
        `データ: ${tagLabel('data', fail.tags.data)}`,
        `再試行: ${tagLabel('retry', fail.tags.retry)}`,
        `痕跡: ${tagLabel('trace', fail.tags.trace)}`,
      ].join(' / ');
      out.push(
        '',
        '<details>',
        `<summary>⚡ ${fail.label} — ${summary}</summary>`,
        '',
        `- 画面: ${fail.screen}`,
        `- データ: ${fail.data}`,
        `- 再試行: ${fail.retry}`,
        `- 痕跡: ${fail.trace}`,
        `- **最初に見る場所**: ${fail.look}`,
      );
      if (fail.refs.length) out.push('- 根拠:', ...refList(docFile, fail.refs, '  '));
      out.push('', '</details>');
    }
  });
  return out.join('\n');
}

export function renderServices(docFile: string, value: LearnServices): string {
  const out: string[] = [value.outages.intro, '', '| サービス | 役割 |', '| --- | --- |'];
  for (const item of value.outages.items) out.push(`| ${item.name} | ${item.role} |`);

  const features = new Map(value.outages.features.map((f) => [f.id, f.label]));
  const graph = ['flowchart LR'];
  for (const item of value.outages.items) graph.push(`  s_${item.id}[${mermaidLabel(item.name)}]`);
  for (const [id, label] of features) graph.push(`  f_${id}[${mermaidLabel(label)}]`);
  for (const item of value.outages.items) {
    for (const [feature, impact] of Object.entries(item.impacts)) {
      graph.push(
        impact === 'down'
          ? `  s_${item.id} -->|"止まる"| f_${feature}`
          : `  s_${item.id} -.->|"弱まる"| f_${feature}`,
      );
    }
  }
  out.push(
    '',
    '実線は「止まる」、点線は「弱まる（一部・遅れて追いつく）」。',
    '',
    '```mermaid',
    ...graph,
    '```',
  );

  for (const item of value.outages.items) {
    out.push('', `### ${item.name} が止まったら`, '');
    const impacts = Object.entries(item.impacts)
      .map(
        ([feature, impact]) =>
          `${features.get(feature) ?? feature}（${impact === 'down' ? '止まる' : '弱まる'}）`,
      )
      .join('、');
    out.push(`- **影響する機能**: ${impacts || 'なし'}`);
    out.push(
      `- **壊れる**: ${item.breaks}`,
      `- **動き続ける**: ${item.keeps}`,
      `- **コードの挙動**: ${item.behavior}`,
    );
    out.push(
      `- **関係する env**: ${item.env.length ? item.env.map(inlineCode).join(', ') : 'なし'}`,
    );
    out.push(
      `- **最初に見る場所**: ${item.look}`,
      '- **コードと文書**:',
      ...refList(docFile, item.refs, '  '),
    );
  }
  return out.join('\n');
}

export function renderScreens(
  docFile: string,
  value: LearnScreens,
  services: LearnServices['services'],
  journeyFiles: ReadonlyMap<string, string>,
  journeyTitles: ReadonlyMap<string, string>,
): string {
  const graph = ['flowchart LR'];
  const groups: Record<string, string> = {
    auth: value.columns[0] ?? 'auth',
    app: value.columns[1] ?? 'app',
    ext: value.columns[2] ?? 'ext',
  };
  for (const [group, label] of Object.entries(groups)) {
    graph.push(`  subgraph g_${group}[${mermaidLabel(label)}]`);
    for (const node of value.nodes.filter((n) => n.group === group))
      graph.push(`    ${node.id.replace(/-/g, '_')}[${mermaidLabel(node.label)}]`);
    graph.push('  end');
  }
  for (const [from, to, label] of value.edges)
    graph.push(`  ${from.replace(/-/g, '_')} -->|${mermaidLabel(label)}| ${to.replace(/-/g, '_')}`);
  const out: string[] = [value.intro, '', '```mermaid', ...graph, '```'];

  const labels = new Map(value.nodes.map((n) => [n.id, n.label]));
  for (const node of value.nodes) {
    out.push('', `### ${node.label}（${inlineCode(node.url)}）`, '', node.what, '');
    out.push(`- **ここへ来る条件**: ${node.arrive}`, `- **読み込むデータ**: ${node.loads}`);
    out.push(`- **触るサービス**: ${node.svcs.map((s) => services[s]?.label ?? s).join('、')}`);
    out.push(`- **壊れた時**: ${node.fails}`);
    const outs = value.edges
      .filter((e) => e[0] === node.id)
      .map((e) => `${labels.get(e[1])}（${e[2]}）`);
    if (outs.length) out.push(`- **移る先**: ${outs.join('、')}`);
    if (node.flows.length) {
      const links = node.flows
        .map((id) =>
          journeyFiles.has(id)
            ? `[${journeyTitles.get(id) ?? id}](${relLink(docFile, journeyFiles.get(id) ?? '')})`
            : id,
        )
        .join('、');
      out.push(`- **この画面を通る経路**: ${links}`);
    }
    out.push('- **コードと文書**:', ...refList(docFile, node.refs, '  '));
  }
  return out.join('\n');
}

/** 章 6: 経路の段ごとに、それを守るテストと、守るテストが無い段を並べる。 */
export function renderTestMap(docFile: string, result: CollectResult): string {
  const out: string[] = [
    '経路の各段に紐付いたテストの一覧。段の「この段を守るテスト」と、経路全体を通しで守るテストを集めた。',
    '**テストが紐付いていない段は、守られていないとは限らない**（紐付けていないだけのこともある）。変更前に、その段のコードの隣の `*.test.ts` を探す。',
  ];
  const untested: string[] = [];
  for (const { file, value: journey } of result.journeys) {
    const link = `[${journey.title}](${relLink(docFile, file)})`;
    out.push('', `### ${journey.title}`, '');
    if (journey.tests?.length)
      out.push('- **経路全体**:', ...refList(docFile, journey.tests, '  '));
    journey.hops.forEach((hop, index) => {
      if (hop.tests?.length)
        out.push(`- **${index + 1}. ${hop.short}**:`, ...refList(docFile, hop.tests, '  '));
      else untested.push(`- ${link} の ${index + 1}. ${hop.short}`);
    });
    if (!journey.tests?.length && !journey.hops.some((hop) => hop.tests?.length))
      out.push('- 紐付いたテストは無い');
  }
  out.push('', '### テストが紐付いていない段', '', ...(untested.length ? untested : ['- なし']));
  return out.join('\n');
}

/** 章 12: コードのファイルごとに、それを参照する経路の段と「ここを変えると」を逆引きする。 */
export function renderChangeMap(docFile: string, result: CollectResult): string {
  const byPath = new Map<string, string[]>();
  for (const { file, value: journey } of result.journeys) {
    journey.hops.forEach((hop, index) => {
      const paths = new Set(
        hop.refs.map((ref) => ref.path).filter((path) => !path.startsWith('docs/')),
      );
      for (const path of paths) {
        const line = `[${journey.title}](${relLink(docFile, file)}) の ${index + 1}. ${hop.short}${hop.change ? ` — ${hop.change}` : ''}`;
        byPath.set(path, [...(byPath.get(path) ?? []), line]);
      }
    });
  }
  const out: string[] = [
    '経路の段が参照しているコードを、ファイルごとに逆引きした一覧。あるファイルを変える時、どの操作のどの段に響くか、その段に書いた「ここを変えると」を並べる。',
    '一覧に無いファイルは、どの経路からも参照していないだけで、影響が無いとは限らない。',
  ];
  for (const path of [...byPath.keys()].sort()) {
    out.push(
      '',
      `#### ${inlineCode(path)}`,
      '',
      ...(byPath.get(path) ?? []).map((line) => `- ${line}`),
    );
  }
  return out.join('\n');
}

/** README: 経路の一覧を、対話画面のタブと同じまとまりで並べる。 */
export function renderJourneyIndex(docFile: string, result: CollectResult): string {
  const out: string[] = [];
  for (const [group, label] of Object.entries(JOURNEY_GROUPS)) {
    const journeys = result.journeys.filter((j) => j.value.group === group);
    if (journeys.length === 0) continue;
    out.push('', `**${label}**`, '');
    for (const { file, value } of journeys) {
      const lead = value.intro.split('。')[0];
      out.push(`- [${value.title}](${relLink(docFile, file)}) — ${lead}。`);
    }
  }
  return out.join('\n').trim();
}

/** 経路 data から生成する章。ファイルがある時だけ生成する。 */
const INDEX_DOCS = [
  { file: 'docs/learn/README.md', kind: 'journey-index', render: renderJourneyIndex },
  { file: 'docs/learn/06-testing.md', kind: 'test-map', render: renderTestMap },
  { file: 'docs/learn/12-change.md', kind: 'change-map', render: renderChangeMap },
] as const;

export interface RenderedDoc {
  file: string;
  current: string;
  expected: string;
}

/**
 * 生成ブロックを持つすべての learn doc について、現在の内容と生成後の内容を返す。
 * lint-staged と同じ prettier（repo の設定）を通す。通さないと commit 時の整形で偽 drift になる。
 */
export async function renderLearnDocs(root: string, result: CollectResult): Promise<RenderedDoc[]> {
  if (!result.services || !result.screens) return [];
  const services = result.services.value.services;
  const journeyFiles = new Map(result.journeys.map((j) => [j.value.id, j.file]));
  const journeyTitles = new Map(result.journeys.map((j) => [j.value.id, j.value.title]));

  const targets: { file: string; kind: string; body: string }[] = [
    ...result.journeys.map((j) => ({
      file: j.file,
      kind: 'journey',
      body: renderJourney(j.file, j.value, services, journeyFiles),
    })),
    {
      file: result.services.file,
      kind: 'services',
      body: renderServices(result.services.file, result.services.value),
    },
    {
      file: result.screens.file,
      kind: 'screens',
      body: renderScreens(
        result.screens.file,
        result.screens.value,
        services,
        journeyFiles,
        journeyTitles,
      ),
    },
  ];

  for (const index of INDEX_DOCS) {
    if (existsSync(resolve(root, index.file))) {
      targets.push({ file: index.file, kind: index.kind, body: index.render(index.file, result) });
    }
  }

  const docs: RenderedDoc[] = [];
  for (const { file, kind, body } of targets) {
    const filepath = resolve(root, file);
    const current = readFileSync(filepath, 'utf8');
    const replaced = replaceGeneratedBlock(current, learnMarkers(kind), body, file);
    const config = (await resolvePrettierConfig(filepath)) ?? {};
    docs.push({
      file,
      current,
      expected: await formatWithPrettier(replaced, { ...config, parser: 'markdown', filepath }),
    });
  }
  return docs;
}
