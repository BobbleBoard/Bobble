/**
 * THE QUICK TOUR — what each screen's steps are, and which screen is showing.
 *
 * the user (2026-10-08): "in the bottom left menu a quick guided tour button that
 * shows a highlighting/tutorial style guide of whatever's on screen right now."
 *
 * So the tour is per SCREEN, read off the page at the moment it starts: the
 * Models page gets the Models steps, the chat gets the chat's. A step names the
 * control it explains by selector (several, first match wins), and a step whose
 * control is not on screen is skipped rather than pointing at nothing — a
 * collapsed sidebar, a studio that is not installed, an empty list.
 *
 * Words follow the design language's voice: plain, sentence case, to "you",
 * what it is and what it does for you, then stop. No emoji, no exclamation.
 */

export type TourScreen = 'chat' | 'models' | 'extensions' | 'scheduled' | 'studio3d';

export interface TourStep {
  readonly id: string;
  /** Candidate selectors for the control this step explains; the first visible one wins. */
  readonly targets: readonly string[];
  readonly title: string;
  readonly body: string;
  /** Padding the target carries that is not the control (a carousel's room for
      its shadows), taken off before the spotlight is drawn: top, right, bottom, left. */
  readonly inset?: readonly [number, number, number, number];
}

/** Steps every screen ends with: the sidebar's places and this menu. */
const SIDEBAR: readonly TourStep[] = [
  {
    id: 'new-chat',
    targets: ['[data-testid="new-chat"]'],
    title: 'New chat',
    body: 'Start a fresh conversation. Everything runs on this Mac, and nothing leaves it.',
  },
  {
    id: 'studios',
    targets: ['[data-testid="modality-rows"]'],
    title: 'Studios',
    body: 'Make pictures, video, sound and 3D models. Each studio installs the first time you open it.',
  },
  {
    id: 'profile',
    targets: ['[data-testid="profile-button"]'],
    title: 'Settings and this tour',
    body: 'Settings, light or dark, and this tour, whenever you want it again.',
  },
];

export const TOUR_STEPS: Readonly<Record<TourScreen, readonly TourStep[]>> = {
  chat: [
    {
      id: 'composer',
      targets: ['.pd-composer', '[data-testid="composer-input"]'],
      title: 'Ask anything',
      body: 'Type here and press Return. Bobble can read files, run tools and make things, and it shows each step as it works.',
    },
    {
      id: 'model',
      targets: ['[data-testid="composer-pill"]', '[data-testid="footer-model-chip"]'],
      title: 'Which model answers',
      body: 'Pick the model for this chat. Faster ones answer sooner; larger ones think harder.',
    },
    {
      id: 'effort',
      targets: ['[data-testid="composer-effort"]'],
      title: 'How hard it thinks',
      body: 'Turn effort up for harder problems, down for quick answers.',
    },
    {
      id: 'search',
      targets: ['[data-testid="sidebar-search"]'],
      title: 'Find a chat',
      body: 'Search every conversation you have had.',
    },
    {
      id: 'models',
      targets: ['[data-testid="nav-model-management"]'],
      title: 'Models',
      body: 'Get more models, see what is on this Mac, and free up space.',
    },
    {
      id: 'extensions',
      targets: ['[data-testid="nav-connectors"]'],
      title: 'Extensions',
      body: 'Connect Bobble to your apps and tools, like your calendar, GitHub or Blender.',
    },
    ...SIDEBAR,
  ],
  models: [
    {
      id: 'places',
      targets: ['.pd-hub-tabs'],
      title: 'Three places',
      body: 'Discover finds new models, On this Mac shows the ones you have, and Storage frees up space.',
    },
    {
      id: 'recommended',
      targets: ['[data-testid="best-carousel"]', '[data-testid="best-for-your-machine"]'],
      // .pd-carousel pads 8 16 28 around the cards for their shadows.
      inset: [8, 16, 28, 16],
      title: 'Start here',
      body: 'The best model of each kind for this Mac. One click downloads it, and then it is ready to use.',
    },
    {
      id: 'kinds',
      targets: ['[data-testid="filter-output"]'],
      title: 'What it makes',
      body: 'Show only models that make text, pictures, video, sound or 3D.',
    },
    {
      id: 'search',
      targets: ['[data-testid="models-search"]'],
      title: 'Search',
      body: 'Look up any model on Hugging Face by name.',
    },
    {
      id: 'this-mac',
      targets: ['[data-testid="hub-mac-toggle"]'],
      title: 'This Mac',
      body: 'The memory and space every "fits" and "too large" is judged against.',
    },
    ...SIDEBAR,
  ],
  extensions: [
    {
      id: 'search',
      targets: ['[data-testid="connectors-search"]'],
      title: 'Find an extension',
      body: 'Search for the app or service you want Bobble to work with.',
    },
    {
      id: 'installed',
      targets: [
        '[data-testid="connectors-installed-toggle"]',
        '[data-testid="connectors-installed"]',
      ],
      title: 'Yours',
      body: 'The extensions you have turned on. Bobble can use them in any chat.',
    },
    {
      id: 'catalog',
      targets: ['[data-testid="connectors-list"]'],
      title: 'Everything you can add',
      body: 'Open one to see what it does and try it before you turn it on.',
    },
    ...SIDEBAR,
  ],
  scheduled: [
    {
      id: 'scheduled',
      targets: ['[data-testid="scheduled-view"]'],
      title: 'Scheduled',
      body: 'Tasks Bobble runs for you on a schedule, on this Mac, and what they did last time.',
    },
    ...SIDEBAR,
  ],
  studio3d: [
    {
      id: 'tools',
      targets: ['[data-testid="tp-rail"]'],
      title: 'Each stage',
      body: 'Go from a picture to a model, then segment, retopologise, texture and animate it, one stage at a time.',
    },
    {
      id: 'panel',
      targets: ['.tp-genpanel'],
      title: 'The stage you are on',
      body: 'Describe what you want or bring a file. The settings for this stage live here.',
    },
    {
      id: 'viewport',
      targets: ['[data-testid="tp-viewport"]'],
      title: 'Your model',
      body: 'Drag to turn it, scroll to zoom. What you make appears here.',
    },
    ...SIDEBAR,
  ],
};

