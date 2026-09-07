/**
 * 用語集レジストリの判定コア（pure function 層）
 *
 * `terms.ts` がデータ、このファイルが判定・描画ロジック。I/O（readFileSync /
 * console / process.exit）は持たない。消費者は 3 つ:
 *   - `scripts/tasks/check-glossary.ts`  … messages の禁止表記スキャン（pnpm copy:check）
 *   - `scripts/tasks/generate-glossary.ts` … docs/product/glossary.md の表を生成
 *   - `scripts/tasks/docs-guard/checks/glossary-sync.ts` … 生成物の drift 検出
 *
 * こう分けるのは、旧 check-glossary.ts が「glossary.md と同期」とコメントしながら
 * 実際にはずれていた（禁止語「エントリ」が未登録、推奨語が禁止語そのもの）ため。
 * 表と禁止語を同一データから生成し、ずれを CI で止める。
 */

import { escapeMarkdownTableCell } from '../markdown-table.ts';

// ─── 型定義 ───

export type Locale = 'ja' | 'en';

/**
 * 用語の層。
 * - `ui`     … UI 文言に出る呼称。ja / en 必須で、messages を機械強制する対象
 * - `design` … 設計語。docs / spec / Storybook で使うが UI 文言には出さない（決算バー・羅針盤等）
 * - `code`   … コード内部語。識別子と DB 名の対応表。UI 表記を持たない
 */
export type GlossaryLayer = 'ui' | 'design' | 'code';

export type TermStatus = 'current' | 'deprecated' | 'planned-removal';

/**
 * 禁止語の強制レベル。
 * - `active`       … `--strict` で exit 1（CI 必須）
 * - `migration`    … 警告のみ。新規追加は禁止、既存は移行待ち
 * - `context-only` … スキャンしない。表に「文脈次第で可」として載せるだけ
 */
export type Enforcement = 'active' | 'migration' | 'context-only';

export interface ForbiddenTerm {
  /** 表示用の語。`pattern` を持たない場合は判定にも使う */
  term: string;
  locale: Locale;
  enforcement: Enforcement;
  /** 判定方法。`substring`（既定）/ `word`（en 専用、\b で囲む）/ `pattern`（regex source を自前指定） */
  match?: 'substring' | 'word';
  /** `match: 'pattern'` 相当。RegExp の source を文字列で持つ（テストで compile 可否を固定するため） */
  pattern?: string;
  /** 値がこれらのいずれかを含めば許容（同音異義。例: 「レビュー」に対する「プレビュー」） */
  allowIfValueIncludes?: readonly string[];
  /** キーパスがこれらのいずれかに一致すれば許容。RegExp source */
  allowKeyPaths?: readonly string[];
  /** この namespace 内だけスキャンする（例: 「空白」を report に限定） */
  onlyNamespaces?: readonly string[];
  /**
   * この語を正当に使ってよい概念の id。
   * レジストリ自己検査（他エントリの正解語が禁止語に当たらないこと）の例外に使う。
   * 例: `event` は timeblock の禁止語だが `external-event` では正当。
   */
  allowConceptIds?: readonly string[];
  reason: string;
}

export interface GlossaryEntry {
  /** kebab-case の一意 id。表の並び順は配列順 */
  id: string;
  layer: GlossaryLayer;
  status: TermStatus;
  /** 英語の概念名（表の 1 列目） */
  concept: string;
  /** layer: 'ui' | 'design' では必須 */
  ja?: string;
  en?: string;
  /** 1 行の使い方 */
  usage: string;
  code?: {
    identifiers?: readonly string[];
    feature?: string;
    i18nNamespace?: string;
  };
  db?: readonly string[];
  forbidden?: readonly ForbiddenTerm[];
  /** decisions.md の日付や issue 番号 */
  refs?: readonly string[];
  note?: string;
}

/**
 * i18n キー名に使わない token。
 * キーパスを `.` と camelCase 境界で分割した token と**完全一致**で判定する
 * （部分一致にすると `ariaLabel` / `sentryReport` が誤検知になる）。
 */
