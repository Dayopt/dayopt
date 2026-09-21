/**
 * Dayopt Learning System の正本（docs/learn/**\/*.md の `json learn:*` block）を集めて検証する。
 *
 * 正本は Markdown の中の JSON block。説明文と Mermaid は render-markdown.ts が、
 * 対話 UI は tasks/learn.ts がここで集めた data から生成する。参照 {path, find} の実在は
 * docs-guard の learn-refs が検査する。
 */

import { glob } from 'glob';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { z } from 'zod';

export const REPO_BLOB_URL = 'https://github.com/Dayopt/dayopt/blob/main/';

/** 失敗時の 4 観点。[見出し, 色の分類]。UI とテキスト生成の両方がこの辞書を使う。 */
export const FAILURE_TAGS = {
  screen: {
    none: ['何も起きない', 'ok'],
    toast: ['エラー表示', 'bad'],
    redirect: ['別の画面へ', 'warn'],
    wait: ['待ち状態', 'warn'],
    blocked: ['押せない', 'warn'],
    down: ['使えない', 'bad'],
    old: ['旧版のまま', 'warn'],
    depends: ['設定次第', 'warn'],
  },
  data: {
    unchanged: ['変化なし', 'neutral'],
    saved: ['保存される', 'ok'],
    unknown: ['どちらもありうる', 'warn'],
    lost: ['欠落する', 'bad'],
    // 2 か所の状態が食い違ったまま残る（deploy: DB だけ新しい、課金: Stripe だけ新しい など。向きは本文に書く）
    mixed: ['食い違いが残る', 'warn'],
  },
  retry: {
    none: ['しない', 'neutral'],
    auto: ['自動で再試行', 'ok'],
    user: ['利用者がやり直す', 'neutral'],
    provider: ['相手が再送', 'ok'],
    next: ['次の機会に', 'warn'],
    na: ['不要', 'ok'],
    depends: ['条件次第', 'warn'],
  },
  trace: {
    sentry: ['Sentry', 'ok'],
    log: ['ログだけ', 'warn'],
    none: ['残らない', 'neutral'],
    issue: ['GitHub issue', 'ok'],
    monitor: ['監視が拾う', 'ok'],
  },
} as const satisfies Record<string, Record<string, readonly [string, string]>>;

type TagKey<K extends keyof typeof FAILURE_TAGS> = keyof (typeof FAILURE_TAGS)[K] & string;

function tagEnum<K extends keyof typeof FAILURE_TAGS>(kind: K) {
  const keys = Object.keys(FAILURE_TAGS[kind]) as [TagKey<K>, ...TagKey<K>[]];
  return z.enum(keys);
}

const refSchema = z.strictObject({
  // 正規化した repo 相対パスだけを許す。`..` や `./` を含むと、同じファイルが別の表記になり
  // 章 12 の逆引き（ファイルごとの一覧）から外れる
  path: z
    .string()
    .min(1)
    .refine(
      (path) =>
        !path.startsWith('/') &&
        !path.split('/').some((seg) => seg === '..' || seg === '.' || seg === ''),
      '正規化した repo 相対パスで書く（先頭の /、.、..、空の区切りは使わない）',
    ),
  find: z.string().min(1),
  why: z.string().min(1).optional(),
});

