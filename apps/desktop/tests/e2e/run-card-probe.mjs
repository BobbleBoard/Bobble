/**
 * THE RESULT CARD, AS A CHAT.
 *
 * the user: "no grey bars, shrink and left align the card (eg. in fox screenshot
 * there's bars) and place the prompt up and right as if this is a chat", and
 * "edit how much should say low/med/high and say 'Edit Magnitude'".
 *
 * The bars came from forcing the picture to `width: 100%` and then
 * `object-fit: contain` inside a full-width frame, over a 4% tint — so a square
 * render painted the tint down both sides. This measures the three things that
 * fixes, on the real card, and screenshots it:
 *
 *   - the frame is no wider than the picture in it (no bars)
 *   - the card sits at the LEFT edge of the results column
 *   - the prompt sits above it, aligned RIGHT, as a bubble
 *   - a GRID of candidates still fills its cells (they exist to be compared)
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchApp } from './harness.mjs';

const OUT =
  process.env.OUT ??
  '<session-scratchpad>/card';
mkdirSync(OUT, { recursive: true });

const home = mkdtempSync(path.join(tmpdir(), 'pd-card-home-'));
mkdirSync(path.join(home, '.pi', 'agent', 'sessions', 'proj'), { recursive: true });
const media = path.join(home, 'Bobble', 'generated');
mkdirSync(media, { recursive: true });

/* A SQUARE picture, because square in a wide column is exactly the shape that
   produced the bars. Generated so there is no fixture to drift. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAUAAAAFACAYAAADNkKWqAAAKeklEQVR42u3UU7YkWQAAwF7Y2LZtexrPtm3br58b02Pt6s7JW1k3aw1z4iO2EJf+rborFO4O/5RV3xP9XX1voea+8Fd0f/Jn7QO5B8MfZXUPRb/XPVyofyT8Fj2a/NrwWO7x8EtZ4xPRz41PFpqeCneip5Ofmp/JPRtul7U8F91qeb7Q+kK4Gb2Y3Gh7KfdyuChrfyU6b3+10PFaOIteT04738i9GZ1kut6KjrveLnS/E46id5PrPe/l3o8OM70fRAe9Hxb6Pgr70cfJXv8nuU+j3czAZ9HOwOeFwS/CdvRlsjX0Ve7raDMz/E20MfxtYeS7sJ58H62N/lDhx7CaGbucrIxdKRm/GpaTa9HSRFWF6rCYmaxJFiZrS6bqwnxSH81NN1RoDLOZmaZkZqa5ZLYlTCet0dRcW4X2MJmZ70gm5jtLFrrCeNIdjS32VOgNo5mlvmRkqb9keSAajgajoZWhCsNhMLM6kgysjpasjUX90XjUtz5RYTL0Zjamkp6N6ZLNmag7mo26tuYqzIfOzPZC0rG9WLKzFLVHy1Hb7kqF1dBatrcWteytF/Y3QnO0mTQdbOW2Q2PZ4U7UcLhbuL4X6qP9pO7oIHcYasuOr0c1x0eFk+NQHZ0kVaenubNwrezsPLp6dlE4vxGuRDeTyxe3crfDJQEKUIACFKAABShAAQpQgAIUoAAFKEABClCAAhSgAAUoQAEKUIACFKAABShAAQpQgAIUoAAFKEABClCAAhSgAAUoQAEKUIACFKAABShAAQpQgAIUoAAFKEABClCAAhSgAAUoQAEKUIACFKAABShAAQpQgAIUoAAFKEABClCAAhSgAAUoQAEKUIACFKAABShAAQpQgAIUoAAFKEABClCAAhSgAAUoQAEKUIACFKAABShAAQpQgAIUoAAFKEABClCAAhSgAAUoQAEKUIACFKAABShAAQpQgAIUoAAFKEABClCAAhSgAAUoQAEKUIACFKAABShAAQpQgAIUoAAFKEABClCAAhSgAAUoQAEKUIACFKAABShAAQpQgAIUoAAFKEABClCAAhSgAAUoQAEKUIACFKAABShAAQpQgAIUoAAFKEABClCAAhSgAAUoQAEKUIACFKAABShAAQpQgAIUoAAFKEABClCAAhSgAAUoQAEKUIACFKAABShAAQpQgAIUoAAFKEABClCAAhSgAAUoQAEKUIACFKAABShAAQpQgAIUoAAFKEABClCAAhSgAAUoQAEKUIACFKAABShAAQpQgAIUoAAFKEABClCAAhSgAAUoQAEKUIACFKAABShAAQpQgAIUoAAFKEABClCAAhSgAAUoQAEKUIACFKAABShAAQpQgAIUoAAFKEABClCAAhSgAAUoQAEKUIACFKAABShAAQpQgAIUoAAFKEABClCAAhSgAAUoQAEKUIACFKAABShAAQpQgAIUoAAFKEABClCAAhSgAAUoQAEKUIACFKAABShAAQpQgAIUoAAFKEABClCAAhSgAAUoQAEKUIACFKAABShAAQpQgAIUoAAFKEABClCAAhSgAAUoQAEKUIACFKAABShAAQpQgAIUoAAFKEABClCAAhSgAAUoQAEKUIACFKAABShAAQpQgAIUoAAFKEABClCAAhSgAAUoQAEKUIACFKAABShAAQpQgAIUoAAFKEABClCAAhSgAAUoQAEKUIACFKAABShAAQpQgAIUoAAFKEABClCAAhSgAAUoQAEKUIACFKAABShAAQpQgAIUoAAFKEABClCAAhSgAAUoQAEKUIACFKAABShAAQpQgAIUoAAFKEABClCAAhSgAAUoQAEKUIACFKAABShAAQpQgAIUoAAFKEABClCAAhSgAAUoQAEKUIACFKAABShAAQpQgAIUoAAFKEABClCAAhSgAAUoQAEKUIACFKAABShAAQpQgAIUoAAFKEABClCAAhSgAAUoQAEKUIACFKAABShAAQpQgAIUoAAFKEABClCAAhSgAAUoQAEKUIACFKAABShAAQpQgAIUoAAFKEABClCAAhSgAAUoQAEKUIACFKAABShAAQpQgAIUoAAFKEABClCAAhSgAAUoQAEKUIACFKAABShAAQpQgAIUoAAFKEABClCAAhSgAAUoQAEKUIACFKAABShAAQpQgAIUoAAFKEABClCAAhSgAAUoQAEKUIACFKAABShAAQpQgAIUoAAFKEABClCAAhSgAAUoQAEKUIACFKAABShAAQpQgAIUoAAFKEABClCAAhSgAAUoQAEKUIACFKAABShAAQpQgAIUoAAFKEABClCAAhSgAAUoQAEKUIACFKAABShAAQpQgAIUoAAFKEABClCAAhSgAAUoQAEKUIACFKAABShAAQpQgAIUoAAFKEABClCAAhSgAAUoQAEKUIACFKAABShAAQpQgAIUoAAFKEABClCAAhSgAAUoQAEKUIACFKAABShAAQpQgAIUoAAFKEABClCAAhSgAAUoQAEKUIACFKAABShAAQpQgAIUoAAFKEABClCAAhSgAAUoQAEKUIACFKAABShAAQpQgAIUoAAFKEABClCAAhSgAAUoQAEKUIACFKAABShAAQpQgAIUoAAFKEABClCAAhSgAAUoQAEKUIACFKAABShAAQpQgAIUoAAFKEABClCAAhSgAAUoQAEKUIACFKAABShAAQpQgAIUoAAFKEABClCAAhSgAAUoQAEKUIACFKAABShAAQpQgAIUoAAFKEABClCAAhSgAAUoQAEKUIACFKAABShAAQpQgAIUoAAFKEABClCAAhSgAAUoQAEKUIACFKAABShAAQpQgAIUoAAFKEABClCAAhSgAAUoQAEKUIACFKAABShAAQpQgAIUoAAFKEABClCAAhSgAAUoQAEKUIACFKAABShAAQpQgAIUoAAFKEABClCAAhSgAAUoQAEKUIACFKAABShAAQpQgAIUoAAFKEABClCAAhSgAAUoQAEKUIACFKAABShAAQpQgAIUoAAFKEABClCAAhSgAAUoQAEKUIACFKAABShAAQpQgAIUoAAFKEABClCAAhSgAAUoQAEKUIACFKAABShAAQpQgAIUoAAFKEABClCAAhSgAAUoQAEKUIACFKAABShAAQpQgAIUoAAFKEABClCAAhSgAAUoQAEKUIACFKAABShAAQpQgAIUoAAFKEABClCAAhSgAAUoQAEKUIACFKAABShAAQpQgAIUoAAFKEABClCAAhSgAAUoQAEKUIACFKAABShAAQpQgAIUoAAFKEABClCAAhSgAAUoQAEKUIACFKAABShAAQpQgAIUoAAFKEABClCAAhSgAAUoQAEKUIACFKAABShAAQpQgAIUoAAFKEABClCAAhSgAAUoQAEKUIACFKAABShAAQpQgAIUoAAFKEABClCAAhSgAAUoQAEKUIACFKAABShAAQpQgAIUoAAFKEABClCAAhSgAAUoQAEKUIACFKAABShAAQpQgAIUoAAFKEABClCAAhSgAAUoQAEKUIACFKAABShAAQpQgAIUoAAFKEABClCAAhSgAAUoQAEKUIACFKAABShAAQpQgAIUoAAFKEABClCAAhSgAAX4fw/wPwTwXe9xQgH1AAAAAElFTkSuQmCC',
  'base64',
);
const img = path.join(media, 'fox-real.png');
writeFileSync(img, PNG);

const { page, shot, check, finish } = await launchApp('run-card-probe', {
  env: { HOME: home },
  args: ['--', '--piE2E=1'],
});

const seedRun = (items) =>
  page.evaluate(
    ([list, p]) => {
      window.__studio_runs().getState().clear('image');
      window
        .__studio_runs()
        .getState()
        .add('image', {
          prompt: p,
          at: Date.now(),
          seed: 347246386,
          model: 'z-image-turbo',
          items: list.map((path, i) => ({ path, name: `fox-${i}.png`, kind: 'image' })),
        });
    },
    [items, 'a red fox sitting in deep snow at golden hour, warm low sun'],
  );

try {
  /* The studio FIRST: `__studio_runs` is defined when its module loads, which
     only happens once a studio mounts — waiting for it before opening one waits
     forever. */
  await page.waitForSelector('.pd-composer-editor', { timeout: 20_000 });
  if ((await page.$('[data-testid="modality-image"]')) === null)
    await page.click('text=Modalities');
  await page.click('[data-testid="modality-image"]');
  await page.waitForSelector('.pd-studio', { timeout: 15_000 });
  await page.waitForFunction(() => typeof window.__studio_runs === 'function', { timeout: 20_000 });

  /* ------------------------------------------------------ one result */
  await seedRun([img]);
  await page.waitForSelector('[data-testid="media-card"]', { timeout: 10_000 });
  await page.waitForTimeout(400);

  const g = await page.evaluate(() => {
    const r = (s) => {
      const el = document.querySelector(s);
      return el === null ? null : el.getBoundingClientRect();
    };
    const frame = r('.pd-media-frame');
    const image = r('.pd-media-image');
    const card = r('[data-testid="media-card"]');
    /*
     * Measure against the RUN SECTION, not the scroll container: the section
     * carries the column's own padding, so both the card and the prompt sit 34px
     * in from the container and are nonetheless flush with their content box.
     * Measuring against the wrong parent reported correct alignment as broken.
     */
    const section = document.querySelector('.pd-studio-run');
    const results =
      section === null ? r('[data-testid="studio-results"]') : section.getBoundingClientRect();
    /* The section's own padding is not misalignment: measure against its
       CONTENT box, which is what "flush left" and "flush right" mean here. */
    const pad =
      section === null
        ? { l: 0, r: 0 }
        : {
            l: Number.parseFloat(getComputedStyle(section).paddingLeft) || 0,
            r: Number.parseFloat(getComputedStyle(section).paddingRight) || 0,
          };
    const prompt = r('.pd-studio-run-prompt');
    const promptEl = document.querySelector('.pd-studio-run-prompt');
    return {
      frameW: frame?.width ?? 0,
      imageW: image?.width ?? 0,
      cardLeft: card === null || results === null ? null : Math.round(card.x - results.x - pad.l),
      resultsW: results?.width ?? 0,
      promptRight:
        prompt === null || results === null
          ? null
          : Math.round(results.x + results.width - pad.r - (prompt.x + prompt.width)),
      promptTop: prompt === null || card === null ? null : Math.round(card.y - prompt.y),
      promptBg: promptEl === null ? null : getComputedStyle(promptEl).backgroundColor,
    };
  });
  console.log(`   frame ${Math.round(g.frameW)}px vs image ${Math.round(g.imageW)}px`);
  console.log(`   card left-offset ${g.cardLeft}px · prompt right-offset ${g.promptRight}px`);
  await shot('1-single-result');

  check(
    Math.abs(g.frameW - g.imageW) <= 4,
    `the frame is wider than the picture — that gap IS the grey bars (frame ${Math.round(g.frameW)}, image ${Math.round(g.imageW)})`,
  );
  check(
    g.frameW < g.resultsW - 40,
    `the card still fills the column (${Math.round(g.frameW)} of ${Math.round(g.resultsW)}) — it should shrink to the picture`,
  );
  check(
    g.cardLeft !== null && g.cardLeft <= 4,
    `the card is not left-aligned (offset ${g.cardLeft}px)`,
  );
  check(
    g.promptRight !== null && g.promptRight <= 4,
    `the prompt is not right-aligned (offset ${g.promptRight}px)`,
  );
  check(g.promptTop !== null && g.promptTop > 0, 'the prompt is not ABOVE the card');
  check(
    g.promptBg !== null && g.promptBg !== 'rgba(0, 0, 0, 0)',
    `the prompt has no bubble behind it (${g.promptBg})`,
  );

  /* ------------------------------- the Edit magnitude knob, with an input */
  await page.evaluate(
    ([p]) => {
      window.__studio_handoff().getState().offer('image', {
        path: p,
        name: 'fox-real.png',
        kind: 'image',
      });
    },
    [img],
  );
  await page.waitForSelector('[data-testid="studio-input"]', { timeout: 8000 });
  if ((await page.getAttribute('[data-testid="studio-settings"]', 'data-open')) !== 'true') {
    await page.click('[data-testid="studio-settings-toggle"]');
  }
  await page.waitForTimeout(400);
  const knob = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="image-strength-rail"]');
    const group = el?.closest('.pd-studio-knob') ?? el?.parentElement?.parentElement;
    return {
      label: (group?.textContent ?? '').trim().slice(0, 60),
      options: [...(el?.querySelectorAll('button') ?? [])].map((b) => (b.textContent ?? '').trim()),
    };
  });
  console.log(`   knob: ${JSON.stringify(knob)}`);
  await shot('2-edit-magnitude');
  check(
    /edit magnitude/i.test(knob.label),
    `the knob is not called Edit magnitude (label: ${knob.label})`,
  );
  check(
    knob.options.join(',') === 'Low,Medium,High',
    `the amounts should be Low/Medium/High, got ${JSON.stringify(knob.options)}`,
  );

  /* ------------------------------------- a GRID still fills its cells */
  await page.click('[data-testid="studio-input-clear"]').catch(() => undefined);
  await seedRun([img, img, img, img]);
  await page.waitForTimeout(400);
  const grid = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('[data-testid="media-card"]')];
    const wrap = document.querySelector('[data-layout="grid"]');
    return {
      cards: cards.length,
      cardW: cards[0]?.getBoundingClientRect().width ?? 0,
      cellW: wrap === null ? 0 : wrap.getBoundingClientRect().width / 2,
    };
  });
  await shot('3-grid');
  check(grid.cards === 4, `expected 4 candidates, got ${grid.cards}`);
  check(
    grid.cardW > grid.cellW * 0.8,
    `grid cards should fill their cell so they can be compared (card ${Math.round(grid.cardW)} of cell ${Math.round(grid.cellW)})`,
  );

  console.log(`shots: ${OUT}`);
} finally {
  await finish();
}
