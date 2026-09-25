/**
 * A site's own icon, or a letter tile until (or unless) there is one.
 *
 * The icon is the SITE'S image, fetched from the site by main and handed over
 * as a `data:` URI — never drawn here, never a stand-in for a brand. The tile
 * is the app's own: the same inset square the search rows fall back to, so an
 * offline answer looks finished rather than broken.
 */
import { useState } from 'react';
import { useSiteIcon } from '../site-icons';

/** The letter a tile shows: the site's name, else its host's own label (not `en.` or `www.`). */
export function tileLetter(name: string | undefined, host: string): string {
  const fromName = name?.match(/[\p{L}\p{N}]/u)?.[0];
  if (fromName !== undefined) return fromName.toUpperCase();
  const labels = host.split('.').filter(Boolean);
  const main = labels.length >= 2 ? labels[labels.length - 2] : labels[0];
  return (main?.match(/[\p{L}\p{N}]/u)?.[0] ?? '#').toUpperCase();
}

export function SourceFavicon({
  icon,
  host,
  name,
  size,
}: {
  /** The page's own icon from its meta, when that has landed. */
  icon: string | undefined;
  host: string;
  name?: string;
  size: 14 | 16;
}) {
  // The site-wide icon main may already hold from the search row: shown while
  // the page's own is still on its way, so the chip does not start as a letter.
  const siteIcon = useSiteIcon(icon === undefined ? host : undefined);
  const src = icon ?? siteIcon;
  const [broken, setBroken] = useState<string | null>(null);
  if (src !== undefined && src !== broken) {
    return (
      <img
        className="pd-src-icon"
        data-size={size}
        src={src}
        alt=""
        width={size}
        height={size}
        onError={() => setBroken(src)}
      />
    );
  }
  return (
    <span className="pd-src-icon pd-src-icon-tile" data-size={size} aria-hidden="true">
      {tileLetter(name, host)}
    </span>
  );
}
