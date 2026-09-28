import type { ComponentProps } from 'react';

import { cn } from '../cn';

import { Button, type ButtonProps } from './button';

export type FloatingActionBarProps = ComponentProps<'div'>;
export type FloatingActionBarItemProps = ButtonProps;

/** アイコンと短いラベルの操作を、コンパクトなカプセル状の背景にまとめる。 */
export function FloatingActionBar({ className, ...props }: FloatingActionBarProps) {
  return (
    <div
      className={cn(
        'bg-card border-border-subtle grid w-fit auto-cols-fr grid-flow-col gap-1 rounded-full border p-1 shadow-sm',
        className,
      )}
      {...props}
    />
  );
}

/** children にアイコンとラベルを渡す操作。asChild で a やルーターの Link も使用できる。 */
export function FloatingActionBarItem({
  className,
  type = 'button',
  ...props
}: FloatingActionBarItemProps) {
  return (
    <Button
      type={props.asChild ? undefined : type}
      variant="ghost"
      size="sm"
      {...props}
      className={cn(
        'h-11 min-w-11 flex-col gap-1 rounded-full px-3 text-xs [&_svg]:size-4',
        className,
      )}
    />
  );
}