/**
 * Which screen is showing, read off the page: the content route's own root, in
 * order of how specific it is, and the chat when nothing else is open.
 */
export function screenOf(doc: Pick<Document, 'querySelector'>): TourScreen {
  if (doc.querySelector('[data-testid="tp-root"]') !== null) return 'studio3d';
  if (doc.querySelector('[data-testid="models-view"]') !== null) return 'models';
  if (doc.querySelector('[data-testid="scheduled-view"]') !== null) return 'scheduled';
  if (doc.querySelector('[data-testid="connectors-search"]') !== null) return 'extensions';
  return 'chat';
}

/** A box on screen; zero-sized or off-screen boxes do not count as shown. */
export interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export function isShown(box: Box | null, viewport: { width: number; height: number }): boolean {
  if (box === null) return false;
  if (box.width < 4 || box.height < 4) return false;
  return (
    box.x < viewport.width &&
    box.y < viewport.height &&
    box.x + box.width > 0 &&
    box.y + box.height > 0
  );
}

/**
 * The steps that can be shown now: each with the first of its selectors that
 * lands on something visible. `locate` answers a selector with its box (or null).
 */
export function resolveSteps(
  steps: readonly TourStep[],
  locate: (selector: string) => Box | null,
  viewport: { width: number; height: number },
): Array<{ step: TourStep; selector: string }> {
  const out: Array<{ step: TourStep; selector: string }> = [];
  for (const step of steps) {
    const selector = step.targets.find((s) => isShown(locate(s), viewport));
    if (selector !== undefined) out.push({ step, selector });
  }
  return out;
}

export type Side = 'right' | 'left' | 'below' | 'above';

/**
 * Where the card goes beside its target: the side with room, in the order a
 * reader expects (to the right, below, above, then left), and how far along the
 * card's edge the notch sits so it points at the target's middle.
 */
export function placeCard(
  target: Box,
  card: { width: number; height: number },
  viewport: { width: number; height: number },
  gap = 14,
  margin = 12,
  prefer?: Side,
): { side: Side; x: number; y: number; notch: number } {
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
  const cx = target.x + target.width / 2;
  const cy = target.y + target.height / 2;
  const roomRight = viewport.width - (target.x + target.width) - gap - margin;
  const roomLeft = target.x - gap - margin;
  const roomBelow = viewport.height - (target.y + target.height) - gap - margin;
  const roomAbove = target.y - gap - margin;
  const vertical = (side: 'right' | 'left') => {
    const y = clamp(cy - 28, margin, viewport.height - card.height - margin);
    const x = side === 'right' ? target.x + target.width + gap : target.x - gap - card.width;
    return { side, x, y, notch: clamp(cy - y, 18, card.height - 18) };
  };
  const horizontal = (side: 'below' | 'above') => {
    const x = clamp(cx - 40, margin, viewport.width - card.width - margin);
    const y = side === 'below' ? target.y + target.height + gap : target.y - gap - card.height;
    return { side, x, y, notch: clamp(cx - x, 18, card.width - 18) };
  };
  // A side the caller asks for wins whenever it has room (a pop-out rising from
  // the composer's + reads as coming out of it).
  if (prefer === 'above' && roomAbove >= card.height) return horizontal('above');
  if (prefer === 'below' && roomBelow >= card.height) return horizontal('below');
  if (prefer === 'right' && roomRight >= card.width) return vertical('right');
  if (prefer === 'left' && roomLeft >= card.width) return vertical('left');
  // A target wider than half the window reads better with the card under it.
  const wide = target.width > viewport.width / 2;
  if (!wide && roomRight >= card.width) return vertical('right');
  if (roomBelow >= card.height) return horizontal('below');
  if (roomAbove >= card.height) return horizontal('above');
  if (roomLeft >= card.width) return vertical('left');
  // Nowhere has room (a target filling the window): sit inside its top-left.
  return {
    side: 'below',
    x: clamp(target.x + margin, margin, viewport.width - card.width - margin),
    y: clamp(target.y + margin, margin, viewport.height - card.height - margin),
    notch: 28,
  };
}