// 利用者の画面の模型。対話画面の描画（ui/template.html の mock*）が読む項目を型ごとに検査する。
// 未知の項目や欠けた必須項目を通すと、その段を開いた時だけ画面が壊れるため strict にする。
const tone = z.enum(['ok', 'warn', 'bad', 'neutral']);
const screenCommon = {
  url: z.string().optional(),
  host: z.string().optional(),
  title: z.string().optional(),
  note: z.string().optional(),
  banner: z.string().optional(),
  bannerTone: tone.optional(),
  toast: z.string().optional(),
  toastTone: tone.optional(),
  toastAction: z.string().optional(),
};
const blockState = z.enum(['select', 'temp', 'saved', 'record', 'ext', 'gone']);
const screenSchema = z.discriminatedUnion('t', [
  z.strictObject({
    t: z.literal('calendar'),
    ...screenCommon,
    blocks: z
      .array(
        z.strictObject({
          state: blockState,
          label: z.string(),
          from: z.number().optional(),
          len: z.number().optional(),
        }),
      )
      .optional(),
    drawer: z
      .strictObject({ title: z.string(), items: z.array(z.string()), on: z.number().int() })
      .optional(),
  }),
  z.strictObject({
    t: z.literal('form'),
    ...screenCommon,
    title: z.string(),
    fields: z.array(z.tuple([z.string(), z.string()])).optional(),
    extra: z.string().optional(),
    button: z.string().optional(),
    alt: z.string().optional(),
    error: z.string().optional(),
    busy: z.boolean().optional(),
    disabled: z.boolean().optional(),
  }),
  z.strictObject({
    t: z.literal('inbox'),
    ...screenCommon,
    mails: z
      .array(
        z.strictObject({
          subject: z.string(),
          from: z.string().optional(),
          state: z.enum(['new', 'read', 'missing']).optional(),
        }),
      )
      .min(1),
  }),
  z.strictObject({
    t: z.literal('page'),
    ...screenCommon,
    title: z.string(),
    body: z.string().optional(),
    tone: tone.optional(),
    button: z.string().optional(),
  }),
  z.strictObject({
    t: z.literal('consent'),
    ...screenCommon,
    title: z.string(),
    scopes: z.array(z.string()).optional(),
  }),
  z.strictObject({
    t: z.literal('settings'),
    ...screenCommon,
    rows: z
      .array(z.union([z.tuple([z.string(), z.string()]), z.tuple([z.string(), z.string(), tone])]))
      .min(1),
    button: z.string().optional(),
  }),
  z.strictObject({ t: z.literal('blank'), ...screenCommon, text: z.string().optional() }),
]);

const failSchema = z.strictObject({
  id: z.string().min(1),
  label: z.string().min(1),
  screen: z.string().min(1),
  data: z.string().min(1),
  retry: z.string().min(1),
  trace: z.string().min(1),
  look: z.string().min(1),
  refs: z.array(refSchema),
  tags: z.strictObject({
    screen: tagEnum('screen'),
    data: tagEnum('data'),
    retry: tagEnum('retry'),
    trace: tagEnum('trace'),
  }),
  to: z.string().min(1).optional(),
  back: z.string().min(1).optional(),
  screenAfter: screenSchema.optional(),
  continues: z.boolean().optional(),
});

const hopSchema = z.strictObject({
  id: z.string().min(1),
  svc: z.string().min(1),
  short: z.string().min(1),
  title: z.string().min(1),
  what: z.string().min(1),
  why: z.string().min(1).optional(),
  io: z.strictObject({ in: z.string().min(1), out: z.string().min(1) }).optional(),
  change: z.string().min(1).optional(),
  via: z.string().min(1).optional(),
  screen: screenSchema.optional(),
  refs: z.array(refSchema),
  tests: z.array(refSchema).optional(),
  fails: z.array(failSchema),
});

/** 対話画面のタブをまとめる単位。表示名は JOURNEY_GROUPS */
export const JOURNEY_GROUPS = {
  calendar: 'カレンダー',
  account: 'アカウント',
  integration: '外部連携',
  ops: '運用',
} as const;

export const journeySchema = z.strictObject({
  id: z.string().min(1),
  title: z.string().min(1),
  order: z.number().int(),
  group: z.enum(
    Object.keys(JOURNEY_GROUPS) as [
      keyof typeof JOURNEY_GROUPS,
      ...(keyof typeof JOURNEY_GROUPS)[],
    ],
  ),
  intro: z.string().min(1),
  play: z.string().min(1),
  lanes: z.array(z.string().min(1)).min(1),
  /** 同じ操作を別の入口から行う journey（例: UI と MCP）。id を指す */
  twin: z.string().min(1).optional(),
  lab: z.string().min(1).optional(),
  tests: z.array(refSchema).optional(),
  hops: z.array(hopSchema).min(1),
});