export interface KeyNameRule {
  token: string;
  preferred: string;
  enforcement: Enforcement;
  /** キーパスがこれらのいずれかに一致すれば許容。RegExp source */
  allowKeyPaths?: readonly string[];
  reason: string;
}

// ─── コンパイル済みルール ───

export interface ValueRule {
  conceptId: string;
  term: string;
  locale: Locale;
  enforcement: Enforcement;
  preferred: string;
  reason: string;
  /** null なら部分一致（`value.includes(term)`） */
  regex: RegExp | null;
  allowIfValueIncludes: readonly string[];
  allowKeyPaths: readonly RegExp[];
  onlyNamespaces: readonly string[];
}

export interface CompiledKeyNameRule {
  token: string;
  preferred: string;
  enforcement: Enforcement;
  reason: string;
  allowKeyPaths: readonly RegExp[];
}

export interface MessageValue {
  namespace: string;
  keyPath: string;
  value: string;
}

export interface ValueFinding {
  locale: Locale;
  namespace: string;
  keyPath: string;
  value: string;
  term: string;
  preferred: string;
  enforcement: Enforcement;
}

export interface KeyNameFinding {
  locale: Locale;
  namespace: string;
  keyPath: string;
  token: string;
  preferred: string;
  enforcement: Enforcement;
}

// ─── 判定 ───

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** ForbiddenTerm を判定用 RegExp（部分一致なら null）へ落とす */
export function compileMatcher(forbidden: ForbiddenTerm): RegExp | null {
  if (forbidden.pattern !== undefined) return new RegExp(forbidden.pattern, 'i');
  if (forbidden.match === 'word') return new RegExp(`\\b${escapeRegExp(forbidden.term)}s?\\b`, 'i');
  return null;
}

/** 指定 locale の禁止語ルールを組み立てる。`context-only` は判定に載せない */
export function buildValueRules(glossary: readonly GlossaryEntry[], locale: Locale): ValueRule[] {
  const rules: ValueRule[] = [];

  for (const entry of glossary) {
    for (const forbidden of entry.forbidden ?? []) {
      if (forbidden.locale !== locale) continue;
      if (forbidden.enforcement === 'context-only') continue;

      rules.push({
        conceptId: entry.id,
        term: forbidden.term,
        locale,
        enforcement: forbidden.enforcement,
        preferred: (locale === 'ja' ? entry.ja : entry.en) ?? entry.concept,
        reason: forbidden.reason,
        regex: compileMatcher(forbidden),
        allowIfValueIncludes: forbidden.allowIfValueIncludes ?? [],
        allowKeyPaths: (forbidden.allowKeyPaths ?? []).map((source) => new RegExp(source)),
        onlyNamespaces: forbidden.onlyNamespaces ?? [],
      });
    }
  }

  return rules;
}

/** 1 つの値が 1 つのルールに違反しているか */
export function violatesValueRule(rule: ValueRule, target: MessageValue): boolean {
  if (rule.onlyNamespaces.length > 0 && !rule.onlyNamespaces.includes(target.namespace)) {
    return false;
  }

  const hit = rule.regex ? rule.regex.test(target.value) : target.value.includes(rule.term);
  if (!hit) return false;

  if (rule.allowIfValueIncludes.some((allowed) => target.value.includes(allowed))) return false;
  if (rule.allowKeyPaths.some((allowed) => allowed.test(target.keyPath))) return false;

  return true;
}

export function scanValues(
  values: readonly MessageValue[],
  rules: readonly ValueRule[],
  locale: Locale,
): ValueFinding[] {
  const findings: ValueFinding[] = [];

  for (const target of values) {
    for (const rule of rules) {
      if (!violatesValueRule(rule, target)) continue;
      findings.push({
        locale,
        namespace: target.namespace,
        keyPath: target.keyPath,
        value: target.value,
        term: rule.term,
        preferred: rule.preferred,
        enforcement: rule.enforcement,
      });
    }
  }

  return findings;
}

