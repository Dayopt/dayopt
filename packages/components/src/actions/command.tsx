'use client';

import { Command as CommandPrimitive } from 'cmdk';
import { SearchIcon } from 'lucide-react';
import * as React from 'react';

import { cn } from '../cn';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  type DialogMobilePresentation,
} from '../overlays/dialog';

const Command = ({ className, ...props }: React.ComponentProps<typeof CommandPrimitive>) => {
  return (
    <CommandPrimitive
      data-slot="command"
      // elevation-exempt: Popover / Dialog の中身として使う primitive。影は親が持つ
      className={cn(
        'bg-card text-card-foreground flex h-full w-full flex-col overflow-hidden rounded-lg',
        className,
      )}
      {...props}
    />
  );
};

const CommandDialog = ({
  title = 'Command Palette',
  description = 'Search for a command to run...',
  children,
  className,
  showCloseButton = true,
  mobilePresentation = 'sheet',
  handleOnly,
  ...props
}: React.ComponentProps<typeof Dialog> & {
  title?: string;
  description?: string;
  className?: string;
  showCloseButton?: boolean;
  mobilePresentation?: DialogMobilePresentation;
}) => {
  // full-height（内部スクロール主体）は既定でハンドルのみでスワイプ dismiss させ、
  // リスト内のスクロールが誤って閉じるのを防ぐ。呼び出し側で明示指定した場合はそちらを優先。
  const resolvedHandleOnly = handleOnly ?? mobilePresentation === 'full-height';

  return (
    <Dialog handleOnly={resolvedHandleOnly} {...props}>
      <DialogHeader className="sr-only">
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{description}</DialogDescription>
      </DialogHeader>
      <DialogContent
        className={cn(className, 'overflow-hidden p-0')}
        showCloseButton={showCloseButton}
        mobilePresentation={mobilePresentation}
      >
        <Command>{children}</Command>
      </DialogContent>
    </Dialog>
  );
};

const CommandInput = ({
  className,
  containerClassName,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Input> & {
  /** 検索iconとinputを包む外枠のclass。 */
  containerClassName?: string;
}) => {
  return (
    <div
      data-slot="command-input-wrapper"
      className={cn(
        'border-b-border flex h-10 items-center gap-2 border-b px-4',
        containerClassName,
      )}
    >
      <SearchIcon className="size-4 shrink-0 opacity-50" />
      <CommandPrimitive.Input
        data-slot="command-input"
        inputMode="search"
        enterKeyHint="search"
        className={cn(
          'flex h-10 w-full rounded-lg bg-transparent py-4 text-sm outline-hidden',
          'placeholder:text-muted-foreground',
          'disabled:cursor-not-allowed disabled:opacity-50',
          className,
        )}
        {...props}
      />
    </div>
  );
};

const CommandList = ({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.List>) => {
  return (
    <CommandPrimitive.List
      data-slot="command-list"
      className={cn('max-h-80 scroll-py-1 overflow-x-hidden overflow-y-auto', className)}
      {...props}
    />
  );
};

const CommandEmpty = ({ ...props }: React.ComponentProps<typeof CommandPrimitive.Empty>) => {
  return (
    <CommandPrimitive.Empty
      data-slot="command-empty"
      className="py-6 text-center text-sm"
      {...props}
    />
  );
};

const CommandGroup = ({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Group>) => {
  return (
    <CommandPrimitive.Group
      data-slot="command-group"
      className={cn(
        'text-foreground [&_[cmdk-group-heading]]:text-muted-foreground overflow-hidden p-2 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-2 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-normal',
        className,
      )}
      {...props}
    />
  );
};

const CommandSeparator = ({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Separator>) => {
  return (
    <CommandPrimitive.Separator
      data-slot="command-separator"
      className={cn('bg-border -mx-1 h-px', className)}
      {...props}
    />
  );
};

const CommandItem = ({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Item>) => {
  return (
    <CommandPrimitive.Item
      data-slot="command-item"
      className={cn(
        "data-[selected=true]:bg-state-selected [&_svg:not([class*='text-'])]:text-muted-foreground relative flex min-h-11 cursor-default items-center gap-2 rounded-lg px-2 py-2 text-sm outline-hidden select-none data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      {...props}
    />
  );
};

const CommandShortcut = ({ className, ...props }: React.ComponentProps<'span'>) => {
  return (
    <span
      data-slot="command-shortcut"
      className={cn(
        'text-muted-foreground ml-auto hidden text-xs tracking-widest md:inline',
        className,
      )}
      {...props}
    />
  );
};

export {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
};
