/**
 * ROUND 2 — MEDIA HANDOFF INTO THE STUDIOS, AND EDITING.
 *
 * The user: "all types of media handoff into studios and editing will also be tested
 * in a second round."
 *
 * Before this round exactly one handoff existed and it carried nothing: a mesh
 * offered "Open in studio", which switched the view and left the mesh behind.
 * This probe drives the whole set the way a person would, on the REAL app, and
 * checks the thing that actually matters each time — not that a button exists,
 * but that the media ARRIVED:
 *
 *   1  a picture in the transcript opens the Image studio holding the picture
 *   2  …with the prompt that made it already in the box, and the run reading Edit
 *   3  …and a "how much to change" knob that only exists because there is input
 *   4  dropping a file on a studio makes it the input
 *   5  dropping the WRONG file is refused out loud, not swallowed
 *   6  a clip opens the Video studio, a sound the Audio studio
 *   7  a mesh opens the 3D studio and LOADS — the original round-1 gap
 *   8  a result inside a studio goes back to the conversation
 *   9  clearing the input returns the room to plain generation
 *
 * The four jitter recorders are armed throughout (see jitter.mjs), because a
 * handoff that works but flashes the room on arrival is still wrong.
 *
 * Run `npm run build` first.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchApp } from './harness.mjs';
import { armJitter, jitterReport, mark as markPhase, summarizeJitter } from './jitter.mjs';

const started = Date.now();
const mark = async (page, phase) => {
  console.log(`[${((Date.now() - started) / 1000).toFixed(0)}s] ${phase}`);
  await markPhase(page, phase);
};

/* ------------------------------------------------------------------ fixtures */
// Real files on disk: the handoff carries a PATH, and every consumer of it
// (pd-file:// fetch, the 3D importer, the worker argv) reads that path for
// real. A fake path would make every one of these checks vacuous.
//
// Under `~/Bobble/generated` specifically, because that is where the app's own
// generations land and `pd-file://` is FENCED to the app's working roots. A
// fixture in /tmp is served 403 and every thumbnail draws broken — which is the
// app behaving correctly and the probe lying about it. (This is exactly the
// case a file dropped from ~/Downloads hits, and why a drop hands over an
// object URL instead; see StudioHandoff.previewUrl.)
const home = mkdtempSync(path.join(tmpdir(), 'pd-handoff-home-'));
const media = path.join(home, 'Bobble', 'generated');
mkdirSync(media, { recursive: true });

// An 8x8 solid PNG, hand-built so there is no fixture dependency. It has to
// DECODE, not merely have a PNG header: an <img> pointed at a malformed one
// still reports `complete`, so a broken fixture reads as a broken app.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAEklEQVR42mO4E6XxHx9mGBkKAPurl0HEB0S7AAAAAElFTkSuQmCC',
  'base64',
);
const imgPath = path.join(media, 'fox-real.png');
writeFileSync(imgPath, PNG);

// A minimal valid GLB: 12-byte header + a JSON chunk holding an empty glTF.
// The 3D importer only has to REGISTER and load it; a scene with no meshes is
// still a scene, and this keeps the probe free of a binary fixture.
const gltf = Buffer.from(JSON.stringify({ asset: { version: '2.0' }, scenes: [], nodes: [] }));
const jsonPad = Buffer.concat([gltf, Buffer.alloc((4 - (gltf.length % 4)) % 4, 0x20)]);
const glb = Buffer.alloc(12 + 8 + jsonPad.length);
glb.write('glTF', 0, 'ascii');
glb.writeUInt32LE(2, 4);
glb.writeUInt32LE(glb.length, 8);
glb.writeUInt32LE(jsonPad.length, 12);
glb.write('JSON', 16, 'ascii');
jsonPad.copy(glb, 20);
const glbPath = path.join(media, 'bust.glb');
writeFileSync(glbPath, glb);

