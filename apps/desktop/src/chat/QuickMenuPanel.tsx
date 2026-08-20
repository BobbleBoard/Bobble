/**
 * "MORE MODELS" — every model on disk, largest first, and the controls that
 * make the quick menu the user's.
 *
 * the user asked for favouriting, a configurable quick menu (rename slots, point
 * them at models, add more), and a "more models" surface that reveals a search
 * box once the list is long enough plus a scrollable list of everything
 * downloaded, largest to smallest, with org icons and model names.
 *
 * Why this is a panel rather than more rows in the dropdown: the quick menu's
 * job is to be quick, and a menu that also has to hold a search field, a
 * scrollable list and rename affordances has stopped being one. So the dropdown
 * keeps the short, chosen list and this opens beneath it for the rest.
 *
 * The sort and search rules live in quick-menu.ts with their reasoning; this
 * file only draws them.
 */
import { IconCheck, IconPin, IconSearch } from '@pi-desktop/ui';
import { type JSX, useMemo, useState } from 'react';
import { compactBytes } from '../models/models-layout';
import { OrgAvatar } from '../settings/brand-icons';
import {
  addSlot,
  bindSlot,
  DEFAULT_SLOTS,
  downloadedBySize,
  filterModels,
  type MenuModel,
  type QuickMenuConfig,
  removeSlot,
  renameSlot,
  shouldShowSearch,
  toggleFavourite,
} from './quick-menu';

export interface QuickMenuPanelProps {
  readonly models: readonly MenuModel[];
  readonly config: QuickMenuConfig;
  readonly activeModelId: string | null;
  readonly onConfigChange: (next: QuickMenuConfig) => void;
  readonly onPick: (modelId: string) => void;
}

export function QuickMenuPanel({
  models,
  config,
  activeModelId,
  onConfigChange,
  onPick,
}: QuickMenuPanelProps): JSX.Element {
  const [query, setQuery] = useState('');
  /* Two modes in one popup rather than a second surface: customising the menu
     is a thing you do WHILE looking at it, and sending the user somewhere else
     to rename a row they can see would be the long way round. */
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const onDisk = useMemo(() => downloadedBySize(models), [models]);
  const shown = useMemo(() => filterModels(onDisk, query), [onDisk, query]);
  const searchable = shouldShowSearch(onDisk.length);

  return (
    <div className="pd-quickmenu" data-testid="quick-menu-panel">
      {searchable ? (
        <div className="pd-quickmenu-search">
          <IconSearch size={13} />
          <input
            data-testid="quick-menu-search"
            className="pd-quickmenu-search-input"
            placeholder="Search models"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            // The list is the point; a search box that steals focus from it on
            // open would make the keyboard path worse, not better.
            autoComplete="off"
            spellCheck={false}
          />
        </div>
      ) : null}

      <div className="pd-quickmenu-list pd-scroll" data-testid="quick-menu-list">
        {shown.length === 0 ? (
          <p className="pd-quickmenu-empty" data-testid="quick-menu-empty">
            {onDisk.length === 0
              ? 'No models downloaded yet.'
              : `Nothing matches “${query.trim()}”.`}
          </p>
        ) : (
          shown.map((m) => {
            const starred = config.favourites.includes(m.id);
            return (
              <div
                key={m.id}
                className="pd-quickmenu-row"
                data-testid="quick-menu-row"
                data-model={m.id}
                data-active={activeModelId === m.id}
              >
                <button
                  type="button"
                  className="pd-quickmenu-pick"
                  data-testid="quick-menu-pick"
                  onClick={() => onPick(m.id)}
                >
                  <OrgAvatar org={m.org} size={18} />
                  <span className="pd-quickmenu-name">{m.displayName}</span>
                  <span className="pd-quickmenu-size">{compactBytes(m.bytes)}</span>
                  {activeModelId === m.id ? <IconCheck size={13} /> : null}
                </button>
                {/* Favouriting is a separate hit target from picking: the two
                    are different intentions and merging them would make every
                    pin a model switch. */}
                <button
                  type="button"
                  className="pd-quickmenu-star"
                  data-testid="quick-menu-star"
                  data-starred={starred}
                  aria-label={
                    starred ? `Unfavourite ${m.displayName}` : `Favourite ${m.displayName}`
                  }
                  title={starred ? 'Remove from the quick menu' : 'Pin to the quick menu'}
                  onClick={() => onConfigChange(toggleFavourite(config, m.id))}
                >
                  {/* IconPin, not a star: the shared set has no star, and "pin"
                      is the more literal verb for what this does to the menu. */}
                  <IconPin size={13} />
                </button>
              </div>
            );
          })
        )}
      </div>

      {/* CONFIGURING THE MENU — rename a slot, point it at a model, add one.
          the user: "configuring the quick menu (intelligent balanced fast, add more
          if you like, rename etc just do model names)". */}
      <button
        type="button"
        className="pd-quickmenu-edit-toggle"
        data-testid="quick-menu-edit-toggle"
        onClick={() => setEditing((v) => !v)}
      >
        {editing ? 'Done' : 'Customise…'}
      </button>

      {editing ? (
        <div className="pd-quickmenu-edit" data-testid="quick-menu-editor">
          {config.slots.map((slot) => {
            const fixed = DEFAULT_SLOTS.some((d) => d.id === slot.id);
            return (
              <div key={slot.id} className="pd-quickmenu-editrow" data-testid="quick-menu-editrow">
                <input
                  className="pd-quickmenu-editname"
                  data-testid="quick-menu-slot-name"
                  aria-label={`Name for ${slot.label}`}
                  value={slot.label}
                  onChange={(e) => onConfigChange(renameSlot(config, slot.id, e.target.value))}
                />
                {/* The BINDING, kept separate from the label — renaming a slot
                    must never change which model it runs (see quick-menu.ts). */}
                <select
                  className="pd-quickmenu-editmodel"
                  data-testid="quick-menu-slot-model"
                  aria-label={`Model for ${slot.label}`}
                  value={slot.modelId ?? ''}
                  onChange={(e) =>
                    onConfigChange(
                      bindSlot(config, slot.id, e.target.value === '' ? null : e.target.value),
                    )
                  }
                >
                  <option value="">Let the app choose</option>
                  {onDisk.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.displayName}
                    </option>
                  ))}
                </select>
                {fixed ? null : (
                  <button
                    type="button"
                    className="pd-quickmenu-editdel"
                    data-testid="quick-menu-slot-remove"
                    aria-label={`Remove ${slot.label}`}
                    onClick={() => onConfigChange(removeSlot(config, slot.id))}
                  >
                    ×
                  </button>
                )}
              </div>
            );
          })}

          <div className="pd-quickmenu-editrow">
            <input
              className="pd-quickmenu-editname"
              data-testid="quick-menu-add-name"
              placeholder="Add a slot…"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== 'Enter' || draft.trim() === '') return;
                onConfigChange(addSlot(config, draft, null));
                setDraft('');
              }}
            />
            <button
              type="button"
              className="pd-quickmenu-editadd"
              data-testid="quick-menu-add"
              disabled={draft.trim() === ''}
              onClick={() => {
                onConfigChange(addSlot(config, draft, null));
                setDraft('');
              }}
            >
              Add
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