const serviceSchema = z.strictObject({
  label: z.string().min(1),
  var: z.string().regex(/^--svc-[a-z]+$/),
  sub: z.string(),
});

const outageItemSchema = z.strictObject({
  id: z.string().min(1),
  svc: z.string().min(1),
  name: z.string().min(1),
  role: z.string().min(1),
  breaks: z.string().min(1),
  keeps: z.string().min(1),
  behavior: z.string().min(1),
  env: z.array(z.string()),
  look: z.string().min(1),
  refs: z.array(refSchema),
  impacts: z.record(z.string(), z.enum(['down', 'degraded'])),
});

export const servicesSchema = z.strictObject({
  services: z.record(z.string(), serviceSchema),
  outages: z.strictObject({
    title: z.string().min(1),
    intro: z.string().min(1),
    features: z.array(z.strictObject({ id: z.string().min(1), label: z.string().min(1) })),
    items: z.array(outageItemSchema),
  }),
});

const screenNodeSchema = z.strictObject({
  id: z.string().min(1),
  label: z.string().min(1),
  url: z.string().min(1),
  col: z.number().int().min(1),
  row: z.number().int().min(1),
  group: z.enum(['auth', 'app', 'ext']),
  what: z.string().min(1),
  arrive: z.string().min(1),
  loads: z.string().min(1),
  svcs: z.array(z.string().min(1)),
  fails: z.string().min(1),
  screen: screenSchema,
  refs: z.array(refSchema),
  flows: z.array(z.string().min(1)),
});

export const screensSchema = z.strictObject({
  title: z.string().min(1),
  intro: z.string().min(1),
  columns: z.array(z.string().min(1)),
  nodes: z.array(screenNodeSchema),
  edges: z.array(z.tuple([z.string().min(1), z.string().min(1), z.string().min(1)])),
});

export type LearnRef = z.infer<typeof refSchema>;
export type LearnJourney = z.infer<typeof journeySchema>;
export type LearnServices = z.infer<typeof servicesSchema>;
export type LearnScreens = z.infer<typeof screensSchema>;

export interface LearnSource<T> {
  /** repo-relative path of the Markdown file holding the block */
  file: string;
  value: T;
}

export interface LearnData {
  repo: string;
  tags: typeof FAILURE_TAGS;
  groups: typeof JOURNEY_GROUPS;
  services: LearnServices['services'];
  outages: LearnServices['outages'];
  screens: LearnScreens;
  scenarios: LearnJourney[];
}

export interface CollectResult {
  data: LearnData | undefined;
  journeys: LearnSource<LearnJourney>[];
  services: LearnSource<LearnServices> | undefined;
  screens: LearnSource<LearnScreens> | undefined;
  /** 章や lab の手書きの本文が名指しするコード（learn:refs）。本文と同じファイルに置く */
  extraRefs: LearnSource<LearnRef[]>[];
  errors: string[];
}

export interface LearnBlock {
  kind: string;
  file: string;
  json: string;
  /** code block の言語。json 以外なら書き間違いとして報告する */
  lang: string;
}

/** Markdown から `json learn:<kind>` の fenced block を取り出す。 */
export function extractLearnBlocks(markdown: string, file: string): LearnBlock[] {
  const blocks: LearnBlock[] = [];
  const visit = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    const candidate = node as {
      type?: string;
      lang?: string | null;
      meta?: string | null;
      value?: string;
      children?: unknown[];
    };
    // 言語が json でなくても learn: の block は拾い、collect 側で報告する（黙って検査から外れないように）
    if (candidate.type === 'code' && candidate.meta?.trim().startsWith('learn:')) {
      blocks.push({
        kind: candidate.meta.trim().slice('learn:'.length).trim(),
        file,
        json: candidate.value ?? '',
        lang: candidate.lang ?? '',
      });
    }
    candidate.children?.forEach(visit);
  };
  visit(fromMarkdown(markdown));
  return blocks;
}

