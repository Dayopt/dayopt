import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }));

import { DropdownMenu } from '@dayopt/components';

import { ActivityRowMenu } from './ActivityRowMenu';

describe('ActivityRowMenu', () => {
  it('mobile menu includes the activity details action', async () => {
    const user = userEvent.setup();
    const onViewActivityDetails = vi.fn();
    render(
      <DropdownMenu open>
        <ActivityRowMenu
          currentCategoryId={null}
          categoryOptions={[]}
          isMobile
          onOpenRenameDialog={vi.fn()}
          onChangeCategory={vi.fn()}
          onShowOnlyActivity={vi.fn()}
          onViewActivityDetails={onViewActivityDetails}
        />
      </DropdownMenu>,
    );

    await user.click(screen.getByRole('menuitem', { name: 'calendar.filter.viewActivityDetails' }));

    expect(onViewActivityDetails).toHaveBeenCalledOnce();
  });
});
