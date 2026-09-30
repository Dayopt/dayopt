import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { NoteSection } from './NoteSection';

describe('NoteSection', () => {
  it('複数行の入力を改行ごと保持して変更通知する', () => {
    const onNoteChange = vi.fn();
    render(<NoteSection label="メモ" note="" onNoteChange={onNoteChange} />);

    const textarea = screen.getByRole('textbox', { name: 'メモ' });
    fireEvent.change(textarea, { target: { value: '1行目\n2行目' } });

    expect(textarea.tagName).toBe('TEXTAREA');
    expect(textarea).toHaveAttribute('data-slot', 'textarea');
    expect(textarea).toHaveClass('field-sizing-content', 'w-full');
    expect(textarea).toHaveValue('1行目\n2行目');
    expect(onNoteChange).toHaveBeenLastCalledWith('1行目\n2行目');
  });
});
