import { generateAnchorId } from '@web/features/docs/lib/toc';
import type { MDXComponents } from 'mdx/types';
import Image from 'next/image';
import type { ComponentPropsWithoutRef, ReactNode } from 'react';

// ─── Type Definitions ───────────────────────────────────────────────

type HeadingProps = ComponentPropsWithoutRef<'h1'> & { children?: ReactNode };
type ParagraphProps = ComponentPropsWithoutRef<'p'>;
type AnchorProps = ComponentPropsWithoutRef<'a'> & { href?: string };
type BlockquoteProps = ComponentPropsWithoutRef<'blockquote'>;
type CodeProps = ComponentPropsWithoutRef<'code'>;
type PreProps = ComponentPropsWithoutRef<'pre'>;
type ListProps = ComponentPropsWithoutRef<'ul'>;
type OrderedListProps = ComponentPropsWithoutRef<'ol'>;
type ListItemProps = ComponentPropsWithoutRef<'li'>;
type ImageProps = ComponentPropsWithoutRef<'img'> & { src?: string; alt?: string };
type TableProps = ComponentPropsWithoutRef<'table'>;
type TheadProps = ComponentPropsWithoutRef<'thead'>;
type TbodyProps = ComponentPropsWithoutRef<'tbody'>;
type TrProps = ComponentPropsWithoutRef<'tr'>;
type ThProps = ComponentPropsWithoutRef<'th'>;
type TdProps = ComponentPropsWithoutRef<'td'>;

// ─── Anchor ID Helper ───────────────────────────────────────────────

function getAnchorId(children?: ReactNode): string {
  const text = children?.toString() || '';
  return generateAnchorId(text);
}

// ─── Alert Component ────────────────────────────────────────────────

function Alert({
  type = 'info',
  children,
}: {
  type?: 'info' | 'warning' | 'error' | 'success';
  children: React.ReactNode;
}) {
  const styles = {
    info: 'bg-muted border-info text-info',
    warning: 'bg-muted border-warning text-warning',
    error: 'bg-muted border-destructive text-destructive',
    success: 'bg-muted border-success text-success',
  };

  const icons = {
    info: (
      <svg className="size-5" fill="currentColor" viewBox="0 0 20 20">
        <path
          fillRule="evenodd"
          d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z"
          clipRule="evenodd"
        />
      </svg>
    ),
    warning: (
      <svg className="size-5" fill="currentColor" viewBox="0 0 20 20">
        <path
          fillRule="evenodd"
          d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z"
          clipRule="evenodd"
        />
      </svg>
    ),
    error: (
      <svg className="size-5" fill="currentColor" viewBox="0 0 20 20">
        <path
          fillRule="evenodd"
          d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z"
          clipRule="evenodd"
        />
      </svg>
    ),
    success: (
      <svg className="size-5" fill="currentColor" viewBox="0 0 20 20">
        <path
          fillRule="evenodd"
          d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
          clipRule="evenodd"
        />
      </svg>
    ),
  };

  return (
    <div className={`my-4 rounded-lg border p-4 ${styles[type]}`}>
      <div className="flex items-start">
        <div className="mt-1 mr-4 flex-shrink-0">{icons[type]}</div>
        <div className="flex-1">{children}</div>
      </div>
    </div>
  );
}

// ─── Base MDX Components ────────────────────────────────────────────