/**
 * キーパスを判定用の token 列へ分解する。
 *
 * `settings.dataControls.export.tasksEvents`
 *   → ['settings', 'data', 'controls', 'export', 'tasks', 'events']
 *
 * camelCase 境界と非英数字で割る。完全一致で判定するので `ariaLabel` は
 * ['aria', 'label'] となり、`label` を rule に持たない限り当たらない。
 */
export function tokenizeKeyPath(keyPath: string): string[] {
  return keyPath
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter((part) => part.length > 0)
    .map((part) => part.toLowerCase());
}

export function compileKeyNameRules(rules: readonly KeyNameRule[]): CompiledKeyNameRule[] {
  return rules
    .filter((rule) => rule.enforcement !== 'context-only')
    .map((rule) => ({
      token: rule.token,
      preferred: rule.preferred,
      enforcement: rule.enforcement,
      reason: rule.reason,
      allowKeyPaths: (rule.allowKeyPaths ?? []).map((source) => new RegExp(source)),
    }));
}

export function scanKeyNames(
  values: readonly MessageValue[],
  rules: readonly CompiledKeyNameRule[],
  locale: Locale,
): KeyNameFinding[] {
  const findings: KeyNameFinding[] = [];

  for (const target of values) {
    const tokens = new Set(tokenizeKeyPath(target.keyPath));
    for (const rule of rules) {
      if (!tokens.has(rule.token)) continue;
      if (rule.allowKeyPaths.some((allowed) => allowed.test(target.keyPath))) continue;
      findings.push({
        locale,
        namespace: target.namespace,
        keyPath: target.keyPath,
        token: rule.token,
        preferred: rule.preferred,
        enforcement: rule.enforcement,
      });
    }
  }

  return findings;
}

// ─── JSON 走査 ───

/** ネストした messages JSON を `{ keyPath, value }` の leaf 配列へ潰す */
export function getAllStringValues(
  obj: unknown,
  prefix = '',
): Array<{ keyPath: string; value: string }> {
  const results: Array<{ keyPath: string; value: string }> = [];

  if (typeof obj === 'string') {
    results.push({ keyPath: prefix, value: obj });
  } else if (Array.isArray(obj)) {
    obj.forEach((item, i) => {
      results.push(...getAllStringValues(item, prefix ? `${prefix}[${i}]` : `[${i}]`));
    });
  } else if (obj && typeof obj === 'object') {
    for (const [key, val] of Object.entries(obj as Record<string, unknown>)) {
      const path = prefix ? `${prefix}.${key}` : key;
      results.push(...getAllStringValues(val, path));
    }
  }

  return results;
}

// ─── レジストリ自己検査 ───

/**
 * レジストリの内部整合を検査する。違反メッセージの配列を返す（空なら健全）。
 *
 * 最重要の検査は「どのエントリの正解語も、他エントリの有効な禁止語に当たらない」。
 * 旧 check-glossary.ts が `タスク → エントリ`（推奨語が別の禁止語）を出力していた
 * バグを、点ではなくクラスとして閉じる。
 */
