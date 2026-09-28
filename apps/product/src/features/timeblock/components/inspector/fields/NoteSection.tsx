'use client';

import type { LucideIcon } from 'lucide-react';
import { useId, useMemo, useState } from 'react';

import { Textarea } from '@dayopt/components';

import { convertNoteHtmlToText } from './note-html-to-text';

interface NoteSectionProps {
  label: string;
  icon?: LucideIcon | undefined;
  note: string;
  onNoteChange: (text: string) => void;
  disabled?: boolean | undefined;
  maxLength?: number | undefined;
}

/** Inspector専用の、入力内容に合わせて高さが広がるメモ欄。 */
export function NoteSection({
  label,
  icon: Icon,
  note,
  onNoteChange,
  disabled = false,
  maxLength = 1000,
}: NoteSectionProps) {
  const inputId = useId();
  const displayNote = useMemo(() => convertNoteHtmlToText(note), [note]);
  const [localNote, setLocalNote] = useState(displayNote);
  const [isFocused, setIsFocused] = useState(false);
  const [previousDisplayNote, setPreviousDisplayNote] = useState(displayNote);

  if (previousDisplayNote !== displayNote) {
    setPreviousDisplayNote(displayNote);
    if (!isFocused) setLocalNote(displayNote);
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <label htmlFor={inputId} className="flex items-center gap-2 text-sm">
          {Icon && <Icon className="text-muted-foreground size-4 shrink-0" />}
          <span className="text-muted-foreground">{label}</span>
        </label>
        <span
          id={`${inputId}-counter`}
          className="text-muted-foreground -mr-2 px-2 text-xs tabular-nums"
        >
          {localNote.length}/{maxLength}
        </span>
      </div>
      <Textarea
        id={inputId}
        value={localNote}
        onChange={(event) => {
          setLocalNote(event.target.value);
          onNoteChange(event.target.value);
        }}
        onFocus={() => setIsFocused(true)}
        onBlur={() => {
          setIsFocused(false);
          setLocalNote(displayNote);
        }}
        disabled={disabled}
        maxLength={maxLength}
        aria-describedby={`${inputId}-counter`}
        className="resize-none text-sm"
      />
    </div>
  );
}
