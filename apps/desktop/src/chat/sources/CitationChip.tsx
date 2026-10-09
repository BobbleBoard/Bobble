/**
 * A CITATION IN THE ANSWER: the chip after a claim, and the card it opens.
 *
 * The user's reference (Google's overview, 2026-09-24): "[icon] Harvard Medical
 * School +1" sitting after a sentence, and hovering it opens a card listing
 * that chip's sources. Here the chip is the site's icon and short name, "+N"
 * when several links sat together (rehype-citations merged them), and its card
 * is the app's menu sheet with one row per source.
 *
 * Reachable without a pointer: the chip is a button, so Tab lands on it; Enter
 * or Space opens the card with focus on its first link; Escape closes it and
 * puts focus back on the chip. A hover opens it without moving focus and
 * closes it when the pointer leaves both the chip and the card; a click pins
 * it open.
 *
 * A citation that is a whole line on its own — a model's "Sources:" list —
 * keeps its words (`standalone`): a reference list of bare site names would
 * throw away the titles the model chose, so it reads as a link with the
 * site's icon in front and the same card on hover.
 */
import { Popover, PopoverContent, PopoverTrigger } from '@pi-desktop/ui';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { SourceFavicon } from './SourceFavicon';
import { SourceRow } from './SourceRow';
import { siteLabel, type TurnSource } from './source-model';
import { useTurnSources } from './turn-sources';
import { useSourceMeta } from './use-source-meta';

const OPEN_DELAY_MS = 120;
const CLOSE_DELAY_MS = 180;

type Via = 'hover' | 'click' | 'keyboard';

function SourceCitation({
  sources,
  label,
  standalone,
}: {
  sources: readonly TurnSource[];
  label: string;
  standalone: boolean;
}) {
  const first = sources[0] as TurnSource;
  const meta = useSourceMeta(first.url);
  const name = siteLabel(meta?.siteName, first.host);
  const [open, setOpen] = useState(false);
  const via = useRef<Via>('hover');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const firstLink = useRef<HTMLDivElement>(null);

  const clear = (): void => {
    if (timer.current !== undefined) clearTimeout(timer.current);
    timer.current = undefined;
  };
  // A pending open or close must not fire into an unmounted chip.
  useEffect(
    () => () => {
      if (timer.current !== undefined) clearTimeout(timer.current);
    },
    [],
  );
  const hoverOpen = (): void => {
    clear();
    if (open) return;
    timer.current = setTimeout(() => {
      via.current = 'hover';
      setOpen(true);
    }, OPEN_DELAY_MS);
  };
  const hoverClose = (): void => {
    clear();
    // A card opened on purpose (click, keyboard) stays until dismissed.
    if (via.current !== 'hover') return;
    timer.current = setTimeout(() => setOpen(false), CLOSE_DELAY_MS);
  };

  const others = sources.length - 1;
  const spoken =
    others > 0 ? `${name} and ${others} more source${others === 1 ? '' : 's'}` : `Source: ${name}`;

  const trigger: ReactNode = standalone ? (
    <>
      <SourceFavicon icon={meta?.icon} host={first.host} name={meta?.siteName} size={16} />
      <span className="pd-cite-line-text">{label !== '' ? label : name}</span>
    </>
  ) : (
    <>
      <SourceFavicon icon={meta?.icon} host={first.host} name={meta?.siteName} size={14} />
      <span className="pd-cite-name">{name}</span>
      {others > 0 ? <span className="pd-cite-more">+{others}</span> : null}
    </>
  );

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        clear();
        setOpen(next);
      }}
    >
      <PopoverTrigger
        className={standalone ? 'pd-cite-line pd-focusable' : 'pd-cite pd-focusable'}
        data-testid="source-chip"
        data-count={sources.length}
        data-standalone={standalone ? 'true' : undefined}
        aria-label={spoken}
        onPointerEnter={(e) => {
          if (e.pointerType === 'mouse') hoverOpen();
        }}
        onPointerLeave={hoverClose}
        onClick={(e) => {
          // Radix would toggle; a click (or Enter/Space, which arrive as a click
          // with no detail) always OPENS, and says how, for the focus rules below.
          e.preventDefault();
          clear();
          via.current = e.detail === 0 ? 'keyboard' : 'click';
          setOpen(true);
        }}
      >
        {trigger}
      </PopoverTrigger>
      <PopoverContent
        side="bottom"
        align="start"
        sideOffset={6}
        collisionPadding={16}
        className="pd-cite-card pd-menu--instant"
        data-testid="source-hovercard"
        aria-label={others > 0 ? `Sources: ${name} and ${others} more` : `Source: ${name}`}
        onPointerEnter={clear}
        onPointerLeave={hoverClose}
        onOpenAutoFocus={(e) => {
          // A hover must not pull focus out of whatever the person is doing;
          // opened on purpose, focus goes to the first source's link.
          e.preventDefault();
          if (via.current !== 'hover') {
            firstLink.current?.querySelector<HTMLElement>('.pd-src-row-title')?.focus();
          }
        }}
        onCloseAutoFocus={(e) => {
          if (via.current === 'hover') e.preventDefault();
        }}
      >
        <div ref={firstLink} className="pd-cite-card-list">
          {sources.map((s) => (
            <SourceRow
              key={s.key}
              source={s}
              variant="popover"
              active={open}
              onOpened={() => setOpen(false)}
            />
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * The `pd-cite` element rehype-citations leaves where a run of source links
 * was: its keys name the sources, its label is the first link's own words.
 */
export function CiteElement({ node }: { node?: { properties?: Record<string, unknown> } }) {
  const turn = useTurnSources();
  const props = node?.properties ?? {};
  const keys = String(props.dataKeys ?? '')
    .split(/\s+/)
    .filter(Boolean);
  const label = String(props.dataLabel ?? '');
  const sources = keys
    .map((k) => turn?.byKey.get(k))
    .filter((s): s is TurnSource => s !== undefined);
  if (sources.length === 0) return <span>{label}</span>;
  return (
    <SourceCitation sources={sources} label={label} standalone={props.dataStandalone === 'true'} />
  );
}
