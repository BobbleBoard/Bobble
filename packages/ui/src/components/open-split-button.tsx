import { clsx } from 'clsx';
import { type RefObject, useEffect, useRef, useState } from 'react';
import { IconChevronDown } from './icons.tsx';

/*
 * THE "OPEN" CONTROL, IN ONE PLACE.
 *
 * the user, on the presentation card: "I want it to just be a rounded corner open
 * button that has the same thing as the 'open' button inside the canvas when you
 * have a file open. with the little dropdown also."
 *
 * "The same thing" is the operative phrase. This used to live inline in the
 * canvas operation bar, so the present card could only ever have a COPY — and a
 * copy is what produced the dropdown divergence he spent this evening pointing
 * at. It lives in the design system now, and both surfaces render this one
 * component: change the control here and every place that offers "Open" follows.
 *
 * The dropdown surface is the shared `.pd-menu` recipe, so it also inherits the
 * hairline, the reveal motion and the row geometry that everything else uses.
 */

/** An application that can open the artefact. `iconDataUrl` is the OS icon. */
export interface OpenWithChoice {
  readonly id: string;
  readonly name: string;
  readonly iconDataUrl?: string;
}

export interface OpenSplitButtonProps {
  /** The app the primary segment opens with; its icon rides on the button. */
  readonly defaultApp?: OpenWithChoice;
  /** Everything else offered in the dropdown. The default is filtered out. */
  readonly apps?: readonly OpenWithChoice[];
  readonly onOpen?: () => void;
  readonly onOpenWith?: (appId: string) => void;
  /**
   * An extra row at the foot of the dropdown — the canvas uses it for "Open in
   * folder". Dropping it was a regression the operation-bar tests caught the
   * moment this component replaced the inline copy; a shared control has to
   * carry everything its callers had, not just the parts I happened to look at.
   */
  readonly extraItem?: { readonly label: string; readonly onSelect: () => void };
  readonly className?: string;
}

/** Dismiss on any pointer-down outside the control. */
function useOutsideClose(ref: RefObject<HTMLElement | null>, open: boolean, close: () => void) {
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent): void => {
      if (ref.current?.contains(event.target as Node) === true) return;
      close();
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [ref, open, close]);
}

/*
 * The four-square "some application" glyph, matching the canvas one. Inlined
 * rather than imported: this component lives in the design system and canvas
 * depends on IT, so reaching upward for the icon would invert that.
 */
function GenericApp() {
  return (
    <svg
      width={16}
      height={16}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="pd-icon"
      aria-hidden="true"
    >
      <rect x="2.75" y="2.75" width="4.5" height="4.5" rx="1.2" />
      <rect x="8.75" y="2.75" width="4.5" height="4.5" rx="1.2" />
      <rect x="2.75" y="8.75" width="4.5" height="4.5" rx="1.2" />
      <rect x="8.75" y="8.75" width="4.5" height="4.5" rx="1.2" />
    </svg>
  );
}

function AppIcon({ app, inMenu = false }: { app?: OpenWithChoice; inMenu?: boolean }) {
  return (
    <span className={clsx('pd-split-app-icon', inMenu && 'pd-menu-icon')} aria-hidden="true">
      {app?.iconDataUrl !== undefined && app.iconDataUrl !== '' ? (
        <img src={app.iconDataUrl} alt="" width={16} height={16} />
      ) : (
        <GenericApp />
      )}
    </span>
  );
}

/**
 * A primary "Open" segment plus a divided caret listing the other applications —
 * one connected, rounded control. With no other apps to offer, the caret is
 * omitted rather than opening an empty menu.
 */
export function OpenSplitButton({
  defaultApp,
  apps,
  onOpen,
  onOpenWith,
  extraItem,
  className,
}: OpenSplitButtonProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useOutsideClose(ref, open, () => setOpen(false));
  const others = (apps ?? []).filter((app) => app.id !== defaultApp?.id);

  return (
    <div ref={ref} className={clsx('pd-split-root', className)}>
      <div className="pd-split">
        <button
          type="button"
          className="pd-split-main pd-focusable"
          aria-label={defaultApp !== undefined ? `Open with ${defaultApp.name}` : 'Open'}
          onClick={() => onOpen?.()}
        >
          <AppIcon app={defaultApp} />
          Open
        </button>
        {others.length > 0 || extraItem !== undefined ? (
          <>
            <span className="pd-split-divider" aria-hidden="true" />
            <button
              type="button"
              className="pd-split-caret pd-focusable"
              aria-label="Open with…"
              aria-haspopup="menu"
              aria-expanded={open}
              onClick={() => setOpen((was) => !was)}
            >
              <IconChevronDown size={14} />
            </button>
          </>
        ) : null}
      </div>
      {open && (others.length > 0 || extraItem !== undefined) ? (
        <div className="pd-menu pd-split-menu" role="menu">
          {others.map((app) => (
            <button
              key={app.id}
              type="button"
              role="menuitem"
              className="pd-menu-item"
              onClick={() => {
                setOpen(false);
                onOpenWith?.(app.id);
              }}
            >
              <AppIcon app={app} inMenu />
              <span className="pd-menu-item-title">{app.name}</span>
            </button>
          ))}
          {extraItem !== undefined ? (
            <>
              {others.length > 0 ? <div className="pd-menu-separator" aria-hidden="true" /> : null}
              <button
                type="button"
                role="menuitem"
                className="pd-menu-item"
                onClick={() => {
                  setOpen(false);
                  extraItem.onSelect();
                }}
              >
                <span className="pd-menu-item-title">{extraItem.label}</span>
              </button>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