const clipPath = path.join(media, 'clip.mp4');
writeFileSync(clipPath, Buffer.alloc(2048, 0));
const wavPath = path.join(media, 'take.wav');
writeFileSync(wavPath, Buffer.alloc(2048, 0));
const notMedia = path.join(media, 'notes.txt');
writeFileSync(notMedia, 'this is not a picture');

mkdirSync(path.join(home, '.pi', 'agent', 'sessions', 'proj'), { recursive: true });

const { page, shot, check, finish, shotDir } = await launchApp('media-handoff-probe', {
  env: { HOME: home },
  args: ['--', '--piE2E=1'],
});

/**
 * NAVIGATE THE WAY A PERSON DOES — with a real click on the real sidebar row.
 *
 * Not `setView()` from page script. Both land in the same store, but only one
 * of them tells the jitter recorders that a human caused what follows: their
 * input gate (Chromium's own `hadRecentInput` rule, mirrored for the flash and
 * stall recorders) keys off keydown/pointerdown, so a store-driven navigation
 * reports every unmounting element of the room you LEFT as a defect. MEASURED:
 * 21 findings that way, all of them the probe's own doing.
 */
const openStudio = async (target) => {
  const row = `[data-testid="modality-${target}"]`;
  if ((await page.$(row)) === null) await page.click('text=Modalities');
  await page.click(row);
};

/** Offer the media the way MediaCard does, then walk into the room. */
const handTo = async (target, item) => {
  await page.evaluate(([t, i]) => window.__studio_handoff().getState().offer(t, i), [target, item]);
  await openStudio(target);
};

// Each room names its own shell (`image-studio`, `video-studio`, `audio-studio`);
// `.pd-studio` is the class they all share, which is what "any studio mounted"
// actually means here.
const inStudio = () => page.waitForSelector('.pd-studio', { timeout: 15_000 });
// Escape is the room's documented way out, and it is a real keypress.
const backToChat = async () => {
  await page.keyboard.press('Escape');
  await page.waitForSelector('.pd-composer-editor', { timeout: 10_000 });
};

/**
 * A real DataTransfer drop, dispatched as the browser would.
 *
 * `DataTransfer` cannot be built with files from page script, so the drop is
 * synthesised with a `types` array and a `files` list carrying real `File`
 * objects. That is exactly what the shell reads (`types` includes 'Files';
 * `files` is turned into an array) — the one thing it cannot exercise is
 * Electron's `pathForFile`, which is why the probe also asserts the shape the
 * hook produces rather than only that the veil appeared.
 */
const dropFile = (selector, name, type) =>
  page.evaluate(
    ([sel, fileName, mime]) => {
      const el = document.querySelector(sel);
      if (el === null) return 'no element';
      const file = new File([new Uint8Array([1, 2, 3, 4])], fileName, { type: mime });
      const dt = new DataTransfer();
      dt.items.add(file);
      const fire = (kind) => {
        const e = new DragEvent(kind, { bubbles: true, cancelable: true, dataTransfer: dt });
        el.dispatchEvent(e);
      };
      fire('dragenter');
      fire('dragover');
      return 'dispatched';
    },
    [selector, name, type],
  );

const dropRelease = (selector, name, mime) =>
  page.evaluate(
    ([sel, fileName, type]) => {
      const el = document.querySelector(sel);
      const file = new File([new Uint8Array([1, 2, 3, 4])], fileName, { type });
      const dt = new DataTransfer();
      dt.items.add(file);
      el.dispatchEvent(
        new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }),
      );
    },
    [selector, name, mime],
  );

