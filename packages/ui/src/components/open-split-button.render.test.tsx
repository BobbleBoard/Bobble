import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { OpenSplitButton } from './open-split-button.tsx';
import { PresentCard } from './present-card.tsx';

/**
 * ONE "Open" CONTROL, TWO SURFACES.
 *
 * The user, on the presentation card: "I want it to just be a rounded corner open
 * button that has the same thing as the 'open' button inside the canvas when you
 * have a file open. with the little dropdown also."
 *
 * The control used to live inline in the canvas operation bar, so the card could
 * only ever have had a COPY — and a copy is exactly what produced the dropdown
 * divergence the user spent the evening pointing at. Both render this component now.
 */
const VSCODE = { id: 'code', name: 'VS Code' };
const APPS = [VSCODE, { id: 'zed', name: 'Zed' }];

describe('OpenSplitButton', () => {
  it('names the default app on the primary segment', () => {
    const html = renderToStaticMarkup(<OpenSplitButton defaultApp={VSCODE} apps={APPS} />);
    expect(html).toContain('Open with VS Code');
    expect(html).toContain('pd-split-main');
  });

  it('offers the caret when there is another app to choose', () => {
    expect(renderToStaticMarkup(<OpenSplitButton defaultApp={VSCODE} apps={APPS} />)).toContain(
      'pd-split-caret',
    );
  });

  /* An empty menu is worse than no menu — nothing to pick and nothing to say. */
  it('omits the caret when the default is the only app', () => {
    expect(
      renderToStaticMarkup(<OpenSplitButton defaultApp={VSCODE} apps={[VSCODE]} />),
    ).not.toContain('pd-split-caret');
  });

  it('still offers the caret for an extra row alone', () => {
    const html = renderToStaticMarkup(
      <OpenSplitButton extraItem={{ label: 'Open in folder', onSelect: () => {} }} />,
    );
    expect(html).toContain('pd-split-caret');
  });

  it('falls back to a generic glyph with no app icon', () => {
    const html = renderToStaticMarkup(<OpenSplitButton />);
    expect(html).toContain('pd-split-app-icon');
    expect(html).not.toContain('<img');
  });
});

describe('PresentCard uses that same control', () => {
  const item = { path: '/w/report.md', kind: 'file' as const, at: 1 };

  it('renders the split button, not a bare Open button', () => {
    const html = renderToStaticMarkup(<PresentCard item={item} onOpen={() => {}} />);
    expect(html).toContain('pd-split-main');
    expect(html).toContain('Open');
  });

  it('shows the dropdown caret once the apps are known', () => {
    const html = renderToStaticMarkup(
      <PresentCard
        item={{ ...item, defaultApp: VSCODE, openApps: APPS }}
        onOpen={() => {}}
        onOpenWith={() => {}}
      />,
    );
    expect(html).toContain('pd-split-caret');
  });

  /* The apps arrive asynchronously; the button must work before they land. */
  it('renders a working Open before the app list arrives', () => {
    const html = renderToStaticMarkup(<PresentCard item={item} onOpen={() => {}} />);
    expect(html).toContain('pd-split-main');
    expect(html).not.toContain('pd-split-caret');
  });
});
