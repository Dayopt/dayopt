'use client';

/**
 * お問い合わせダイアログUI（Presentational）
 *
 * tRPC に依存しない純粋UIコンポーネント。
 * ContactDialog（Container）から呼ばれる。
 *
 * モバイル: Drawer（下からスライド）
 * デスクトップ: Dialog（中央モーダル）
 */

import { useCallback, useState } from 'react';

import { dayoptContact } from '@dayopt/config';

import { useIsMobile } from '@/lib/hooks/useIsMobile';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  Label,
  RadioGroup,
  RadioGroupItem,
  Textarea,
} from '@dayopt/components';

import type { ContactCategory } from '../types';

const CATEGORIES: ContactCategory[] = ['bug', 'feature', 'question', 'other'];

/** お問い合わせダイアログUIコンポーネントのProps */
export interface ContactDialogContentProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (input: { category: ContactCategory; message: string }) => void;
  isPending: boolean;
  categoryLabel: (category: ContactCategory) => string;
  labels: {
    title: string;
    description: string;
    categoryLabel: string;
    messageLabel: string;
    messagePlaceholder: string;
    messageMinLength: string;
    submit: string;
    cancel: string;
  };
}

/** フォーム本体（Dialog/Drawer 共通） */
function ContactForm({
  onSubmit,
  isPending,
  categoryLabel,
  labels,
  onClose,
  mobile,
}: {
  onSubmit: (input: { category: ContactCategory; message: string }) => void;
  isPending: boolean;
  categoryLabel: (category: ContactCategory) => string;
  labels: ContactDialogContentProps['labels'];
  onClose: () => void;
  mobile: boolean;
}) {
  const [category, setCategory] = useState<ContactCategory>('bug');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      if (message.trim().length < 10) {
        setError(labels.messageMinLength);
        return;
      }
      setError('');
      onSubmit({ category, message });
    },
    [category, message, onSubmit, labels.messageMinLength],
  );

  return (
    <form onSubmit={handleSubmit}>
      <div className="space-y-4 px-4 py-4 md:px-0">
        {/* カテゴリ */}
        <div className="space-y-2">
          <Label>{labels.categoryLabel}</Label>
          <RadioGroup
            value={category}
            onValueChange={(value: string) => setCategory(value as ContactCategory)}
            className="grid grid-cols-2 gap-2"
          >
            {CATEGORIES.map((cat) => (
              <Label
                key={cat}
                htmlFor={`contact-category-${cat}`}
                className="flex cursor-pointer items-center gap-2"
              >
                <RadioGroupItem id={`contact-category-${cat}`} value={cat} />
                <span className="text-sm">{categoryLabel(cat)}</span>
              </Label>
            ))}
          </RadioGroup>
        </div>

        {/* メッセージ */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label htmlFor="contact-message">{labels.messageLabel}</Label>
            <span className="text-muted-foreground text-xs tabular-nums">
              {message.length}/5000
            </span>
          </div>
          <Textarea
            id="contact-message"
            value={message}
            onChange={(e) => {
              setMessage(e.target.value);
              if (error) setError('');
            }}
            placeholder={labels.messagePlaceholder}
            maxLength={5000}
            className={`h-32 resize-none overflow-y-auto${error ? 'ring-destructive ring-2' : ''}`}
          />
          {error && <p className="text-destructive text-sm">{error}</p>}
        </div>
      </div>

      {/* フッター: 横並び */}
      <div className="flex flex-row justify-end gap-2 p-4 md:p-0 md:pt-4">
        <Button
          type="button"
          variant="outline"
          size={mobile ? 'lg' : 'default'}
          onClick={onClose}
          disabled={isPending}
        >
          {labels.cancel}
        </Button>
        <Button
          type="submit"
          size={mobile ? 'lg' : 'default'}
          loading={isPending}
          disabled={isPending}
        >
          {labels.submit}
        </Button>
      </div>
    </form>
  );
}

/** お問い合わせダイアログのUIコンポーネント（tRPC非依存のプレゼンテーション層） */
export function ContactDialogContent({
  open,
  onOpenChange,
  onSubmit,
  isPending,
  categoryLabel,
  labels,
}: ContactDialogContentProps) {
  const isMobile = useIsMobile();

  const handleOpenChange = useCallback(
    (isOpen: boolean) => {
      if (isPending) return;
      onOpenChange(isOpen);
    },
    [onOpenChange, isPending],
  );

  const handleClose = useCallback(() => {
    handleOpenChange(false);
  }, [handleOpenChange]);

  if (isMobile) {
    return (
      <Drawer open={open} onOpenChange={handleOpenChange}>
        <DrawerContent>
          <DrawerHeader className="text-left">
            <DrawerTitle>{labels.title}</DrawerTitle>
            <DrawerDescription>
              {labels.description}{' '}
              <a
                href={`mailto:${dayoptContact.supportEmail}`}
                className="text-primary-text underline underline-offset-2"
              >
                {dayoptContact.supportEmail}
              </a>
            </DrawerDescription>
          </DrawerHeader>

          <ContactForm
            onSubmit={onSubmit}
            isPending={isPending}
            categoryLabel={categoryLabel}
            labels={labels}
            onClose={handleClose}
            mobile
          />

          <DrawerFooter className="sr-only">
            <DrawerClose asChild>
              <span />
            </DrawerClose>
          </DrawerFooter>
        </DrawerContent>
      </Drawer>
    );
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader className="text-left">
          <DialogTitle>{labels.title}</DialogTitle>
          <DialogDescription>
            {labels.description}{' '}
            <a
              href={`mailto:${dayoptContact.supportEmail}`}
              className="text-primary-text underline underline-offset-2"
            >
              {dayoptContact.supportEmail}
            </a>
          </DialogDescription>
        </DialogHeader>

        <ContactForm
          onSubmit={onSubmit}
          isPending={isPending}
          categoryLabel={categoryLabel}
          labels={labels}
          onClose={handleClose}
          mobile={false}
        />
      </DialogContent>
    </Dialog>
  );
}
