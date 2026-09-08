import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';

import { TemplateRow } from './TemplateRow';

vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }));

it('改名欄はテキスト入力として操作でき、Enter で名前を保存する', async () => {
  const user = userEvent.setup();
  const rename = vi.fn();
  render(<TemplateRow template={{ id: 'test', name: '朝', blocks: [] }} onRename={rename} />);
  fireEvent.contextMenu(screen.getByRole('button', { name: '朝' }));
  await user.click(screen.getByRole('menuitem', { name: 'common.actions.rename' }));
  const input = screen.getByRole('textbox', { name: 'calendar.templates.renameLabel' });
  await user.clear(input);
  await user.type(input, '朝の予定{Enter}');
  expect(rename).toHaveBeenCalledExactlyOnceWith('朝の予定');
});
