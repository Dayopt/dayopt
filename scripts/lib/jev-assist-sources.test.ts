import { describe, expect, it, vi } from 'vitest';
import {
  assertPublicRepository,
  contextFromSource,
  evidenceEndpoint,
  loadClaimEvidence,
} from './jev-assist-sources.ts';

const sha = 'a'.repeat(40);
const input = {
  schemaVersion: 1,
  target: { number: 1, sha },
  claims: [{ id: 'c', text: '主張', evidenceIds: ['e'] }],
  evidence: [{ id: 'e', kind: 'blob', path: 'test.ts', sha }],
};

describe('公開資料だけを参照する', () => {
  it.each([
    'https://evil.example/Dayopt/dayopt/issues/1',
    'https://github.com/other/repo/issues/1',
    'https://github.com/Dayopt/dayopt/issues/1?secret=x',
    'https://github.com/Dayopt/dayopt/../../private/repo/issues/1',
  ])('不正な参照URL %s を拒否する', (url) => expect(() => evidenceEndpoint(url)).toThrow());
  it('comment URLとworkflow runをGET endpointに解決する', () => {
    expect(
      evidenceEndpoint('https://github.com/Dayopt/dayopt/issues/1#issuecomment-123').endpoint,
    ).toBe('repos/Dayopt/dayopt/issues/comments/123');
    expect(evidenceEndpoint('https://github.com/Dayopt/dayopt/actions/runs/123').kind).toBe('run');
  });
  it('privateまたは取得失敗なら公開と推定しない', () => {
    expect(() =>
      assertPublicRepository(() => ({ full_name: 'Dayopt/dayopt', private: true })),
    ).toThrow();
    expect(() => assertPublicRepository(() => ({}))).toThrow();
  });
  it('不正入力を外部取得より先に拒否する', () => {
    const api = vi.fn();
    expect(() =>
      loadClaimEvidence(
        { ...input, evidence: [{ ...input.evidence[0], path: '../private' }] },
        api,
      ),
    ).toThrow();
    expect(api).not.toHaveBeenCalled();
  });
  it('指定SHAに存在しない公開資料を不足として残す', () => {
    const api = vi.fn((path: string) => {
      if (path.endsWith('dayopt')) return { full_name: 'Dayopt/dayopt', private: false };
      if (path.includes('/commits/')) return { sha };
      throw new Error('not found');
    });
    expect(loadClaimEvidence(input, api).evidence[0]).toMatchObject({
      id: 'e',
      missing: 'source_unavailable',
      text: '',
    });
  });
  it('公開実行結果からSHAとconclusionを取得しexit codeを創作しない', () => {
    const api = (path: string) =>
      path.endsWith('dayopt')
        ? { full_name: 'Dayopt/dayopt', private: false }
        : path.includes('/commits/')
          ? { sha }
          : {
              head_sha: sha,
              status: 'completed',
              conclusion: 'failure',
              html_url: 'https://github.com/Dayopt/dayopt/actions/runs/1',
            };
    const value = loadClaimEvidence(
      {
        ...input,
        evidence: [
          { id: 'e', kind: 'github', url: 'https://github.com/Dayopt/dayopt/actions/runs/1' },
        ],
      },
      api,
    );
    expect(value.evidence[0]).toMatchObject({
      sha,
      facts: { conclusion: 'failure', exitCode: null },
    });
  });
  it('コメント原文を切り詰めず、関連PR・決定ログにも参照を付ける', () => {
    const result = contextFromSource(1, sha, {
      title: 'title',
      body: 'body',
      url: 'https://github.com/Dayopt/dayopt/issues/1',
      updatedAt: null,
      comments: [{ id: 7, body: 'a\n'.repeat(20), updated_at: '2026-09-20' }],
      related: [{ number: 2, title: 'PR', body: 'constraint' }],
      decisions: ['- 2026-09-19: #1 制約'],
    });
    expect(result.candidates[1].text.split('\n')).toHaveLength(21);
    expect(result.candidates.map((candidate) => candidate.kind)).toEqual([
      'issue',
      'comment',
      'related',
      'decision',
    ]);
  });
});
