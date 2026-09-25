/**
 * ONE SOURCE, AS A ROW — in the Sources card and in a chip's hover card.
 *
 * The reference (the user's screenshots of Google's overview, 2026-09-24): the
 * site's icon and name on the first line, the page's title under it, two lines
 * of what the page says, and the page's own picture at the right. Ours reads
 * the same way in the app's own ink ladder — name secondary, title primary,
 * snippet secondary, the host muted — on the app's surfaces.
 *
 * The whole row opens the page, the way every link in the chat does (the
 * canvas browser, beside the conversation); the title is the one control, and
 * its hit area stretches over the row so the thumbnail and the snippet are
 * part of the target without being buttons of their own. The ⋮ menu sits
 * above that and keeps its own clicks.
 */
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  IconCopy,
  IconExternal,
  IconGlobe,
  IconMore,
  useOpenUrl,
  writeClipboardText,
} from '@pi-desktop/ui';
import { SourceFavicon } from './SourceFavicon';
import { cleanTitle, siteLabel, type TurnSource } from './source-model';
import { useSourceMeta } from './use-source-meta';

/** The page opened in the system browser — the one way out of the app. */
function openOutside(url: string): void {
  void window.piDesktop.invoke('canvas:open-external', { url }).catch(() => undefined);
}

function RowMenu({ url }: { url: string }) {
  const openUrl = useOpenUrl();
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger
        className="pd-src-row-more pd-focusable"
        aria-label="More for this source"
        data-testid="source-row-more"
      >
        <IconMore size={16} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="pd-src-row-menu">
        {openUrl !== undefined ? (
          <DropdownMenuItem icon={<IconGlobe size={15} />} onSelect={() => openUrl(url)}>
            Open in Bobble
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem icon={<IconExternal size={15} />} onSelect={() => openOutside(url)}>
          Open in your browser
        </DropdownMenuItem>
        <DropdownMenuItem
          icon={<IconCopy size={15} />}
          onSelect={() => void writeClipboardText(url)}
        >
          Copy link
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function SourceRow({
  source,
  variant,
  active = true,
}: {
  source: TurnSource;
  /** `card` — the Sources card (with its ⋮ menu); `popover` — a chip's hover card. */
  variant: 'card' | 'popover';
  /** On screen: only then does the row ask main about the page. */
  active?: boolean;
}) {
  const openUrl = useOpenUrl();
  const meta = useSourceMeta(source.url, active);
  const name = siteLabel(meta?.siteName, source.host);
  const title = cleanTitle(source.title ?? meta?.title ?? source.url, meta?.siteName, source.host);
  const snippet = source.snippet ?? meta?.description;
  const thumb = meta?.image;
  const open = (): void => {
    if (openUrl !== undefined) openUrl(source.url);
    else openOutside(source.url);
  };
  return (
    <div
      className="pd-src-row"
      data-variant={variant}
      data-thumb={thumb !== undefined}
      data-testid="source-row"
      data-url={source.url}
    >
      <div className="pd-src-row-site">
        <SourceFavicon icon={meta?.icon} host={source.host} name={meta?.siteName} size={16} />
        <span className="pd-src-row-name">{name}</span>
        {name !== source.host ? <span className="pd-src-row-host">{source.host}</span> : null}
      </div>
      <div className="pd-src-row-text">
        <button
          type="button"
          className="pd-src-row-title"
          onClick={open}
          title={source.url}
          data-testid="source-row-title"
        >
          {title}
        </button>
        {snippet !== undefined ? <p className="pd-src-row-snippet">{snippet}</p> : null}
      </div>
      {thumb !== undefined ? (
        <img className="pd-src-row-thumb" src={thumb} alt="" data-role="thumb" draggable={false} />
      ) : null}
      {variant === 'card' ? <RowMenu url={source.url} /> : null}
    </div>
  );
}
