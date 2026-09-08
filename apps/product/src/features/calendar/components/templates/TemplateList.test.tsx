import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { TemplateList } from './TemplateList';

vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }));

describe('TemplateList available actions', () => {
  it('編集処理がないテンプレートのメニューに編集を出さない', () => {
    render(<TemplateList templates={[{ id: 't', name: '確認用', blocks: [] }]} />);
    fireEvent.contextMenu(screen.getByRole('button', { name: '確認用' }));
    expect(
      screen.queryByRole('menuitem', { name: 'calendar.templates.editLabel' }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'common.actions.rename' })).toBeInTheDocument();
  });

  it('does not offer creation or settings without handlers', () => {
    render(<TemplateList templates={[]} />);
    expect(
      screen.queryByRole('button', { name: 'calendar.templates.createLabel' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'calendar.templates.settingsLabel' }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('calendar.templates.empty');
  });

  it('読み込みと取得失敗を空一覧として扱わず再試行できる', () => {
    const retry = vi.fn();
    const { rerender } = render(<TemplateList templates={[]} isLoading />);
    expect(screen.getByRole('status')).toHaveTextContent('common.loading');
    expect(screen.queryByText('calendar.templates.empty')).not.toBeInTheDocument();
    rerender(<TemplateList templates={[]} isError onRetry={retry} />);
    expect(screen.getByRole('status')).toHaveTextContent('calendar.templates.loadFailed');
    fireEvent.click(screen.getByRole('button', { name: 'common.actions.retry' }));
    expect(retry).toHaveBeenCalledOnce();
  });

  it('runs each available action without introducing an extra step', () => {
    const create = vi.fn();
    const settings = vi.fn();
    render(<TemplateList templates={[]} onCreateEntry={create} onOpenSettings={settings} />);
    fireEvent.click(screen.getByRole('button', { name: 'calendar.templates.createLabel' }));
    expect(create).toHaveBeenCalledTimes(1);
    expect(settings).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'calendar.templates.settingsLabel' }));
    expect(settings).toHaveBeenCalledTimes(1);
  });
});
