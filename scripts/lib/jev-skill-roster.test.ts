import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  SKILL_ROSTER_IDS,
  loadSkillRoster,
  parseSkillDoc,
  questionIdFor,
  skillIdFor,
} from './jev-skill-roster.ts';

const repoRoot = join(import.meta.dirname, '../..');

const fixture = `---
name: sample
description: 新規 migration を追加する時に発動。RLS を編集する時にも使う。
---

# Sample

## When to Use

以下の状況で発動:

- \`supabase/migrations/*.sql\` を追加する時
**小見出し:**
- RLS ポリシーを変更する時
* Storage ポリシーを編集する時

## When NOT to Use

- アプリ層だけの変更
`;

describe('parseSkillDoc', () => {
  it('description と When to Use の箇条書きだけを取り出す', () => {
    const parsed = parseSkillDoc(fixture);
    expect(parsed.description).toBe(
      '新規 migration を追加する時に発動。RLS を編集する時にも使う。',
    );
    expect(parsed.whenToUse).toEqual([
      '`supabase/migrations/*.sql` を追加する時',
      'RLS ポリシーを変更する時',
      'Storage ポリシーを編集する時',
    ]);
  });

  it('section が無ければ空で返す', () => {
    expect(parseSkillDoc('# nothing')).toEqual({ description: '', whenToUse: [] });
  });
});

describe('loadSkillRoster', () => {
  it('実 repo の 12 skill に description と箇条書きがある', () => {
    const roster = loadSkillRoster(repoRoot);
    expect(roster.map((doc) => doc.id)).toEqual([...SKILL_ROSTER_IDS]);
    for (const doc of roster) {
      expect(doc.description, doc.id).not.toBe('');
      expect(doc.whenToUse.length, doc.id).toBeGreaterThan(0);
    }
  });
});

describe('question id', () => {
  it('hyphen を underscore にして往復できる', () => {
    expect(questionIdFor('trpc-router-creating')).toBe('skill_trpc_router_creating');
    expect(skillIdFor('skill_trpc_router_creating')).toBe('trpc-router-creating');
    expect(skillIdFor('skill_unknown')).toBeNull();
    expect(skillIdFor('lane')).toBeNull();
  });
});