export const contentMDXComponents: MDXComponents = {
  // Headings
  h1: (props: HeadingProps) => {
    const id = getAnchorId(props.children);
    return (
      <h1
        id={id}
        className="text-foreground mt-8 mb-4 text-4xl font-medium first:mt-0"
        {...props}
      />
    );
  },
  h2: (props: HeadingProps) => {
    const id = getAnchorId(props.children);
    return <h2 id={id} className="text-foreground mt-8 mb-4 text-3xl font-medium" {...props} />;
  },
  h3: (props: HeadingProps) => {
    const id = getAnchorId(props.children);
    return <h3 id={id} className="text-foreground mt-6 mb-4 text-2xl font-medium" {...props} />;
  },
  h4: (props: HeadingProps) => {
    const id = getAnchorId(props.children);
    return <h4 id={id} className="text-foreground mt-6 mb-4 text-xl font-medium" {...props} />;
  },

  // Text
  p: (props: ParagraphProps) => <p className="text-foreground mb-4 text-xl leading-7" {...props} />,

  // Links
  a: (props: AnchorProps) => (
    <a
      className="text-primary hover:text-primary/80 underline underline-offset-2"
      target={props.href?.startsWith('http') ? '_blank' : undefined}
      rel={props.href?.startsWith('http') ? 'noopener noreferrer' : undefined}
      {...props}
    />
  ),

  // Blockquote
  blockquote: (props: BlockquoteProps) => (
    <blockquote
      className="border-info bg-muted text-foreground my-6 rounded-r-lg border-l-4 py-2 pl-4 text-xl italic"
      {...props}
    />
  ),

  // Code
  code: (props: CodeProps) => (
    <code
      className="bg-muted text-foreground rounded-lg px-2 py-1 font-mono text-base"
      {...props}
    />
  ),
  pre: (props: PreProps) => (
    <pre
      tabIndex={0}
      className="bg-muted text-foreground my-6 overflow-x-auto rounded-lg p-4 text-base"
      {...props}
    />
  ),

  // Lists
  ul: (props: ListProps) => (
    <ul className="text-foreground mb-4 list-inside list-disc space-y-2 text-xl" {...props} />
  ),
  ol: (props: OrderedListProps) => (
    <ol className="text-foreground mb-4 list-inside list-decimal space-y-2 text-xl" {...props} />
  ),
  li: (props: ListItemProps) => <li className="text-xl leading-7" {...props} />,

  // Images
  img: (props: ImageProps) => (
    <div className="relative my-6 overflow-hidden rounded-lg">
      <Image
        className="rounded-lg shadow-sm"
        loading="lazy"
        width={800}
        height={600}
        style={{ width: '100%', height: 'auto' }}
        alt={props.alt || 'Image'}
        src={props.src || ''}
      />
    </div>
  ),

  // Inline text formatting
  strong: (props: ComponentPropsWithoutRef<'strong'>) => (
    <strong className="text-foreground font-medium" {...props} />
  ),
  em: (props: ComponentPropsWithoutRef<'em'>) => (
    <em className="text-foreground italic" {...props} />
  ),
  del: (props: ComponentPropsWithoutRef<'del'>) => (
    <del className="text-muted-foreground line-through" {...props} />
  ),

  // Tables
  table: (props: TableProps) => (
    <div className="my-6 overflow-x-auto" tabIndex={0}>
      <table
        className="divide-border border-border min-w-full divide-y rounded-lg border"
        {...props}
      />
    </div>
  ),
  thead: (props: TheadProps) => <thead className="bg-container" {...props} />,
  tbody: (props: TbodyProps) => <tbody className="divide-border divide-y" {...props} />,
  tr: (props: TrProps) => <tr className="hover:bg-state-hover transition-colors" {...props} />,
  th: (props: ThProps) => (
    <th
      className="bg-container text-muted-foreground px-6 py-4 text-left text-sm font-medium tracking-wider uppercase"
      {...props}
    />
  ),
  td: (props: TdProps) => (
    <td className="text-foreground px-6 py-4 text-base whitespace-nowrap" {...props} />
  ),

  // Horizontal rule
  hr: (props: ComponentPropsWithoutRef<'hr'>) => <hr className="border-border my-8" {...props} />,

  // Alert
  Alert,
};

/**
 * 共通 MDX コンポーネントにコンテンツタイプ固有のオーバーライドをマージする
 */
export function createMDXComponents(overrides?: Record<string, unknown>): MDXComponents {
  return { ...contentMDXComponents, ...overrides } as MDXComponents;
}
