/**
 * The 3D studio's own two controls — Send To and Export.
 *
 * THIS USED TO BE A TOP BAR: a back-to-chat pill, a "Bobble 3D" wordmark, and
 * these two buttons, in a 46px strip above the workspace. The user: "remove the <
 * chat button and instead still keep the sidebar open/collapse button. remove
 * 'bobble 3d' with blue cube also."
 *
 * With its left half gone there was no bar left to justify, so the studio joined
 * the content route the other three use and these two moved into the app's own
 * top-right cluster — beside the sidebar toggle they now share a bar with. One
 * strip of chrome instead of two, and the way OUT of the studio is the sidebar
 * rather than a pill that existed only here.
 *
 * Everything the old header was careful about still holds: no promos, credits,
 * accounts or nav ballast — just Send To (real DCC app logos, exports a GLB
 * named for the target) and Export (opens the dialog).
 */
import type { JSX } from 'react';
import { IcExport, IcShare } from './icons';
import { DCC_LOGOS, DccLogoIcon } from './logos';
import { MenuAnchor } from './primitives';
import { useTripoStore } from './store';
import { requestSendTo } from './viewer-io';

export function TripoTopBarControls(): JSX.Element {
  const toggleMenu = useTripoStore((s) => s.toggleMenu);
  const closeMenus = useTripoStore((s) => s.closeMenus);
  const set = useTripoStore((s) => s.set);
  const loadedAssetId = useTripoStore((s) => s.loadedAssetId);
  const hasModel = loadedAssetId !== null;

  return (
    <div className="tp-topbar-right" data-testid="tp-topbar">
      <MenuAnchor
        id="sendto"
        placement="bottom-end"
        trigger={
          <button
            type="button"
            className="tp-pill-btn"
            data-testid="tp-sendto-btn"
            disabled={!hasModel}
            onClick={() => toggleMenu('sendto')}
          >
            <IcShare size={15} />
            Send To
            {/*
              No caret. The user: "remove the little down arrow in the 'send to'
              button." A pill that opens a menu is found by pointing at it, and
              the chevron was a third of the control's width spent saying so.
            */}
          </button>
        }
        menu={
          <div className="tp-sendto-menu" data-testid="tp-sendto-menu">
            {DCC_LOGOS.map((logo) => (
              <button
                key={logo.id}
                type="button"
                className="tp-menu-item"
                data-testid={`tp-sendto-${logo.id}`}
                title={`Exports a GLB for ${logo.label}`}
                onClick={() => {
                  requestSendTo(logo.id, logo.label);
                  closeMenus();
                }}
              >
                <DccLogoIcon logo={logo} size={16} />
                <span className="tp-menu-item-label">{logo.label}</span>
              </button>
            ))}
          </div>
        }
      />
      <button
        type="button"
        className="tp-export-cta"
        data-testid="tp-export-btn"
        disabled={!hasModel}
        onClick={() => set('modal', 'export')}
      >
        <IcExport size={15} />
        Export
      </button>
    </div>
  );
}
