/**
 * THE MODEL CARD, RENDERED PROPERLY.
 *
 * the user: "model card, come on, unsloth actually just totally renders it, links,
 * html, code blocks, videos images, inline tables everything. we should match
 * that at minimum."
 *
 * He is right, and the reason ours showed raw `<div> <p style="…">` as prose is
 * that the shared `Markdown` component has no `rehype-raw`: react-markdown drops
 * embedded HTML by default. HF cards are FULL of it — badge rows, centred logo
 * `<div>`s, `<img width>`, occasionally `<video>` — so a markdown-only renderer
 * shows a model card as source code.
 *
 * WHY THIS IS ITS OWN COMPONENT RATHER THAN A FLAG ON THE SHARED ONE.
 * Turning raw HTML on for `Markdown` would also turn it on for CHAT, where the
 * text is model output. Rendering arbitrary HTML from a language model is a
 * different risk decision entirely, and it is not one to make as a side effect
 * of improving a model browser. So the card gets its own pipeline.
 *
 * AND IT IS SANITISED, because a model card is third-party content fetched from
 * the internet. The allow-list is deliberately generous about presentation
 * (tables, images, headings, code, video) and absolute about behaviour: no
 * script, no event handlers, no iframes, no forms, and only http/https/mailto
 * hrefs. `rehype-sanitize` runs AFTER raw parsing, which is the only order that
 * actually protects anything.
 */
import { clsx } from 'clsx';
import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import remarkGfm from 'remark-gfm';

/**
 * The default schema plus what a model card legitimately needs, minus anything
 * that can act. Built from `defaultSchema` rather than written from scratch so
 * we inherit its protections instead of re-deriving them.
 */
const SCHEMA = {
  ...defaultSchema,
  tagNames: [
    ...(defaultSchema.tagNames ?? []),
    'img',
    'video',
    'source',
    'details',
    'summary',
    'center',
    'figure',
    'figcaption',
    'picture',
    'kbd',
    'sub',
    'sup',
  ],
  attributes: {
    ...defaultSchema.attributes,
    // `style` is allowed because cards lean on it for the centred badge rows the
    // reference renders; sanitize strips `expression()`/url() javascript.
    '*': [...(defaultSchema.attributes?.['*'] ?? []), 'style', 'align', 'width', 'height'],
    img: [...(defaultSchema.attributes?.img ?? []), 'src', 'alt', 'width', 'height', 'loading'],
    video: ['src', 'controls', 'poster', 'width', 'height', 'loop', 'muted', 'playsInline'],
    source: ['src', 'type'],
    a: [...(defaultSchema.attributes?.a ?? []), 'href', 'title', 'target', 'rel'],
  },
  protocols: {
    ...defaultSchema.protocols,
    href: ['http', 'https', 'mailto'],
    src: ['http', 'https', 'data'],
  },
} as const;

export const CARD_SANITIZE_SCHEMA = SCHEMA;

const REMARK = [remarkGfm];
// Order matters: raw first to parse the HTML, sanitize second to police it.
const REHYPE = [rehypeRaw, [rehypeSanitize, SCHEMA]] as never;

/**
 * One image from a card, routed through main's cache.
 *
 * A card's `<img src="https://github.com/...">` is blocked outright by the
 * renderer's CSP, so "we render the HTML now" still showed no pictures. Main
 * fetches and caches it, then hands back a `pd-file://` URL the renderer may
 * load — the same mechanism as the org avatars, and offline after first view.
 *
 * Renders nothing until it resolves rather than showing a broken-image glyph:
 * a torn icon in the middle of a card looks like our bug, not a slow network.
 */
const imgCache = new Map<string, Promise<string | undefined>>();

function cachedImage(url: string): Promise<string | undefined> {
  const hit = imgCache.get(url);
  if (hit !== undefined) return hit;
  const p = window.piDesktop
    .invoke('image:cache', { url })
    .then((r) => r.path)
    .catch(() => undefined);
  imgCache.set(url, p);
  return p;
}

function CardImage(props: { src?: string; alt?: string; width?: string | number }) {
  const { src, alt, width } = props;
  const [resolved, setResolved] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (src === undefined) return;
    // data: URIs are already loadable; only remote ones need the round trip.
    if (src.startsWith('data:') || src.startsWith('pd-file:')) {
      setResolved(src);
      return;
    }
    let live = true;
    void cachedImage(src).then((p) => {
      if (live) setResolved(p);
    });
    return () => {
      live = false;
    };
  }, [src]);

  if (resolved === undefined) return null;
  return <img src={resolved} alt={alt ?? ''} width={width} loading="lazy" />;
}

