import { clsx } from 'clsx';
import type { HTMLAttributes } from 'react';
import { forwardRef, useMemo } from 'react';
import { highlightCode, splitHighlightedLines } from '../highlight.ts';
import { useCopyFeedback } from './copy-button.tsx';
import { IconCheck, IconCopy } from './icons.tsx';

export type ProseProps = HTMLAttributes<HTMLDivElement>;

/**
 * Prose container — spec-markdown.md. Voice/width from response tokens;
 * flavor rhythm lives in prose.css. W3 renders markdown into it.
 */
export const Prose = forwardRef<HTMLDivElement, ProseProps>(function Prose(
  { className, ...rest },
  ref,
) {
  return <div ref={ref} className={clsx('pd-prose', className)} {...rest} />;
});

export interface CodeBlockProps extends Omit<HTMLAttributes<HTMLDivElement>, 'onCopy'> {
  code: string;
  language?: string;
  showLineNumbers?: boolean;
  onCopy?: (code: string) => void;
}

/**
 * Code block — spec-markdown.md. Claude's zero-width sticky copy rail adopted
 * for both flavors; panel chrome on the code theme's surface; line numbers are
 * copy-safe (attr() pseudo-content).
 *
 * SYNTAX HIGHLIGHTED, from the code theme. The fence is run through
 * highlight.js (see ../highlight.ts) and its `hljs-*` classes resolve to the
 * `--pd-syntax-*` variables in styles/syntax.css — the same variables the
 * canvas editor reads, so a fence and the file it came from agree, and the
 * Appearance settings' choice of theme lands here without this component
 * knowing a single colour. A `diff` fence gets the theme's added/removed row
 * tints. Pass pre-rendered `children` to skip all of it.
 */
export const CodeBlock = forwardRef<HTMLDivElement, CodeBlockProps>(function CodeBlock(
  { code, language, showLineNumbers = false, onCopy, className, children, ...rest },
  ref,
) {
  const { copied, copy } = useCopyFeedback({ onCopy });
  const handleCopy = () => copy(code);

  const highlighted = useMemo(
    () => (children === undefined ? highlightCode(code, language) : null),
    [children, code, language],
  );
  const lines = useMemo(
    () =>
      highlighted !== null && showLineNumbers ? splitHighlightedLines(highlighted.html) : null,
    [highlighted, showLineNumbers],
  );

  /*
   * The HTML set below is highlight.js output: every character of the source
   * is escaped by it (or by escapeHtml for a plain fence), and the only markup
   * is `<span class="hljs-…">`. Nothing the model wrote reaches the DOM as
   * markup.
   */
  let body = children;
  if (body === undefined && highlighted !== null) {
    body =
      lines !== null ? (
        lines.map((line, index) => {
          const lineNumber = index + 1;
          return (
            <span
              key={lineNumber}
              className="pd-code-line"
              data-line-number={lineNumber}
              // biome-ignore lint/security/noDangerouslySetInnerHtml: highlight.js output — the source is fully escaped, the only markup is its own class spans
              dangerouslySetInnerHTML={{ __html: `${line}\n` }}
            />
          );
        })
      ) : (
        <span
          // biome-ignore lint/security/noDangerouslySetInnerHtml: highlight.js output — the source is fully escaped, the only markup is its own class spans
          dangerouslySetInnerHTML={{ __html: highlighted.html }}
        />
      );
  }

  return (
    <div
      ref={ref}
      className={clsx(
        'pd-code-block',
        highlighted?.language === 'diff' && 'pd-code-block--diff',
        className,
      )}
      data-language={highlighted?.language ?? undefined}
      {...rest}
    >
      <div className="pd-code-block-rail">
        <button
          type="button"
          className="pd-btn pd-btn--ghost pd-icon-btn pd-btn--sm pd-code-block-copy"
          aria-label={copied ? 'Copied' : 'Copy code'}
          onClick={handleCopy}
        >
          {copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
        </button>
      </div>
      {language !== undefined ? <div className="pd-code-block-lang">{language}</div> : null}
      <pre className="pd-scroll">
        <code className={highlighted !== null ? 'hljs' : undefined}>{body}</code>
      </pre>
    </div>
  );
});