export function validateRegistry(
  glossary: readonly GlossaryEntry[],
  keyNameRules: readonly KeyNameRule[],
): string[] {
  const problems: string[] = [];

  const seenIds = new Set<string>();
  for (const entry of glossary) {
    if (seenIds.has(entry.id)) problems.push(`id が重複: ${entry.id}`);
    seenIds.add(entry.id);

    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(entry.id)) {
      problems.push(`id が kebab-case ではない: ${entry.id}`);
    }

    if ((entry.layer === 'ui' || entry.layer === 'design') && (!entry.ja || !entry.en)) {
      problems.push(`layer: '${entry.layer}' は ja / en 必須: ${entry.id}`);
    }

    if (entry.status === 'planned-removal' && (entry.forbidden?.length ?? 0) > 0) {
      problems.push(`廃止予定の概念に禁止語を定義している: ${entry.id}`);
    }

    for (const forbidden of entry.forbidden ?? []) {
      if (forbidden.match === 'word' && forbidden.locale === 'ja') {
        problems.push(
          `ja に match: 'word' は使えない（語境界が無い）。pattern を書く: ${entry.id} / ${forbidden.term}`,
        );
      }
      try {
        compileMatcher(forbidden);
      } catch {
        problems.push(`pattern が RegExp として解釈できない: ${entry.id} / ${forbidden.term}`);
      }
      for (const source of forbidden.allowKeyPaths ?? []) {
        try {
          new RegExp(source);
        } catch {
          problems.push(`allowKeyPaths が RegExp として解釈できない: ${entry.id} / ${source}`);
        }
      }
    }
  }

  // 同一 locale で禁止語が重複していないか
  for (const locale of ['ja', 'en'] as const) {
    const seenTerms = new Map<string, string>();
    for (const entry of glossary) {
      for (const forbidden of entry.forbidden ?? []) {
        if (forbidden.locale !== locale) continue;
        const owner = seenTerms.get(forbidden.term);
        if (owner) {
          problems.push(`禁止語が重複 (${locale}): "${forbidden.term}" — ${owner} と ${entry.id}`);
        }
        seenTerms.set(forbidden.term, entry.id);
      }
    }
  }

  // 正解語が禁止語に当たらないこと
  for (const locale of ['ja', 'en'] as const) {
    const rules = buildValueRules(glossary, locale);
    for (const entry of glossary) {
      if (entry.status !== 'current') continue;
      const word = locale === 'ja' ? entry.ja : entry.en;
      if (!word) continue;

      for (const rule of rules) {
        const owner = glossary.find((candidate) => candidate.id === rule.conceptId);
        const forbidden = owner?.forbidden?.find(
          (candidate) => candidate.term === rule.term && candidate.locale === locale,
        );
        if (forbidden?.allowConceptIds?.includes(entry.id)) continue;

        const violates = violatesValueRule(rule, {
          namespace: rule.onlyNamespaces[0] ?? '__registry__',
          keyPath: '__registry__',
          value: word,
        });
        if (violates) {
          problems.push(
            `正解語が禁止語に当たる (${locale}): ${entry.id} の "${word}" が ${rule.conceptId} の禁止語 "${rule.term}" にマッチする`,
          );
        }
      }
    }
  }

  const seenTokens = new Set<string>();
  for (const rule of keyNameRules) {
    if (seenTokens.has(rule.token)) problems.push(`キー名 token が重複: ${rule.token}`);
    seenTokens.add(rule.token);
    if (rule.token !== rule.token.toLowerCase()) {
      problems.push(`キー名 token は小文字で書く: ${rule.token}`);
    }
    for (const source of rule.allowKeyPaths ?? []) {
      try {
        new RegExp(source);
      } catch {
        problems.push(
          `キー名 allowKeyPaths が RegExp として解釈できない: ${rule.token} / ${source}`,
        );
      }
    }
  }

  return problems;
}

// ─── 生成（docs/product/glossary.md） ───

export const GENERATED_START =
  '<!-- glossary:generated:start — 正本 scripts/lib/glossary/terms.ts / 再生成 pnpm glossary:generate / 検証 pnpm glossary:check。この範囲は手編集しない -->';
export const GENERATED_END = '<!-- glossary:generated:end -->';

const STATUS_LABEL: Record<TermStatus, string> = {
  current: '現行',
  deprecated: '非推奨',
  'planned-removal': '廃止予定',
};

const ENFORCEMENT_LABEL: Record<Enforcement, string> = {
  active: 'CI 必須',
  migration: '移行中（警告）',
  'context-only': '人手',
};

function cell(value: string | undefined): string {
  return escapeMarkdownTableCell(value ?? '');
}

function joinCell(values: readonly string[] | undefined): string {
  if (!values || values.length === 0) return '—';
  return escapeMarkdownTableCell(values.map((v) => `\`${v}\``).join(' / '));
}

