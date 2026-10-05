import { Link } from '@dayopt/i18n/navigation';
import { createMDXComponents } from '@web/components/content/ContentMDXComponents';
import { generateAnchorId } from '@web/features/docs/lib/toc';
import type { MDXComponents } from 'mdx/types';
import type { ComponentPropsWithoutRef, ReactElement, ReactNode } from 'react';
import { CopyCodeButton } from './CopyCodeButton';

// ─── Docs-specific overrides ────────────────────────────────────────

type CodeBlockProps = ComponentPropsWithoutRef<'pre'> & {
  children?: ReactNode;
  className?: string;
};

type CodeComponentProps = ComponentPropsWithoutRef<'code'> & {
  children?: ReactNode;
  className?: string;
};

type PreComponentProps = ComponentPropsWithoutRef<'pre'> & {
  children?: ReactNode;
};

type CustomLinkProps = ComponentPropsWithoutRef<'a'> & {
  href?: string;
  children?: ReactNode;
};

// CopyCodeButton 付きコードブロック
function CodeBlock({ children, className }: CodeBlockProps) {
  let codeString = '';
  let codeClassName = className || '';

  if (children && typeof children === 'object' && 'props' in children) {
    const codeElement = children as ReactElement<{ children?: ReactNode; className?: string }>;
    codeString =
      typeof codeElement.props.children === 'string'
        ? codeElement.props.children
        : String(codeElement.props.children ?? '');
    codeClassName = codeElement.props.className || className || '';
  } else {
    codeString = typeof children === 'string' ? children : String(children ?? '');
  }

  const languageClass = codeClassName.match(/language-\w+/)?.[0] || '';

  return (
    <div className="group relative">
      <div className="absolute top-3 right-3 opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100">
        <CopyCodeButton code={codeString} />
      </div>
      <pre
        className={`hljs ${languageClass} bg-muted text-foreground overflow-x-auto rounded-lg p-4`}
      >
        <code className={languageClass}>{codeString}</code>
      </pre>
    </div>
  );
}

// 外部リンクアイコン付きリンク
function CustomLink({ href, children, ...props }: CustomLinkProps) {
  const isExternal = href?.startsWith('http');

  if (isExternal) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="text-primary hover:text-primary/80 underline"
        {...props}
      >
        {children}
        <svg className="ml-1 inline size-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"
          />
        </svg>
      </a>
    );
  }

  return (
    <Link href={href || '#'} className="text-primary hover:text-primary/80 underline" {...props}>
      {children}
    </Link>
  );
}

// ─── Docs MDX Components ────────────────────────────────────────────

const docsOverrides = {
  // Docs: CopyCodeButton 付きコードブロック
  code: ({ children, className }: CodeComponentProps) => {
    if (className) {
      return <CodeBlock className={className}>{children}</CodeBlock>;
    }
    return (
      <code className="bg-muted text-foreground rounded-lg px-2 py-1 font-mono text-base">
        {children}
      </code>
    );
  },
  pre: ({ children }: PreComponentProps) => <div className="my-6">{children}</div>,

  // Docs: 外部リンクアイコン付き
  a: CustomLink,
};

export const mdxComponents: MDXComponents = createMDXComponents(docsOverrides);

// ─── FAQ MDX Components ─────────────────────────────────────────────

type HeadingProps = ComponentPropsWithoutRef<'h2'> & { children?: ReactNode };
type ParagraphProps = ComponentPropsWithoutRef<'p'>;

export const faqMdxComponents: MDXComponents = createMDXComponents({
  ...docsOverrides,

  // FAQ: 質問スタイルの h2 — "Q." ラベル付きカード
  h2: (props: HeadingProps) => {
    const text = props.children?.toString() || '';
    const id = generateAnchorId(text);
    return (
      <h2
        id={id}
        className="border-border bg-container mt-10 flex items-baseline gap-3 rounded-lg border px-4 py-4 text-xl font-medium first:mt-0"
      >
        <span className="text-primary flex-shrink-0 text-base font-medium tracking-wide">Q.</span>
        <span className="text-foreground">{props.children}</span>
      </h2>
    );
  },

  // FAQ: 回答スタイルの p — "A." 風のインデント + 左ボーダー
  p: (props: ParagraphProps) => (
    <div className="border-primary/20 ml-2 border-l-2 py-1 pl-6">
      <p className="text-muted-foreground text-lg leading-7" {...props} />
    </div>
  ),
});
