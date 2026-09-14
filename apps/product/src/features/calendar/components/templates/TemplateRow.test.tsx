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

it('クリックで適用した後はプレビューを畳み、行を離れて再ホバーすると出る', async () => {
  const user = userEvent.setup();
  const apply = vi.fn();
  render(<TemplateRow template={{ id: 'test', name: '朝', blocks: [] }} onApply={apply} />);
  const row = screen.getByRole('listitem');
  const button = screen.getByRole('button', { name: '朝' });

  await user.hover(row);
  expect(button).toHaveAttribute('aria-expanded', 'true');

  await user.click(button);
  expect(apply).toHaveBeenCalledOnce();
  expect(button).toHaveAttribute('aria-expanded', 'false');

  await user.unhover(row);
  await user.hover(row);
  expect(button).toHaveAttribute('aria-expanded', 'true');
});

it('Tab でフォーカスした時はプレビューを出す（キーボードでも到達できる）', async () => {
  const user = userEvent.setup();
  render(<TemplateRow template={{ id: 'test', name: '朝', blocks: [] }} />);
  const button = screen.getByRole('button', { name: '朝' });

  await user.tab();
  expect(button).toHaveFocus();
  expect(button).toHaveAttribute('aria-expanded', 'true');
});
