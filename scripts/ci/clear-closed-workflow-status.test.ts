import { describe, expect, it, vi } from 'vitest';

import {
  clearClosedWorkflowStatusForIssue,
  collectBulkTargets,
  DEFAULT_BULK_BUDGET_SECONDS,
  findClosedIssuesWithWorkflowStatus,
  formatBulkInterruption,
  KNOWN_WORKFLOW_STATUSES,
  runBulkClear,
  WORKFLOW_STATUS_FIELD_ID,
  WORKFLOW_STATUS_FIELD_SLUG,
} from './clear-closed-workflow-status.mjs';

describe('clearClosedWorkflowStatusForIssue', () => {
  it('閉じた issue の Workflow status だけを消し、Priority とラベルには触れない', () => {
    const execFileImpl = vi.fn((_file: string, args: string[]) => {
      if (args[1] === 'repos/Dayopt/dayopt/issues/100') {
        return JSON.stringify({ state: 'closed' });
      }
      if (args[1] === 'repos/Dayopt/dayopt/issues/100/issue-field-values') {
        return JSON.stringify([
          {
            issue_field_id: 38713666,
            issue_field_name: 'Priority',
            single_select_option: { name: 'High' },
          },
          {
            issue_field_id: WORKFLOW_STATUS_FIELD_ID,
            issue_field_name: 'Workflow status',
            single_select_option: { name: 'In Progress' },
          },
        ]);
      }
      return '';
    });

    expect(clearClosedWorkflowStatusForIssue(100, { execFileImpl })).toBe('In Progress');
    const deleteCall = vi.mocked(execFileImpl).mock.calls.find((call) => call[1][2] === 'DELETE');
    expect(deleteCall?.[1]).toEqual([
      'api',
      '--method',
      'DELETE',
      `repos/Dayopt/dayopt/issues/100/issue-field-values/${WORKFLOW_STATUS_FIELD_ID}`,
    ]);
    expect(vi.mocked(execFileImpl).mock.calls).toHaveLength(3);
  });

  it('open issue の field 値は変更しない', () => {
    const execFileImpl = vi.fn(() => JSON.stringify({ state: 'open' }));
    expect(clearClosedWorkflowStatusForIssue(101, { execFileImpl })).toBeNull();
    expect(execFileImpl).toHaveBeenCalledTimes(1);
  });

  it('Workflow status が無ければ DELETE しない', () => {
    const execFileImpl = vi.fn((_file: string, args: string[]) =>
      args[1] === 'repos/Dayopt/dayopt/issues/102'
        ? JSON.stringify({ state: 'closed' })
        : JSON.stringify([{ issue_field_id: 38713666, single_select_option: { name: 'Low' } }]),
    );
    expect(clearClosedWorkflowStatusForIssue(102, { execFileImpl })).toBeNull();
    expect(execFileImpl).toHaveBeenCalledTimes(2);
  });
});

describe('findClosedIssuesWithWorkflowStatus', () => {
  it('filters closed issues by field slug and excludes PRs from paginated results', () => {
    const execFileImpl = vi.fn((_file: string, _args: string[]) =>
      JSON.stringify([
        [{ number: 10 }, { number: 11, pull_request: { url: 'https://example/pr/11' } }],
        [{ number: 5 }],
      ]),
    );
    expect(findClosedIssuesWithWorkflowStatus('In Progress', { execFileImpl })).toEqual([10, 5]);
    expect(vi.mocked(execFileImpl).mock.calls[0][1]).toEqual([
      'api',
      '--paginate',
      '--slurp',
      `repos/Dayopt/dayopt/issues?state=closed&per_page=100&issue_field_values=${encodeURIComponent(`${WORKFLOW_STATUS_FIELD_SLUG}:In Progress`)}`,
    ]);
  });
});

describe('collectBulkTargets', () => {
  it('all options are queried, duplicate issue results are collapsed, and targets are sorted', () => {
    const execFileImpl = vi.fn((_file: string, args: string[]) => {
      const endpoint = args.at(-1) ?? '';
      if (endpoint.endsWith(encodeURIComponent('workflow-status:Ready'))) {
        return JSON.stringify([[{ number: 20 }, { number: 5 }], [{ number: 5 }]]);
      }
      if (endpoint.endsWith(encodeURIComponent('workflow-status:In Progress'))) {
        return JSON.stringify([[{ number: 15 }]]);
      }
      return JSON.stringify([[]]);
    });
    expect(collectBulkTargets({ execFileImpl })).toEqual([
      { number: 5, status: 'Ready' },
      { number: 15, status: 'In Progress' },
      { number: 20, status: 'Ready' },
    ]);
    expect(vi.mocked(execFileImpl)).toHaveBeenCalledTimes(KNOWN_WORKFLOW_STATUSES.length);
  });
});

describe('runBulkClear', () => {
  const clockAdvancingBy = (stepMs: number) => {
    let now = 0;
    return () => {
      const current = now;
      now += stepMs;
      return current;
    };
  };
  const targets = [1, 2, 3].map((number) => ({ number, status: 'Ready' }));

  it('予算内なら全件処理し remaining 0 を返す', () => {
    const clearImpl = vi.fn(() => 'Ready');
    expect(
      runBulkClear({
        targets,
        budgetSeconds: 100,
        nowImpl: clockAdvancingBy(1000),
        clearImpl,
        logImpl: () => {},
      }),
    ).toEqual({ processed: 3, remaining: 0, lastProcessed: 3 });
    expect(clearImpl).toHaveBeenCalledTimes(3);
  });

  it('予算超過で打ち切り、残件と最後に処理した番号を返す', () => {
    const clearImpl = vi.fn(() => 'Ready');
    const result = runBulkClear({
      targets: [10, 20, 30, 40, 50].map((number) => ({ number, status: 'Ready' })),
      budgetSeconds: 5,
      nowImpl: clockAdvancingBy(2000),
      clearImpl,
      logImpl: () => {},
    });
    expect(result.processed).toBeLessThan(5);
    expect(result.remaining).toBe(5 - result.processed);
    expect(result.lastProcessed).toBe([10, 20, 30, 40, 50][result.processed - 1]);
    expect(clearImpl).toHaveBeenCalledTimes(result.processed);
  });

  it('予算が足りなければ 1 件も処理しない', () => {
    const clearImpl = vi.fn(() => null);
    const result = runBulkClear({
      targets,
      budgetSeconds: 0.001,
      nowImpl: clockAdvancingBy(1000),
      clearImpl,
      logImpl: () => {},
    });
    expect(result).toEqual({ processed: 0, remaining: 3, lastProcessed: undefined });
    expect(clearImpl).not.toHaveBeenCalled();
  });

  it('既定予算は nightly job の 10 分 timeout より短い', () => {
    expect(DEFAULT_BULK_BUDGET_SECONDS).toBeLessThan(600);
  });
});

describe('formatBulkInterruption', () => {
  it('最後の番号から再開するコマンドを出す', () => {
    expect(
      formatBulkInterruption({ processed: 407, remaining: 94, lastProcessed: 2242 }),
    ).toContain(
      'node scripts/ci/clear-closed-workflow-status.mjs bulk --execute --resume-from 2242',
    );
  });

  it('1 件も処理できない場合は resume-from を付けない', () => {
    const report = formatBulkInterruption({
      processed: 0,
      remaining: 12,
      lastProcessed: undefined,
    });
    expect(report).toContain('1 件も処理できませんでした');
    expect(report).not.toContain('--resume-from');
  });
});