function codeCell(entry: GlossaryEntry): string {
  const parts: string[] = [];
  if (entry.code?.identifiers?.length) parts.push(...entry.code.identifiers);
  if (entry.code?.feature) parts.push(`features/${entry.code.feature}`);
  if (entry.code?.i18nNamespace) parts.push(`messages/${entry.code.i18nNamespace}.json`);
  return joinCell(parts);
}

function forbiddenCell(entry: GlossaryEntry, locale: Locale): string {
  const terms = (entry.forbidden ?? []).filter((f) => f.locale === locale).map((f) => f.term);
  return terms.length > 0 ? escapeMarkdownTableCell(terms.join(' / ')) : '—';
}

function table(header: readonly string[], rows: readonly (readonly string[])[]): string {
  const lines = [
    `| ${header.join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.join(' | ')} |`),
  ];
  return lines.join('\n');
}

export function renderGeneratedSections(
  glossary: readonly GlossaryEntry[],
  keyNameRules: readonly KeyNameRule[],
): string {
  const byLayer = (layer: GlossaryLayer, status: 'current' | 'not-current'): GlossaryEntry[] =>
    glossary.filter(
      (e) =>
        e.layer === layer &&
        (status === 'current' ? e.status === 'current' : e.status !== 'current'),
    );

  const sections: string[] = [];

  sections.push('## 用語表');
  sections.push('');
  sections.push(
    '1 概念 = 1 行。`ui` は UI 文言に出る呼称（`pnpm copy:check` の対象）、`design` は docs / spec でだけ使う設計語、`code` は識別子と DB 名の対応。',
  );
  sections.push('');

  sections.push('### UI 用語');
  sections.push('');
  sections.push(
    table(
      ['Concept', 'ja', 'en', 'code / DB', '禁止表記 (ja)', '禁止表記 (en)', '使い方'],
      byLayer('ui', 'current').map((e) => [
        cell(e.concept),
        cell(e.ja),
        cell(e.en),
        [codeCell(e), joinCell(e.db)].filter((v) => v !== '—').join('<br>') || '—',
        forbiddenCell(e, 'ja'),
        forbiddenCell(e, 'en'),
        cell(e.usage),
      ]),
    ),
  );
  sections.push('');

  sections.push('### 設計語（UI 文言には出さない）');
  sections.push('');
  sections.push(
    table(
      ['Concept', 'ja', 'en', '禁止表記 (ja)', '使い方'],
      byLayer('design', 'current').map((e) => [
        cell(e.concept),
        cell(e.ja),
        cell(e.en),
        forbiddenCell(e, 'ja'),
        cell(e.usage),
      ]),
    ),
  );
  sections.push('');

  sections.push('### コード内部語');
  sections.push('');
  sections.push(
    table(
      ['Concept', '識別子', 'DB', '意味', '状態'],
      byLayer('code', 'current')
        .concat(byLayer('code', 'not-current'))
        .map((e) => [
          cell(e.concept),
          codeCell(e),
          joinCell(e.db),
          cell(e.usage),
          STATUS_LABEL[e.status],
        ]),
    ),
  );
  sections.push('');

  const retiring = glossary.filter((e) => e.status === 'planned-removal');
  if (retiring.length > 0) {
    sections.push('### 廃止予定');
    sections.push('');
    sections.push(
      table(
        ['Concept', 'ja', 'en', 'DB / 識別子', '理由と参照'],
        retiring.map((e) => [
          cell(e.concept),
          cell(e.ja),
          cell(e.en),
          [joinCell(e.db), codeCell(e)].filter((v) => v !== '—').join('<br>') || '—',
          cell([e.usage, ...(e.refs ?? [])].join(' / ')),
        ]),
      ),
    );
    sections.push('');
  }

  // H2 名「禁止表記一覧」は外部からアンカー `#禁止表記一覧` で参照されている
  // （.agents/skills/i18n/SKILL.md、docs/engineering/i18n.md）。変更しない。
  sections.push('## 禁止表記一覧');
  sections.push('');
  sections.push(
    '`pnpm copy:check` が `apps/product/messages/{ja,en}` をスキャンする。`CI 必須` は `pnpm copy:check:strict`（`pnpm check:static` 経由）で exit 1 になる。',
  );
  sections.push('');

  const forbiddenRows: string[][] = [];
  for (const entry of glossary) {
    for (const forbidden of entry.forbidden ?? []) {
      if (forbidden.enforcement === 'context-only') continue;
      const allow = [
        ...(forbidden.allowIfValueIncludes ?? []).map((v) => `値に「${v}」`),
        ...(forbidden.allowKeyPaths ?? []).map((v) => `キー \`${v}\``),
        ...(forbidden.onlyNamespaces ?? []).map((v) => `\`${v}\` namespace のみ検査`),
        ...(forbidden.allowConceptIds ?? []).map((v) => `概念 \`${v}\``),
      ];
      forbiddenRows.push([
        cell(forbidden.term),
        forbidden.locale,
        cell((forbidden.locale === 'ja' ? entry.ja : entry.en) ?? entry.concept),
        ENFORCEMENT_LABEL[forbidden.enforcement],
        allow.length > 0 ? escapeMarkdownTableCell(allow.join(' / ')) : '—',
        cell(forbidden.reason),
      ]);
    }
  }
  sections.push(table(['禁止語', 'locale', '推奨', '強制', '例外', '理由'], forbiddenRows));
  sections.push('');

  sections.push('### キー名に使わない token');
  sections.push('');
  sections.push(
    'キーパスを `.` と camelCase 境界で分割した token と**完全一致**で判定する（`ariaLabel` の `label` や `sentryReport` の `sentry` を誤検知しないため）。値が正しくてもキー名が旧語彙だと、AI が既存キーを手本にして旧語彙を再生産する。',
  );
  sections.push('');
  sections.push(
    table(
      ['token', '推奨', '強制', '例外', '理由'],
      keyNameRules.map((rule) => [
        `\`${rule.token}\``,
        cell(rule.preferred),
        ENFORCEMENT_LABEL[rule.enforcement],
        rule.allowKeyPaths?.length
          ? escapeMarkdownTableCell(rule.allowKeyPaths.map((v) => `\`${v}\``).join(' / '))
          : '—',
        cell(rule.reason),
      ]),
    ),
  );
  sections.push('');

  sections.push('## スキャン対象外（誤検知防止）');
  sections.push('');
  sections.push('文脈によって正しい使い方があるため機械判定しない語。レビューで拾う。');
  sections.push('');

  const contextRows: string[][] = [];
  for (const entry of glossary) {
    for (const forbidden of entry.forbidden ?? []) {
      if (forbidden.enforcement !== 'context-only') continue;
      contextRows.push([
        cell(forbidden.term),
        forbidden.locale,
        cell((forbidden.locale === 'ja' ? entry.ja : entry.en) ?? entry.concept),
        cell(forbidden.reason),
      ]);
    }
  }
  for (const rule of keyNameRules.filter((r) => r.enforcement === 'context-only')) {
    contextRows.push([`\`${rule.token}\`（キー名）`, '—', cell(rule.preferred), cell(rule.reason)]);
  }
  sections.push(table(['語句', 'locale', '推奨', '理由'], contextRows));

  return sections.join('\n');
}

/** glossary.md の生成ブロックを差し替える。マーカーが無ければ throw（fail closed） */
export function replaceGeneratedBlock(markdown: string, generated: string): string {
  const startIndex = markdown.indexOf(GENERATED_START);
  const endIndex = markdown.indexOf(GENERATED_END);

  if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) {
    throw new Error(
      'glossary.md に生成マーカーが見つかりません（glossary:generated:start / end）。手で復元してください。',
    );
  }

  const before = markdown.slice(0, startIndex);
  const after = markdown.slice(endIndex + GENERATED_END.length);

  return `${before}${GENERATED_START}\n\n${generated}\n\n${GENERATED_END}${after}`;
}
