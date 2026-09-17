/**
 * THE THEME PICKER — a searchable dropdown, one per mode. Click the trigger,
 * the list opens with a filter box at the top and the caret in it; type to
 * narrow, arrow to move, Enter to pick, Escape to close. Each row carries a
 * five-swatch strip of the theme (its ground and four syntax colours) so a
 * name you have never heard of still says what it looks like.
 *
 * Built on the app's own dropdown surface (`Popover` → `.pd-menu`, rows as
 * `.pd-menu-item`), not a native <select> — the user: "use the app's custom
 * dropdown styling universally".
 */
import {
  type CodeTheme,
  type CodeThemeMode,
  codeThemesFor,
  filterCodeThemes,
} from '@pi-desktop/code-themes';
import {
  IconCheck,
  IconChevronDown,
  IconSearch,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@pi-desktop/ui';
import { type KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from 'react';

function Swatches({ theme }: { theme: CodeTheme }) {
  const dots = [
    theme.syntax.keyword,
    theme.syntax.string,
    theme.syntax.function,
    theme.syntax.number,
  ];
  return (
    <span className="pd-code-theme-swatch" style={{ background: theme.editor.bg }} aria-hidden>
      {dots.map((color, i) => (
        // Four fixed dots; position is identity.
        // biome-ignore lint/suspicious/noArrayIndexKey: static swatch order
        <span key={i} style={{ background: color }} />
      ))}
    </span>
  );
}

export function CodeThemePicker({
  mode,
  value,
  onChange,
  label,
  testId,
}: {
  mode: CodeThemeMode;
  /** The chosen theme (already resolved to one of this mode). */
  value: CodeTheme;
  onChange: (id: string) => void;
  label: string;
  testId: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const themes = useMemo(() => codeThemesFor(mode), [mode]);
  const shown = useMemo(() => filterCodeThemes(themes, query), [themes, query]);

  // A fresh open starts on the current theme with the filter clear, so the
  // list reads as "here is what you have, and the rest".
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActive(
      Math.max(
        0,
        themes.findIndex((t) => t.id === value.id),
      ),
    );
  }, [open, themes, value.id]);

  // Typing narrows the list; the highlight goes back to the top of it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: query is the trigger.
  useEffect(() => {
    setActive(0);
  }, [query]);

  // Keep the highlighted row in view while arrowing through a long list.
  // `active` is the trigger: the row is found by its attribute, not by index.
  // biome-ignore lint/correctness/useExhaustiveDependencies: active is the trigger.
  useEffect(() => {
    if (!open) return;
    const row = listRef.current?.querySelector<HTMLElement>('[data-highlighted]');
    row?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  const pick = (theme: CodeTheme): void => {
    onChange(theme.id);
    setOpen(false);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((i) => Math.min(shown.length - 1, i + 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (event.key === 'Home') {
      event.preventDefault();
      setActive(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      setActive(Math.max(0, shown.length - 1));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const theme = shown[active];
      if (theme !== undefined) pick(theme);
    }
  };

  const activeTheme = shown[active];

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        className="pd-btn pd-btn--outline pd-code-theme-trigger"
        aria-label={label}
        data-testid={testId}
        data-value={value.id}
      >
        <Swatches theme={value} />
        <span className="pd-code-theme-trigger-name">{value.name}</span>
        <IconChevronDown size={14} className="pd-select-chevron" />
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="pd-code-theme-menu"
        onOpenAutoFocus={(event) => {
          // The caret belongs in the filter, not on the first row.
          event.preventDefault();
          inputRef.current?.focus();
        }}
      >
        <div className="pd-code-theme-search">
          <IconSearch size={14} />
          <input
            ref={inputRef}
            type="text"
            className="pd-code-theme-search-input"
            placeholder="Search themes"
            aria-label={`Search ${label.toLowerCase()}s`}
            role="combobox"
            aria-expanded={open}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={
              activeTheme === undefined ? undefined : `${listId}-${activeTheme.id}`
            }
            data-testid={`${testId}-search`}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
          />
        </div>
        <div ref={listRef} id={listId} role="listbox" aria-label={label}>
          {shown.length === 0 ? (
            <p className="pd-code-theme-empty">No matching themes</p>
          ) : (
            shown.map((theme, index) => {
              const current = theme.id === value.id;
              return (
                <button
                  key={theme.id}
                  type="button"
                  id={`${listId}-${theme.id}`}
                  role="option"
                  aria-selected={current}
                  data-highlighted={index === active ? '' : undefined}
                  data-testid={`code-theme-option-${theme.id}`}
                  className={`pd-menu-item${current ? ' pd-menu-item--current' : ''}`}
                  onMouseEnter={() => setActive(index)}
                  onClick={() => pick(theme)}
                >
                  <Swatches theme={theme} />
                  <span className="pd-code-theme-name">{theme.name}</span>
                  {theme.firstParty ? <span className="pd-code-theme-house">Bobble</span> : null}
                  {current ? (
                    <span className="pd-menu-check" aria-hidden="true">
                      <IconCheck size={14} />
                    </span>
                  ) : null}
                </button>
              );
            })
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
