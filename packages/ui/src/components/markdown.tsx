import { clsx } from 'clsx';
import type { ComponentPropsWithoutRef, HTMLAttributes, ReactNode } from 'react';
import { forwardRef, isValidElement, useMemo } from 'react';
import ReactMarkdown, {
  type Components,
  defaultUrlTransform,
  type ExtraProps,
  type Options,
} from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { CodeBlock } from './code-block.tsx';
import { useOpenUrl } from './web-search.js';

/*
 * Reusable markdown renderer (round-3 #P4). react-markdown + remark-gfm +
 * remark-math + rehype-katex, rendered into a `.pd-prose` container so it reads
 * in the flavor's response voice. Custom renderers:
 *   - fenced code  -> CodeBlock (the sticky-copy panel)
 *   - inline code  -> a subtle rounded mono box; if the token IS a hex color
 *                     (`#0a84ff`) a small swatch chip is shown before it
 *   - tables       -> wrapped in the prose scroll container
 * Math degrades gracefully (rehype-katex throwOnError:false — bad LaTeX renders
 * as tinted source instead of crashing the tree).
 *
 * KaTeX offline handling (integration contract): the stylesheet is imported from
 * the package here (`katex/dist/katex.min.css`), so the app's bundler (Vite /
 * electron-vite) inlines it and rewrites the KaTeX font URLs to LOCAL bundled
 * assets — no runtime/external font fetch. Nothing else is required; because the
 * CSS is pulled through a JS import (not a file under src/styles/**), it does not
 * pass through the token styles-hygiene rule.
 */
import 'katex/dist/katex.min.css';

/** Flatten a React node tree to its text content. */
function toText(node: ReactNode): string {
  if (node === null || node === undefined || node === false || node === true) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(toText).join('');
  if (isValidElement(node)) {
    return toText((node.props as { children?: ReactNode }).children);
  }
  return '';
}

/** Return the normalized `#rgb|#rgba|#rrggbb|#rrggbbaa` if the text IS one hex color. */
function hexColor(text: string): string | null {
  const match = /^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.exec(text.trim());
  return match ? `#${match[1]}` : null;
}

/** Fenced code block → the shared CodeBlock panel. */
function PreBlock({ children }: ComponentPropsWithoutRef<'pre'> & ExtraProps) {
  const codeEl = Array.isArray(children) ? children[0] : children;
  if (isValidElement(codeEl)) {
    const props = codeEl.props as { className?: string; children?: ReactNode };
    const language = /language-([\w-]+)/.exec(props.className ?? '')?.[1];
    const code = toText(props.children).replace(/\n$/, '');
    return <CodeBlock code={code} language={language} />;
  }
  return <pre className="pd-scroll">{children}</pre>;
}

/** Inline code chip; prefixes a color swatch when the token is a hex color. */
function InlineCode({ className, children }: ComponentPropsWithoutRef<'code'> & ExtraProps) {
  const hex = hexColor(toText(children));
  return (
    <code className={clsx('pd-md-code', className)}>
      {hex ? (
        <span className="pd-md-swatch" style={{ backgroundColor: hex }} aria-hidden="true" />
      ) : null}
      {children}
    </code>
  );
}

/** Tables break out of the prose column into their own scroll container. */
function TableBlock({ children }: ComponentPropsWithoutRef<'table'> & ExtraProps) {
  return (
    <div className="pd-prose-table-wrap">
      <table>{children}</table>
    </div>
  );
}

/**
 * A LINK THAT ACTUALLY GOES SOMEWHERE.
 *
 * Every hyperlink in every reply was inert: the anchor rendered, the click
 * scheduled a navigation, and the main process cancelled it — so a model that
 * cited its sources produced a list of dead text. The app already owns a
 * browser surface and already installs an opener for search results; this
 * routes markdown links through the same one, so a citation opens beside the
 * conversation it came from rather than burying it under a browser session.
 *
 * REFUSES `file:` AND `javascript:`. Link text in a reply is model-authored and
 * can be model-quoted from a web page, so it is untrusted input that reaches a
 * click handler. Anything that is not http(s) or mailto renders as plain text
 * rather than as something that looks clickable and does something else.
 */
