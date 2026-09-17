/**
 * `docs/engineering/invariants.md` §時刻 の「規則の写しと、その分類」表を text 正本として読み、
 * 時刻規則の流れ図（DB trigger → (a) 契約変換 → (b) UX 先回り）を Mermaid で描く。
 *
 * 表を別ファイルへ複製しない。正本は表そのもので、この module は表の読み手と描き手だけを持つ。
 */

export interface DbTimeRule {
  /** `DT003` 等の DB error code */
  code: string;
  /** その行の最初の code span（`end_at > start_at` 等） */
  expression: string;
}

export interface TimeRuleMirror {
  kind: 'a' | 'b';
  kindLabel: string;
  /** `apps/product/src/` からの相対 path */
  paths: string[];
  /** 場所セルの backtick のうち path でないもの（symbol や `case 'DROP'`） */
  symbols: string[];
  role: string;
  removable: boolean;
  removableNote: string;
}

export interface TimeRulesSection {
  dbRules: DbTimeRule[];
  mirrors: TimeRuleMirror[];
}

const SECTION_HEADING = '## 時刻';
const TABLE_HEADING = '### 規則の写しと、その分類';

function codeSpans(text: string): string[] {
  return [...text.matchAll(/`([^`]+)`/g)].map((match) => match[1]);
}

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((cell) => cell.trim());
}

export function parseTimeRulesSection(markdown: string): TimeRulesSection {
  const lines = markdown.split('\n');
  const start = lines.findIndex((line) => line.trim() === SECTION_HEADING);
  if (start === -1) throw new Error(`invariants.md に「${SECTION_HEADING}」がありません`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^## /.test(lines[i])) {
      end = i;
      break;
    }
  }
  const section = lines.slice(start, end);

  const tableStart = section.findIndex((line) => line.trim() === TABLE_HEADING);
  if (tableStart === -1) throw new Error(`invariants.md §時刻 に「${TABLE_HEADING}」がありません`);

  // 箇条書き 1 項目は複数行に折り返されるので、`-` で始まる行から次の項目までを 1 項目に束ねる
  const items: string[] = [];
  for (const line of section.slice(0, tableStart)) {
    if (line.trim() === '') continue;
    if (/^\s*[-*]\s/.test(line) || items.length === 0) {
      items.push(line);
    } else {
      items[items.length - 1] += ` ${line.trim()}`;
    }
  }
  const dbRules: DbTimeRule[] = [];
  const seenCodes = new Set<string>();
  for (const item of items) {
    const code = item.match(/`(DT\d{3})`/);
    if (!code || seenCodes.has(code[1])) continue;
    const expression = codeSpans(item).find((span) => span !== code[1]);
    if (expression === undefined) continue;
    seenCodes.add(code[1]);
    dbRules.push({ code: code[1], expression });
  }
  if (dbRules.length === 0)
    throw new Error('invariants.md §時刻 に DB error code（DTnnn）がありません');

  const mirrors: TimeRuleMirror[] = [];
  let headerSeen = false;
  for (const line of section.slice(tableStart)) {
    if (!line.trim().startsWith('|')) {
      if (headerSeen && mirrors.length > 0) break;
      continue;
    }
    const cells = splitRow(line);
    if (!headerSeen) {
      headerSeen = true;
      continue;
    }
    if (cells.every((cell) => /^-+$/.test(cell))) continue;
    if (cells.length < 4) throw new Error(`写し表の列数が 4 未満です: ${line}`);
    const [kindCell, locationCell, role, removableCell] = cells;
    const kindMatch = kindCell.match(/^\((a|b)\)\s*(.*)$/);
    if (!kindMatch) throw new Error(`写し表の分類が (a) / (b) で始まっていません: ${kindCell}`);
    const spans = codeSpans(locationCell);
    const paths = spans.filter((span) => /\.(ts|tsx)$/.test(span));
    if (paths.length === 0)
      throw new Error(`写し表の場所に .ts / .tsx path がありません: ${locationCell}`);
    if (!/^(可|不可)/.test(removableCell)) {
      throw new Error(`写し表の「消してよいか」が 可 / 不可 で始まっていません: ${removableCell}`);
    }
    mirrors.push({
      kind: kindMatch[1] as 'a' | 'b',
      kindLabel: kindMatch[2],
      paths,
      symbols: spans.filter((span) => !paths.includes(span)),
      role,
      removable: removableCell.startsWith('可'),
      removableNote: removableCell,
    });
  }
  if (mirrors.length === 0) throw new Error('invariants.md §時刻 の写し表に行がありません');

  return { dbRules, mirrors };
}

function escapeLabel(text: string): string {
  return text.replace(/"/g, '#quot;').replace(/</g, '#lt;').replace(/>/g, '#gt;');
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/** 時刻規則の流れ図。実線 = 契約変換（消せない写し）、点線 = UX 先回り（server が同じ規則で拒否する）。 */
export function renderTimeRulesDiagram(section: TimeRulesSection): string {
  const lines: string[] = ['flowchart LR'];

  lines.push('  subgraph db["DB trigger（正）"]');
  for (const rule of section.dbRules) {
    lines.push(`    ${rule.code}["${rule.code}<br/>${escapeLabel(rule.expression)}"]`);
  }
  lines.push('  end');

  const groups: Array<{ kind: 'a' | 'b'; id: string }> = [
    { kind: 'a', id: 'contract' },
    { kind: 'b', id: 'ux' },
  ];
  const nodeIds = new Map<TimeRuleMirror, string>();
  for (const group of groups) {
    const mirrors = section.mirrors.filter((mirror) => mirror.kind === group.kind);
    if (mirrors.length === 0) continue;
    lines.push(`  subgraph ${group.id}["(${group.kind}) ${escapeLabel(mirrors[0].kindLabel)}"]`);
    mirrors.forEach((mirror, index) => {
      const id = `${group.id}${index + 1}`;
      nodeIds.set(mirror, id);
      const label = [
        ...mirror.paths.map(basename),
        ...mirror.symbols,
        mirror.removable ? '消してよい' : '消せない',
      ]
        .map(escapeLabel)
        .join('<br/>');
      lines.push(`    ${id}["${label}"]`);
    });
    lines.push('  end');
  }

  for (const mirror of section.mirrors) {
    const id = nodeIds.get(mirror);
    if (id === undefined) continue;
    lines.push(mirror.kind === 'a' ? `  db --> ${id}` : `  db -.-> ${id}`);
  }

  const removable = section.mirrors
    .filter((mirror) => mirror.removable)
    .map((mirror) => nodeIds.get(mirror))
    .filter((id): id is string => id !== undefined);
  if (removable.length > 0) {
    lines.push('  classDef removable stroke-dasharray: 4 2');
    lines.push(`  class ${removable.join(',')} removable`);
  }

  return lines.join('\n');
}