function formatIssues(file: string, label: string, error: z.ZodError): string[] {
  return error.issues.map(
    (issue) => `${file}: ${label} の ${issue.path.join('.') || '(root)'}: ${issue.message}`,
  );
}

function parseBlock<T>(block: LearnBlock, schema: z.ZodType<T>, errors: string[]): T | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(block.json);
  } catch (error) {
    errors.push(`${block.file}: learn:${block.kind} の JSON が壊れている: ${String(error)}`);
    return undefined;
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    errors.push(...formatIssues(block.file, `learn:${block.kind}`, parsed.error));
    return undefined;
  }
  return parsed.data;
}

function duplicates(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const id of ids) (seen.has(id) ? dup : seen).add(id);
  return [...dup];
}

/** block 間の整合（svc / lane / fail.to / 画面の辺 / 停止マップの機能 id）を確かめる。 */
export function crossCheck(
  journeys: readonly LearnSource<LearnJourney>[],
  services: LearnSource<LearnServices>,
  screens: LearnSource<LearnScreens>,
): string[] {
  const errors: string[] = [];
  const svcIds = new Set(Object.keys(services.value.services));
  const journeyIds = new Set(journeys.map((j) => j.value.id));

  for (const id of duplicates(journeys.map((j) => j.value.id)))
    errors.push(`journey id が重複: ${id}`);
  for (const order of duplicates(journeys.map((j) => String(j.value.order)))) {
    errors.push(`journey の order が重複: ${order}`);
  }

  for (const { file, value: j } of journeys) {
    for (const lane of j.lanes)
      if (!svcIds.has(lane)) errors.push(`${file}: lanes に未定義のサービス ${lane}`);
    if (j.twin && !journeyIds.has(j.twin))
      errors.push(`${file}: twin が存在しない journey を指す: ${j.twin}`);
    const twin = journeys.find((other) => other.value.id === j.twin);
    if (twin && twin.value.twin !== j.id)
      errors.push(`${file}: twin が片方向（${j.twin} の twin が ${j.id} を指していない）`);
    const hopIds = new Set(j.hops.map((h) => h.id));
    for (const id of duplicates(j.hops.map((h) => h.id)))
      errors.push(`${file}: hop id が重複: ${id}`);
    for (const hop of j.hops) {
      if (!j.lanes.includes(hop.svc))
        errors.push(`${file}: hop ${hop.id} の svc ${hop.svc} が lanes に無い`);
      for (const id of duplicates(hop.fails.map((f) => f.id)))
        errors.push(`${file}: hop ${hop.id} の fail id が重複: ${id}`);
      for (const fail of hop.fails) {
        if (fail.to && !hopIds.has(fail.to))
          errors.push(`${file}: fail ${fail.id} の to が存在しない hop を指す: ${fail.to}`);
        if (fail.to && !fail.back)
          errors.push(`${file}: fail ${fail.id} は to があるのに back が無い`);
      }
    }
  }

  const features = new Set(services.value.outages.features.map((f) => f.id));
  for (const item of services.value.outages.items) {
    if (!svcIds.has(item.svc))
      errors.push(`${services.file}: 停止マップ ${item.id} の svc ${item.svc} が未定義`);
    for (const feature of Object.keys(item.impacts)) {
      if (!features.has(feature))
        errors.push(`${services.file}: 停止マップ ${item.id} の impacts に未定義の機能 ${feature}`);
    }
  }

  const nodeIds = new Set(screens.value.nodes.map((n) => n.id));
  for (const id of duplicates(screens.value.nodes.map((n) => n.id)))
    errors.push(`${screens.file}: 画面 id が重複: ${id}`);
  for (const node of screens.value.nodes) {
    for (const svc of node.svcs)
      if (!svcIds.has(svc)) errors.push(`${screens.file}: 画面 ${node.id} の svcs に未定義 ${svc}`);
    for (const flow of node.flows)
      if (!journeyIds.has(flow))
        errors.push(`${screens.file}: 画面 ${node.id} の flows に未定義の journey ${flow}`);
  }
  for (const [from, to] of screens.value.edges) {
    if (!nodeIds.has(from) || !nodeIds.has(to))
      errors.push(`${screens.file}: 画面の辺 ${from} → ${to} が未定義の画面を指す`);
  }
  return errors;
}

