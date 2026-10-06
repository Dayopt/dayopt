'use client';

import { Button, cn, Input } from '@dayopt/components';
import { Search, X } from 'lucide-react';
import { useEffect, useState } from 'react';

interface SearchInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  clearLabel: string;
  className?: string;
}

export function SearchInput({
  value,
  onChange,
  placeholder,
  clearLabel,
  className,
}: SearchInputProps) {
  const [interactive, setInteractive] = useState(false);
  useEffect(() => setInteractive(true), []);

  return (
    <div className={cn('relative', className)}>
      <Search
        className="text-muted-foreground absolute top-1/2 left-3 size-4 -translate-y-1/2"
        aria-hidden="true"
      />
      <Input
        type="text"
        role="searchbox"
        disabled={!interactive}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="pr-12 pl-10"
      />
      {value && (
        <Button
          disabled={!interactive}
          onClick={() => onChange('')}
          variant="ghost"
          icon
          className="absolute top-1/2 right-2 size-6 -translate-y-1/2"
          aria-label={clearLabel}
        >
          <X className="size-4" />
        </Button>
      )}
    </div>
  );
}
