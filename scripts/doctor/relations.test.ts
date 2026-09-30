import { expect, it } from 'vitest';
import { previewReferences } from './relations.ts';
it('flags old Preview refs without claiming inaccessible projects were deleted', () => {
  const result = previewReferences([
    {
      key: 'vercel.product.public_bindings',
      environment: 'all',
      source: 'fixture',
      value: [
        {
          key: 'NEXT_PUBLIC_SUPABASE_URL',
          target: ['preview'],
          gitBranch: 'old-branch',
          value: 'https://xjkcookekempigbmmkdj.supabase.co',
        },
      ],
    },
    {
      key: 'supabase.branches',
      environment: 'shared',
      source: 'fixture',
      value: [{ project_ref: 'tilwaprottpyhlfoggbb' }],
    },
  ]);
  expect(result).toMatchObject({
    status: 'blocked',
    reason: 'preview_ref_not_in_accessible_branch_list',
    value: [
      {
        branch: 'old-branch',
        project_ref: 'xjkcookekempigbmmkdj',
        accessible_branch_list_match: false,
      },
    ],
  });
});
it('never treats missing evidence as no branches', () => {
  expect(previewReferences([]).status).toBe('blocked');
});