try {
  await page.waitForFunction(() => typeof window.__studio_handoff === 'function', {
    timeout: 15_000,
  });
  await armJitter(page);

  /* ------------------------------------------------- 1-3 picture → Image studio */
  await mark(page, 'image handoff');
  await handTo('image', {
    path: imgPath,
    name: 'fox-real.png',
    kind: 'image',
    prompt: 'a red fox in snow',
    seed: 4242,
  });
  await inStudio();
  await page.waitForSelector('[data-testid="studio-input"]', { timeout: 8000 });

  // Decoding is asynchronous: sampling `complete` in the same tick the card
  // appears reports every working thumbnail as broken.
  await page
    .waitForFunction(
      () => {
        const img = document.querySelector('[data-testid="studio-input"] img');
        return img?.complete;
      },
      { timeout: 8000 },
    )
    .catch(() => undefined);
  const shown = await page.evaluate(async () => {
    const card = document.querySelector('[data-testid="studio-input"]');
    const img = card?.querySelector('img');
    const src = img?.getAttribute('src') ?? '';
    // …and if it did NOT draw, say why: the fence returns a status, and "403
    // outside allowed roots" is a completely different bug from "no such file".
    let status = 'n/a';
    if (img !== null && !(img.complete === true && img.naturalWidth > 0)) {
      status = await fetch(src)
        .then((r) => `${r.status} ${r.statusText}`)
        .catch((e) => `fetch threw: ${e}`);
    }
    return {
      name: card?.textContent ?? '',
      // The thumbnail must resolve to the file we handed over, through the
      // app's own scheme — a card that draws a broken image is worse than none.
      src,
      complete: img?.complete === true && img.naturalWidth > 0,
      status,
    };
  });
  check(
    shown.name.includes('fox-real.png'),
    `the input card does not name the file: ${shown.name}`,
  );
  check(
    shown.src.startsWith('pd-file://'),
    `the thumb is not served over pd-file:// (${shown.src})`,
  );
  check(shown.complete, `the input thumbnail did not actually load (${shown.status})`);

  const composerText = await page.evaluate(
    () =>
      document.querySelector('.pd-studio-composer textarea, .pd-studio-composer input')?.value ??
      '',
  );
  check(
    composerText.includes('red fox'),
    `the prompt that made it was not seeded into the box (got "${composerText}")`,
  );

  const runLabel = await page.evaluate(
    () => document.querySelector('[data-testid="studio-run"]')?.textContent?.trim() ?? '',
  );
  check(runLabel === 'Edit', `the run button still says "${runLabel}" with an input loaded`);

  // The change-amount knob exists only WITH an input — a slider that does
  // nothing most of the time teaches people to ignore it. The rail is always in
  // the DOM (it slides via `data-open`), so its presence is the whole claim.
  const strengthKnob = await page.$('[data-testid="image-strength-rail"]');
  check(strengthKnob !== null, 'no change-amount knob appeared for an edit');
  if (strengthKnob !== null) {
    const labels = await page.evaluate(() =>
      [...document.querySelectorAll('[data-testid="image-strength-rail"] button')].map((b) =>
        b.textContent?.trim(),
      ),
    );
    check(
      labels.length >= 3,
      `the change knob offers ${labels.length} amounts: ${JSON.stringify(labels)}`,
    );
  }
  await shot('1-image-input');

  /* ------------------------------------------------------- 9 clearing the input */
  await mark(page, 'clear input');
  await page.click('[data-testid="studio-input-clear"]');
  await page.waitForSelector('[data-testid="studio-input"]', { state: 'detached', timeout: 5000 });
  const clearedLabel = await page.evaluate(
    () => document.querySelector('[data-testid="studio-run"]')?.textContent?.trim() ?? '',
  );
  check(
    clearedLabel === 'Generate',
    `clearing the input left the room in edit mode (button says "${clearedLabel}")`,
  );

  /* ------------------------------------------------------------ 4-5 file drops */
  await mark(page, 'drop accepted');
  await dropFile('.pd-studio', 'poster.png', 'image/png');
  await page.waitForSelector('[data-testid="studio-drop-veil"]', { timeout: 4000 });
  const okVeil = await page.evaluate(() => ({
    ok: document.querySelector('[data-testid="studio-drop-veil"]')?.getAttribute('data-ok'),
    text: document.querySelector('[data-testid="studio-drop-veil"]')?.textContent ?? '',
  }));
  check(okVeil.ok === 'yes', `an image drag was not welcomed (data-ok=${okVeil.ok})`);
  check(okVeil.text.length > 0, 'the drop veil says nothing');
  await shot('2-drop-veil');

  await mark(page, 'drop refused');
  await dropRelease('.pd-studio', 'notes.txt', 'text/plain');
  await page.waitForTimeout(200);
  const refused = await page.evaluate(() =>
    document.querySelector('[data-testid="studio-drop-veil"]')?.getAttribute('data-ok'),
  );
  check(
    refused === 'no',
    `a .txt dropped on the Image studio was not refused (data-ok=${refused})`,
  );
  const refusalText = await page.evaluate(
    () => document.querySelector('[data-testid="studio-drop-veil"]')?.textContent ?? '',
  );
  check(
    refusalText.toLowerCase().includes("can't") || refusalText.toLowerCase().includes('cannot'),
    `the refusal does not say why: "${refusalText}"`,
  );
  await shot('3-drop-refused');
  // …and it clears itself rather than sitting there forever.
  await page.waitForSelector('[data-testid="studio-drop-veil"]', {
    state: 'detached',
    timeout: 6000,
  });

  /* ---------------------------------------------------- 6 video + audio studios */
  for (const [target, file, name] of [
    ['video', clipPath, 'clip.mp4'],
    ['audio', wavPath, 'take.wav'],
  ]) {
    await mark(page, `${target} handoff`);
    await backToChat();
    await handTo(target, { path: file, name, kind: target });
    await inStudio();
    await page.waitForSelector('[data-testid="studio-input"]', { timeout: 8000 });
    const label = await page.evaluate(
      () => document.querySelector('[data-testid="studio-input"]')?.textContent ?? '',
    );
    check(label.includes(name), `the ${target} studio does not name its input: ${label}`);
    await shot(`4-${target}-input`);
  }

  /* ------------------------------------------------------------ 7 mesh → 3D */
  // THE ROUND-1 GAP. "Open in studio" on a mesh switched the view and left the
  // mesh behind. The claim now is that the file is REGISTERED as an asset and
  // loaded — read from the 3D store, which is the only place that can tell.
  await mark(page, '3d handoff');
  await backToChat();
  await handTo('3d', { path: glbPath, name: 'bust.glb', kind: 'model' });
  const loaded = await page
    .waitForFunction(
      () => {
        const s = window.__tripo_store?.().getState?.();
        if (s === undefined) return false;
        return s.assets.some((a) => a.name === 'bust') && s.loadedAssetId !== null;
      },
      { timeout: 20_000 },
    )
    .then(() => true)
    .catch(() => false);
  const assets = await page.evaluate(
    () =>
      window
        .__tripo_store?.()
        .getState?.()
        .assets?.map((a) => a.name) ?? null,
  );
  check(loaded, `a mesh handed to the 3D studio did not load (assets: ${JSON.stringify(assets)})`);
  // The handoff must be CONSUMED — coming back later should not re-import it.
  const stillPending = await page.evaluate(() => window.__studio_handoff().getState().peek('3d'));
  check(stillPending === null, 'the 3D handoff was not consumed');
  await shot('5-3d-loaded');

  /* -------------------------------------------------- 8 studio result → chat */
  await mark(page, 'result → chat, and back as input');
  await backToChat();
  await openStudio('image');
  await inStudio();
  // A finished run put on screen through the store's E2E hook rather than by
  // spending two minutes of GPU: the question here is what the CARD offers, and
  // tying that to a real diffusion run is what makes visual checks too slow to
  // run at all.
  await page.evaluate(
    ([p]) => {
      window
        .__studio_runs()
        .getState()
        .add('image', {
          prompt: 'a red fox in snow',
          at: Date.now(),
          seed: 4242,
          items: [{ path: p, name: 'fox-real.png', kind: 'image' }],
        });
    },
    [imgPath],
  );
  await page.waitForSelector('[data-testid="media-card"]', { timeout: 8000 });

  // IN ITS OWN ROOM the card offers the two moves that make sense here, and not
  // the one that does not: "Open in studio" would go where you already are.
  await page.hover('[data-testid="media-card"]');
  await page.waitForTimeout(150);
  const studioBtn = await page.evaluate(
    () => document.querySelector('[data-testid="media-open-studio"]')?.textContent?.trim() ?? '',
  );
  check(studioBtn === 'Use as input', `inside its own studio the card still says "${studioBtn}"`);
  check(
    (await page.$('[data-testid="media-send-chat"]')) !== null,
    'no way back to the conversation from a studio result',
  );
  await shot('6-result-card');

  // Use as input: the iterate loop, with the room ALREADY open — the case a
  // mount-only handoff read silently dropped.
  await page.click('[data-testid="media-open-studio"]');
  await page.waitForSelector('[data-testid="studio-input"]', { timeout: 6000 });
  const reused = await page.evaluate(
    () => document.querySelector('[data-testid="studio-input"]')?.textContent ?? '',
  );
  check(
    reused.includes('fox-real.png'),
    `"Use as input" did not load the result (card says: ${reused})`,
  );
  const stillHere = await page.evaluate(() => window.__modality_store().getState().view);
  check(stillHere === 'image', `"Use as input" navigated away to ${stillHere}`);

  // …and the trip back to the conversation, driven by the real button.
  await page.hover('[data-testid="media-card"]');
  /*
   * WAIT FOR THE BUTTON TO BECOME CLICKABLE, not for 150ms.
   *
   * The card's controls are hover-revealed — `opacity: 0; pointer-events: none`
   * until the card is hovered — and a probe's window is never shown, so its
   * renderer runs off a timer at roughly 12fps rather than off vsync (MEASURED;
   * see background-mode.ts). 150ms is one or two frames there, so the transition
   * was routinely still in flight and the click hit-tested straight through the
   * transparent button onto `.pd-studio-results` behind it. Playwright then
   * reports the container "intercepts pointer events", which reads like a
   * z-index bug and is really a stopwatch that is too short.
   */
  await page.waitForFunction(
    () => {
      const b = document.querySelector('[data-testid="media-send-chat"]');
      if (b === null) return false;
      const cs = getComputedStyle(b);
      return cs.opacity === '1' && cs.pointerEvents !== 'none';
    },
    null,
    { timeout: 5000 },
  );
  await page.click('[data-testid="media-send-chat"]');
  await page.waitForSelector('.pd-composer-editor', { timeout: 10_000 });
  const landed = await page
    .waitForFunction(
      () =>
        document.querySelectorAll('[data-testid="composer-attachments"] *').length > 0 ||
        (document.querySelector('.pd-composer-editor')?.textContent ?? '').length > 0,
      { timeout: 8000 },
    )
    .then(() => true)
    .catch(() => false);
  const what = await page.evaluate(() => ({
    attachments: [...document.querySelectorAll('[data-testid="composer-attachments"] *')]
      .map((e) => e.textContent?.trim())
      .filter((t) => t !== undefined && t.length > 0)
      .slice(0, 3),
    text: document.querySelector('.pd-composer-editor')?.textContent ?? '',
  }));
  check(
    landed,
    `sending a picture to the conversation put nothing in the composer: ${JSON.stringify(what)}`,
  );
  await shot('7-back-in-chat');

  /* ------------------------------------------------------------- jitter verdict */
  const report = await jitterReport(page);
  const findings = summarizeJitter(report);
  if (findings.length > 0) {
    console.error('\nJITTER FINDINGS');
    for (const f of findings) console.error(`  ${f}`);
    check(false, `${findings.length} jitter finding(s) across the handoff paths`);
  } else {
    console.log('no jitter findings across the handoff paths');
  }

  console.log(`shots: ${shotDir}`);
} finally {
  await finish();
}
