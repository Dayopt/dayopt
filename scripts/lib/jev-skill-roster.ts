/**
 * `skill-suggestion` pack が候補にする skill の一覧と、SKILL.md の読み取り（#2827）。
 *
 * **候補は code で絞る（deck を作る）。** 24 skill のうち Jev に聞くのは、issue の内容から
 * 発火する 12 個だけ。「明示依頼時のみ」の skill（audit-ai-config / blog-ideas / decision /
 * docs-audit / gardening / releasing / ui-audit）と、工程で発火する skill
 * （dispatch / routing / mcp-usage / pr-cross-review / skill-design）は
 * issue 本文からは決まらないので聞かない。pr-cross-review は今どおり path / 保護対象 gate
 * から機械的に出す（`ctx.mjs` の `mapSkills`）。
 *
 * 12 は `JEV_MAX_QUESTIONS` ちょうど。13 個目を足す時は別の question set にする。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const SKILL_ROSTER_IDS = [
  'supabase',
  'trpc-router-creating',
  'store-creating',
  'storybook',
  'i18n',
  'error-handling',
  'optimistic-update',
  'security',
  'test',
  'diagnosing-bugs',
  'react-performance',
  'docs-writing',
] as const;

export type SkillId = (typeof SKILL_ROSTER_IDS)[number];

export type SkillDoc = {
  id: SkillId;
  /** frontmatter の `description:` 1 行。 */
  description: string;
  /** `## When to Use` 直下の箇条書き。太字の小見出しは含めない。 */
  whenToUse: string[];
};

export function isSkillId(value: string): value is SkillId {
  return (SKILL_ROSTER_IDS as readonly string[]).includes(value);
}

/** 質問 ID。hyphen を含む ID が SDK を通るかは未検証なので underscore に正規化する。 */
export function questionIdFor(skillId: SkillId): string {
  return `skill_${skillId.replace(/-/g, '_')}`;
}

export function skillIdFor(questionId: string): SkillId | null {
  const match = /^skill_(.+)$/.exec(questionId);
  if (!match) return null;
  const candidate = match[1]?.replace(/_/g, '-') ?? '';
  return isSkillId(candidate) ? candidate : null;
}

/**
 * SKILL.md から description と When to Use の箇条書きを取り出す。
 * どちらかが無い skill は空で返す（呼び出し側が検査する）。
 */
export function parseSkillDoc(markdown: string): { description: string; whenToUse: string[] } {
  const lines = markdown.split('\n');
  let description = '';
  for (const line of lines) {
    const match = /^description:\s*(.*)$/.exec(line);
    if (match) {
      description = (match[1] ?? '').trim().replace(/^["']|["']$/g, '');
      break;
    }
  }

  const whenToUse: string[] = [];
  const start = lines.findIndex((line) => /^##\s+When to Use\s*$/i.test(line.trim()));
  if (start >= 0) {
    for (const line of lines.slice(start + 1)) {
      if (/^##\s/.test(line)) break;
      const bullet = /^\s*[-*]\s+(.+)$/.exec(line);
      if (bullet?.[1]) whenToUse.push(bullet[1].trim());
    }
  }
  return { description, whenToUse };
}

export function loadSkillRoster(
  root: string,
  ids: readonly SkillId[] = SKILL_ROSTER_IDS,
): SkillDoc[] {
  return ids.map((id) => {
    const markdown = readFileSync(join(root, '.agents', 'skills', id, 'SKILL.md'), 'utf8');
    return { id, ...parseSkillDoc(markdown) };
  });
}
