// @vitest-environment jsdom
/**
 * QUICK DOWNLOAD DECIDES ON THE HUB'S HOST — the budget Top Recommended uses —
 * and not on the total RAM the rows' fit pills are judged against.
 *
 * The card used to build its own budget out of `memoryGB`: 24 GB on a 24 GB Mac,
 * where Top Recommended decides on 18. So Mage Flow's Quick Download fetched
 * Turbo · bf16, marked Tight on its own row, beside a Top Recommended card
 * offering Turbo · int8. These render the card the way the hub does — 24 GB of
 * RAM for the pills, the 18 GB host for the pick — and read what it offers.
 */
import type { ReactNode } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BestForYourMachine } from './BestForYourMachine';
import { FamilyCard } from './FamilyCard';
import { hostFor, quickPickFor, type RecommenderHost, recommendAll } from './model-recommender';
import {
  RECOMMENDED_FAMILIES,
  type RecommendedFamily,
  type RecommendedVariant,
} from './recommended-catalog';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
// Org avatars ask main for Hugging Face's picture; with none, the mark stands in.
(window as unknown as { piDesktop: unknown }).piDesktop = {
  invoke: () => Promise.resolve({}),
};
// The Top Recommended carousel measures itself; jsdom has no layout to measure.
globalThis.ResizeObserver ??= class {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
} as unknown as typeof ResizeObserver;

/** The 24 GB Mac: what the hub hands the card for the pills, and for the pick. */
const RAM_GB = 24;
const HOST = hostFor({ totalRamGB: RAM_GB, usableMemoryGB: 18 });

let mounted: { root: Root; container: HTMLElement } | null = null;

async function render(node: ReactNode): Promise<HTMLElement> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(node);
  });
  mounted = { root, container };
  return container;
}

afterEach(async () => {
  if (mounted === null) return;
  const { root, container } = mounted;
  await act(async () => {
    root.unmount();
  });
  container.remove();
  mounted = null;
});

function card(
  family: RecommendedFamily,
  host: RecommenderHost | null,
  onDownload: (v: RecommendedVariant) => void = () => {},
): ReactNode {
  return (
    <FamilyCard
      key={family.id}
      family={family}
      downloaded={new Set()}
      selectedRepo={null}
      memoryGB={RAM_GB}
      host={host}
      onSelect={() => {}}
      onDownload={onDownload}
      onCancel={() => {}}
    />
  );
}

const quickOf = (root: HTMLElement, familyId: string) =>
  root.querySelector<HTMLButtonElement>(`[data-testid="family-quick-${familyId}"]`);

/** "repo · label" — the repo alone is not the variant (Mage Flow's recipes share one). */
const named = (el: HTMLElement | null): string | undefined =>
  el === null ? undefined : `${el.dataset.repo} · ${el.dataset.variant}`;

const family = (id: string): RecommendedFamily => {
  const found = RECOMMENDED_FAMILIES.find((f) => f.id === id);
  if (found === undefined) throw new Error(`no family ${id}`);
  return found;
};

describe('FamilyCard — Quick Download', () => {
  it('offers, for every family, the variant the recommender picks on the host — not on total RAM', async () => {
    const root = await render(RECOMMENDED_FAMILIES.map((f) => card(f, HOST)));
    for (const f of RECOMMENDED_FAMILIES) {
      const pick = quickPickFor(f, HOST);
      expect(named(quickOf(root, f.id)), f.name).toBe(
        pick === undefined ? undefined : `${pick.variant.repo} · ${pick.variant.label}`,
      );
    }
  });

  it('is the variant Top Recommended shows, wherever Top Recommended picks from that family', async () => {
    const top = recommendAll(HOST);
    const root = await render(
      <>
        <BestForYourMachine
          host={HOST}
          downloaded={new Set()}
          onSelect={() => {}}
          onDownload={() => {}}
          onUse={() => {}}
          onCancel={() => {}}
        />
        {RECOMMENDED_FAMILIES.map((f) => card(f, HOST))}
      </>,
    );
    const modalities = Object.values(top).map((r) => r.modality);
    expect(modalities).toEqual(['text', 'image', 'video', 'audio', '3d']);
    for (const rec of Object.values(top)) {
      const best = root.querySelector<HTMLElement>(`[data-testid="best-${rec.modality}"]`);
      expect(named(best), rec.modality).toBe(`${rec.variant.repo} · ${rec.variant.label}`);
      expect(named(quickOf(root, rec.family.id)), `${rec.modality}: ${rec.family.name}`).toBe(
        named(best),
      );
    }
  });

  it('Mage Flow on the 24 GB Mac: Turbo · int8, not the bf16 its own row marks Tight', async () => {
    const onDownload = vi.fn();
    const root = await render(card(family('mage-flow'), HOST, onDownload));
    const quick = quickOf(root, 'mage-flow');
    expect(quick?.dataset.variant).toBe('Turbo · int8');
    // The bf16 row is still there to choose by hand, and it says why it was not picked.
    const bf16 = root.querySelector(
      '[data-testid="family-variant-Comfy-Org/Mage-Flow:Turbo · bf16"]',
    );
    expect(bf16?.querySelector('[data-testid="fit-tight"]')).not.toBeNull();

    await act(async () => {
      quick?.click();
    });
    expect(onDownload).toHaveBeenCalledTimes(1);
    const fetched = onDownload.mock.calls[0]?.[0] as RecommendedVariant | undefined;
    expect(fetched?.label).toBe('Turbo · int8');
    expect(fetched?.allow).toEqual(quickPickFor(family('mage-flow'), HOST)?.variant.allow);
  });

  it('offers nothing where the host holds nothing — Krea 2’s smallest needs all 24 GB', async () => {
    const root = await render(card(family('krea2'), HOST));
    expect(quickOf(root, 'krea2')).toBeNull();
  });

  it('offers nothing until the machine is known, whatever the RAM says', async () => {
    const root = await render(card(family('mage-flow'), null));
    expect(quickOf(root, 'mage-flow')).toBeNull();
  });
});