export function collectLearnData(root: string): CollectResult {
  const learnDir = resolve(root, 'docs/learn');
  const files = glob.sync('**/*.md', { cwd: learnDir, absolute: true }).sort();
  const errors: string[] = [];
  const journeys: LearnSource<LearnJourney>[] = [];
  let services: LearnSource<LearnServices> | undefined;
  let screens: LearnSource<LearnScreens> | undefined;
  const extraRefs: LearnSource<LearnRef[]>[] = [];

  for (const abs of files) {
    const file = relative(root, abs);
    for (const block of extractLearnBlocks(readFileSync(abs, 'utf8'), file)) {
      if (block.lang !== 'json') {
        errors.push(
          `${file}: learn:${block.kind} の block の言語が json ではない（${block.lang || '無し'}）。検査から外れるので json にする`,
        );
        continue;
      }
      if (block.kind === 'journey') {
        const value = parseBlock(block, journeySchema, errors);
        if (value) journeys.push({ file, value });
      } else if (block.kind === 'services') {
        if (services) errors.push(`${file}: learn:services が 2 つある（${services.file}）`);
        const value = parseBlock(block, servicesSchema, errors);
        if (value) services = { file, value };
      } else if (block.kind === 'refs') {
        const value = parseBlock(block, z.array(refSchema).min(1), errors);
        if (value) extraRefs.push({ file, value });
      } else if (block.kind === 'screens') {
        if (screens) errors.push(`${file}: learn:screens が 2 つある（${screens.file}）`);
        const value = parseBlock(block, screensSchema, errors);
        if (value) screens = { file, value };
      } else {
        errors.push(`${file}: 未知の block learn:${block.kind}`);
      }
    }
  }

  if (!services) errors.push('learn:services の block が無い');
  if (!screens) errors.push('learn:screens の block が無い');
  if (services && screens) errors.push(...crossCheck(journeys, services, screens));

  // 対話画面のタブと README の一覧は、まとまり（JOURNEY_GROUPS の並び）→ order の順
  const groupRank = Object.keys(JOURNEY_GROUPS);
  journeys.sort(
    (a, b) =>
      groupRank.indexOf(a.value.group) - groupRank.indexOf(b.value.group) ||
      a.value.order - b.value.order,
  );
  const data =
    services && screens && errors.length === 0
      ? {
          repo: REPO_BLOB_URL,
          tags: FAILURE_TAGS,
          groups: JOURNEY_GROUPS,
          services: services.value.services,
          outages: services.value.outages,
          screens: screens.value,
          scenarios: journeys.map((j) => j.value),
        }
      : undefined;
  return { data, journeys, services, screens, extraRefs, errors };
}

/** data 中のすべての参照（refs と tests）を列挙する。 */
export function listLearnRefs(result: CollectResult): { file: string; ref: LearnRef }[] {
  const out: { file: string; ref: LearnRef }[] = [];
  const push = (file: string, refs: readonly LearnRef[] | undefined) =>
    refs?.forEach((ref) => out.push({ file, ref }));
  for (const { file, value: j } of result.journeys) {
    push(file, j.tests);
    for (const hop of j.hops) {
      push(file, hop.refs);
      push(file, hop.tests);
      for (const fail of hop.fails) push(file, fail.refs);
    }
  }
  if (result.services)
    for (const item of result.services.value.outages.items) push(result.services.file, item.refs);
  if (result.screens)
    for (const node of result.screens.value.nodes) push(result.screens.file, node.refs);
  for (const { file, value } of result.extraRefs) push(file, value);
  return out;
}