function MarkdownLink({
  href,
  children,
  node: _node,
  ...rest
}: ComponentPropsWithoutRef<'a'> & ExtraProps): ReactNode {
  const openUrl = useOpenUrl();
  const safe = href !== undefined && /^(https?:|mailto:)/i.test(href.trim());
  if (!safe) return <span {...rest}>{children}</span>;
  const url = href.trim();
  return (
    <a
      {...rest}
      href={url}
      onClick={(e) => {
        if (openUrl === undefined) return;
        e.preventDefault();
        openUrl(url);
      }}
    >
      {children}
    </a>
  );
}

const MARKDOWN_COMPONENTS: Components = {
  pre: PreBlock,
  code: InlineCode,
  table: TableBlock,
  a: MarkdownLink,
};

/** Minimal mdast shape the display-math promotion needs (avoids an @types/mdast dep). */
interface MathTreeNode {
  type: string;
  value?: string;
  children?: MathTreeNode[];
  position?: { start?: { offset?: number } };
  data?: { hProperties?: { className?: string[] } };
}

/**
 * remark plugin: promote a standalone `$$…$$` paragraph to DISPLAY math.
 * remark-math tokenizes `$$…$$` written on a single line as INLINE text-math
 * (only a fenced `$$`\n…\n`$$` block becomes flow/display), so single-line
 * block equations render left-aligned inline with no `.katex-display` wrapper —
 * the center+scroll rule in markdown.css then never applies. This walks the AST
 * (so fenced code is untouched) and, when a paragraph is exactly one inlineMath
 * whose source really starts with `$$` (a lone `$x$` stays inline), swaps its
 * hast class to `math-display` so rehype-katex renders it in display mode.
 */
function remarkDisplayMath() {
  return (tree: MathTreeNode, file: { value?: unknown }) => {
    const source = typeof file.value === 'string' ? file.value : '';
    const promote = (node: MathTreeNode): void => {
      const children = node.children;
      if (!children) return;
      if (node.type === 'paragraph') {
        const content = children.filter(
          (child) => !(child.type === 'text' && (child.value ?? '').trim() === ''),
        );
        const only = content[0];
        const offset = only?.position?.start?.offset;
        if (
          content.length === 1 &&
          only?.type === 'inlineMath' &&
          typeof offset === 'number' &&
          source.slice(offset, offset + 2) === '$$'
        ) {
          only.data = {
            ...only.data,
            hProperties: {
              ...only.data?.hProperties,
              className: ['language-math', 'math-display'],
            },
          };
        }
        return;
      }
      for (const child of children) promote(child);
    };
    promote(tree);
  };
}

const REMARK_PLUGINS: Options['remarkPlugins'] = [remarkGfm, remarkMath, remarkDisplayMath];
const REHYPE_PLUGINS: Options['rehypePlugins'] = [
  [rehypeKatex, { throwOnError: false, errorColor: 'currentColor' }],
];

export interface MarkdownProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  /** The markdown source to render (a plain string). */
  children: string;
  /** Per-element overrides merged OVER the defaults (a host's `img`, say, that
   * can reach files the design system cannot know about). */
  components?: Partial<Components>;
  /** react-markdown's URL sanitiser; the default drops every scheme but http,
   * https and mailto. A host with its own media scheme widens it here. */
  urlTransform?: Options['urlTransform'];
  /** A host's own tree passes, run AFTER the defaults (the app's citation
   * grouping — links to a turn's sources becoming one chip). */
  rehypePlugins?: Options['rehypePlugins'];
}

/**
 * The default sanitiser, letting URLs that match `keep` through untouched — for
 * a host with its own media scheme. Everything else is judged as before.
 */
export function widenUrlTransform(keep: RegExp): NonNullable<Options['urlTransform']> {
  return (value) => (keep.test(value) ? value : defaultUrlTransform(value));
}

/**
 * A STREAMED LINE THAT IS NOT FINISHED YET must not be read as structure.
 *
 * MEASURED by the flicker guard (tests/e2e/flicker.mjs, 2026-09-16) on a 4B's
 * streamed reply: "I have the data:" followed by a lone "-" — the first byte
 * of "- 2021: 12" — is, to CommonMark, a setext underline, so the paragraph
 * above it became an <h2> for one frame and snapped back to a <p> when the
 * next byte arrived. Every bulleted list that follows a paragraph flashed
 * its lead-in as a heading. The same trailing fragment can open an empty
 * code fence ("`") or a thematic break ("--"). Such a tail is held back
 * until the line has more in it; on a finished message the same characters
 * alone on the last line mean nothing anyway.
 */