/**
 * THE PROMO FOR SOMEBODY ELSE'S MODEL, WHICH WE WERE LEADING WITH.
 *
 * MEASURED on TripoSR: the first line of our detail pane read "Try our new
 * model: SF3D with several improvements such as faster generation and more
 * game-ready assets" — a publisher's banner steering the reader to a model this
 * app does not offer, sitting above the name of the model they just clicked.
 * Announcement banners are a convention of the Hugging Face card, where the
 * repo page is a landing page; in a picker, they are an ad in the one place a
 * user goes for facts.
 *
 * WHY A SIGNATURE AND NOT "DROP EVERYTHING BEFORE THE FIRST HEADING". Plenty of
 * cards open with a real one-line description and no heading at all, and eating
 * that would trade one bad card for a hundred empty ones. So only two things go:
 * lines that are nothing but badges (shields.io rows, which render as a smear of
 * pills), and a leading paragraph that announces something — those start with a
 * small and recognisable set of openers. Anything else survives untouched.
 */
const ANNOUNCEMENT =
  /^\s*(?:>\s*)?(?:\[!\w+\]|\*\*)?\s*(?:🚨|🔥|⚡|📢|🎉|❗)?\s*(?:try (?:out )?our|check out our|new(?:ly released)?\s*[:!]|update\s*[:]|announcing|we (?:just )?(?:released|launched)|introducing our)/i;

const BADGES_ONLY = /^(?:\s*\[?!\[[^\]]*\]\([^)]*\)\]?(?:\([^)]*\))?\s*)+$/;

export function trimCardPreamble(markdown: string): string {
  /*
   * SPLIT ON BLANK LINES, INCLUDING THE ONES THAT ARE NOT EMPTY.
   *
   * MEASURED against the real stabilityai/TripoSR card: its banner and the
   * heading below it are separated by a line holding a single space. Splitting
   * on `\n{2,}` therefore saw ONE block — banner, heading, and the model's only
   * description — and the banner rule swallowed all three, which is how removing
   * an ad also removed the card. A "blank" line in markdown is a line with
   * nothing but whitespace on it, so that is what this splits on.
   */
  const blocks = markdown.split(/\n[ \t]*\n\s*/);
  let cut = 0;
  let dropped = false;
  while (cut < blocks.length) {
    const b = blocks[cut] ?? '';
    if (b.trim() === '') {
      cut += 1;
      continue;
    }
    // A heading means the card proper has started; never cut past it.
    if (/^\s{0,3}#{1,6}\s/.test(b)) break;
    if (BADGES_ONLY.test(b.trim()) || ANNOUNCEMENT.test(b)) {
      cut += 1;
      dropped = true;
      continue;
    }
    /*
     * A banner is usually two sentences, not one: the claim, then "the model is
     * available HERE and we also have a DEMO". Cutting only the first left the
     * pane opening on a dangling pair of links to a model we do not offer — so
     * once something has been dropped, a short link-carrying follow-on goes with
     * it. The length bound is what keeps this from eating a real description
     * that happens to cite a paper in its first paragraph.
     */
    if (dropped && b.length < 250 && /\]\(https?:/.test(b)) {
      cut += 1;
      continue;
    }
    break;
  }
  const kept = blocks.slice(cut).join('\n\n').trim();
  // Never hand back nothing: a card that is ONLY an announcement is still the
  // only description that exists, and an empty pane is worse than an odd one.
  return kept === '' ? markdown : kept;
}

export function ModelCard({
  markdown,
  className,
  onOpenLink,
}: {
  markdown: string;
  className?: string;
  /** Open a link the way the app opens links (external browser). */
  onOpenLink?: (url: string) => void;
}) {
  return (
    <div className={clsx('pd-model-card', className)} data-testid="model-card-body">
      <ReactMarkdown
        remarkPlugins={REMARK}
        rehypePlugins={REHYPE}
        components={{
          /*
           * Links leave the app rather than navigating the renderer. An <a> that
           * replaces the window is how a single-window Electron app loses its
           * own UI to huggingface.co with no way back.
           */
          a: ({ href, children, ...rest }) => (
            <a
              {...rest}
              href={href}
              onClick={(e) => {
                if (href === undefined) return;
                e.preventDefault();
                onOpenLink?.(href);
              }}
            >
              {children}
            </a>
          ),
          // Every image goes through main's cache — see CardImage.
          img: ({ src, alt, width }) => (
            <CardImage
              src={typeof src === 'string' ? src : undefined}
              alt={typeof alt === 'string' ? alt : undefined}
              width={typeof width === 'string' || typeof width === 'number' ? width : undefined}
            />
          ),
        }}
      >
        {trimCardPreamble(markdown)}
      </ReactMarkdown>
    </div>
  );
}