export function holdBackPartialTail(text: string): string {
  return (
    text
      .replace(/(^|\n)[ \t]{0,3}[-=*_#`~]{1,3}[ \t]*$/, '$1')
      // A trailing "$" is either a price about to get its digits or a
      // formula's closing delimiter — unknowable until the next byte, and the
      // two render nothing alike (see guardCurrencyDollars).
      .replace(/(^|[^\\])\$$/, '$1')
  );
}

/**
 * A DOLLAR AMOUNT IS NOT A FORMULA.
 *
 * remark-math reads `$…$` as inline TeX, so "Revenue was $412,000, up 14% on
 * Q2, and margin $3" renders "412,000, up 14% on Q2, and margin" as an
 * equation — in italics, spaces gone — which is most of what a business deck
 * says. Pandoc's rule tells the two apart: a closing `$` may not be followed
 * by a digit. So a `$…$` pair whose closer is followed by a digit is not
 * math, and its opener is escaped; the closer is then free to open the next
 * pair, which is how "$5 to $10" and "from $12 and $19 each" both come out
 * as prices. Code spans and fences are left alone (a `$` in code is code).
 * MEASURED by the flicker guard (2026-09-17): streamed text with stray `$`s
 * rendered as KaTeX for a frame and snapped back — the same family.
 */
export function guardCurrencyDollars(text: string): string {
  let out = '';
  let i = 0;
  let inFence = false;
  const lines = text.split('\n');
  for (let li = 0; li < lines.length; li += 1) {
    const line = lines[li] as string;
    if (/^\s{0,3}(```|~~~)/.test(line)) {
      inFence = !inFence;
      out += (li > 0 ? '\n' : '') + line;
      continue;
    }
    if (inFence) {
      out += (li > 0 ? '\n' : '') + line;
      continue;
    }
    // Outside a fence: walk the line, skipping code spans, judging `$` pairs.
    let res = '';
    i = 0;
    while (i < line.length) {
      const ch = line[i] as string;
      if (ch === '`') {
        // A code span: copy through its matching backtick run verbatim.
        let run = 0;
        while (line[i + run] === '`') run += 1;
        const ticks = '`'.repeat(run);
        const close = line.indexOf(ticks, i + run);
        if (close === -1) {
          res += line.slice(i);
          i = line.length;
        } else {
          res += line.slice(i, close + run);
          i = close + run;
        }
        continue;
      }
      if (ch === '\\') {
        res += line.slice(i, i + 2);
        i += 2;
        continue;
      }
      if (ch === '$' && line[i + 1] !== '$') {
        // A candidate opener (remark-math pairs any two single `$`s, spaces
        // or not — it is a code span with a different fence); find its closer.
        let j = i + 1;
        let close = -1;
        while (j < line.length) {
          if (line[j] === '\\') {
            j += 2;
            continue;
          }
          if (line[j] === '$' && line[j + 1] !== '$') {
            close = j;
            break;
          }
          if (line[j] === '$') {
            j += 2;
            continue;
          }
          j += 1;
        }
        if (close !== -1 && /\d/.test(line[close + 1] ?? '')) {
          // Money, not math: the opener becomes literal, the scan resumes at
          // the closer, which may open the next pair.
          res += `\\$${line.slice(i + 1, close)}`;
          i = close;
          continue;
        }
        if (close !== -1) {
          res += line.slice(i, close + 1);
          i = close + 1;
          continue;
        }
      }
      res += ch;
      i += 1;
    }
    out += (li > 0 ? '\n' : '') + res;
  }
  return out;
}

/**
 * Render a markdown string into flavor-voiced prose. Drop-in for a text run:
 * pass the raw string as children; it renders its OWN `.pd-prose` container, so
 * hosts should not double-wrap it in `<Prose>`.
 */
export const Markdown = forwardRef<HTMLDivElement, MarkdownProps>(function Markdown(
  { children, className, components, urlTransform, rehypePlugins, ...rest },
  ref,
) {
  const merged = useMemo(
    () =>
      components === undefined ? MARKDOWN_COMPONENTS : { ...MARKDOWN_COMPONENTS, ...components },
    [components],
  );
  return (
    <div ref={ref} className={clsx('pd-prose', 'pd-markdown', className)} {...rest}>
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={
          rehypePlugins == null ? REHYPE_PLUGINS : [...(REHYPE_PLUGINS ?? []), ...rehypePlugins]
        }
        components={merged}
        {...(urlTransform === undefined ? {} : { urlTransform })}
      >
        {holdBackPartialTail(guardCurrencyDollars(children))}
      </ReactMarkdown>
    </div>
  );
});
