/**
 * SEEING THE THINGS A SCREENSHOT CANNOT.
 *
 * the user: "I know you can't see 30fps video so you need to programatically detect
 * jittering, visual jitter, any snapping of an area, a button briefly appearing
 * for a few ms pushing something up then pushing everything back down again,
 * flashes of menus, things like that."
 *
 * Each of those is a different measurement, so this installs four recorders in
 * the page and reports what they saw:
 *
 *   SHIFT   Chromium's own `layout-shift` PerformanceObserver — the same signal
 *           Core Web Vitals is built on. Every entry names the nodes that moved
 *           and their before/after rects, so a shift is attributable rather than
 *           a number. Two exclusions, both about what jitter MEANS rather than
 *           about hitting a number: `hadRecentInput` entries (content moving
 *           because you clicked is the UI responding), and anything inside the
 *           chat transcript while a reply streams — a chat that streams text
 *           moves text, and calling that a defect would bury the real ones. A
 *           BOUNCE inside the transcript is still reported: text arriving pushes
 *           things one way, never back and forth.
 *
 *   BOUNCE  The specific shape the user described — something appears, pushes the
 *           layout, and it comes back. Detected on the SHIFT stream: a node
 *           whose rect moves away and returns to within a pixel of where it was
 *           inside 600ms. This is the one that reads as a twitch rather than as
 *           a transition, and a single-shift threshold cannot see it.
 *
 *   FLASH   A MutationObserver over added/removed nodes: anything that was
 *           VISIBLE (non-zero box) and lived less than 250ms. A menu that opens
 *           and closes on its own, a button that blinks in and out.
 *
 *   STALL   A rAF sampler recording frames that took longer than 100ms. Not
 *           strictly jitter, but it is what "snapping" looks like when the cause
 *           is the main thread: nothing moves, then everything does at once.
 *
 * Everything is opt-in per scenario (`mark`), so a report says WHICH interaction
 * misbehaved rather than handing back a session-wide total nobody can act on.
 */

/** Install the recorders. Call once, after the app has mounted. */
export async function armJitter(page) {
  await page.evaluate(() => {
    const state = {
      phase: 'idle',
      shifts: [],
      flashes: [],
      stalls: [],
      seen: new Map(),
    };
    window.__jitter = state;

    /*
     * WHAT THE USER JUST DID IS NOT JITTER.
     *
     * Chromium's own layout-shift entries carry `hadRecentInput` for exactly
     * this reason: content moving because someone clicked or typed is the UI
     * responding, not twitching. The flash recorder needs the same rule, and
     * MEASURED without it the loudest findings were self-inflicted — the send
     * button "appearing for 22ms" because the probe types a message and presses
     * Enter in the same tick, which no person does.
     *
     * 500ms is Chromium's window, kept the same so both recorders agree.
     */
    const INPUT_WINDOW_MS = 500;
    let lastInputAt = -Infinity;
    for (const type of ['keydown', 'pointerdown', 'wheel']) {
      window.addEventListener(
        type,
        () => {
          lastInputAt = performance.now();
        },
        { capture: true, passive: true },
      );
    }
    const afterInput = (at) => at - lastInputAt < INPUT_WINDOW_MS;

    /** Is this node inside the streaming transcript? See the SHIFT note above. */
    const inTranscript = (el) => {
      try {
        return el?.closest?.('[data-testid="chat-scroll"]') != null;
      } catch {
        return false;
      }
    };

    const rectOf = (el) => {
      try {
        const b = el.getBoundingClientRect();
        return {
          x: Math.round(b.x),
          y: Math.round(b.y),
          w: Math.round(b.width),
          h: Math.round(b.height),
        };
      } catch {
        return null;
      }
    };
    /** A short, human label for a node: what a person would call it. */
    const label = (el) => {
      if (el === null || el === undefined || el.nodeType !== 1) return '(text)';
      const t = el.getAttribute?.('data-testid');
      if (t) return `[${t}]`;
      const cls = String(el.className ?? '')
        .split(/\s+/)
        .filter((c) => c.startsWith('pd-'))
        .slice(0, 2)
        .join('.');
      // Distinguish siblings that share a class — "which .pd-topbar-section"
      // is the whole question when one of three moves.
      const nth = el.parentElement === null ? -1 : [...el.parentElement.children].indexOf(el);
      const base = cls.length > 0 ? `.${cls}` : el.tagName.toLowerCase();
      return `${base}#${nth}(${el.children.length})`;
    };
    window.__jitterLabel = label;

    // ── SHIFT + BOUNCE ────────────────────────────────────────────────────────
    // A node's recent positions, so a move that RETURNS can be recognised.
    const history = new Map();
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          // Content moving because the user just acted is layout, not jitter.
          if (entry.hadRecentInput) continue;
          const at = Math.round(entry.startTime);
          for (const src of entry.sources ?? []) {
            const node = src.node;
            if (node === null || node === undefined) continue;
            const key = label(node);
            const to = src.currentRect;
            const from = src.previousRect;
            const moved = Math.round(Math.abs(to.y - from.y) + Math.abs(to.x - from.x));
            if (moved < 2) continue;
            /*
             * AN EMPTY BOX MOVING IS NOT A VISUAL SHIFT.
             *
             * `sources` includes layout boxes whose paint is empty. MEASURED:
             * the top bar's centre section — a spacer with no children and no
             * text — "shifted 82px" every time the title's length changed, while
             * the title itself and the control on the right did not move a pixel.
             * Nobody can see an empty div move, and reporting it hides the ones
             * they can. Nothing about an empty box is worth recording, so this
             * one skips the bounce history too.
             */
            if (node.children?.length === 0 && (node.textContent ?? '').trim() === '') continue;
            /*
             * A BOX THAT CHANGED SIZE GAINED OR LOST CONTENT — that is the app
             * showing you something, not the layout twitching. MEASURED: the top
             * bar's right section grows 28→110px when the model hub adds its own
             * controls, which reads as an "82px shift" while being the
             * deliberate, permanent difference between two routes.
             *
             * It is excluded from the SHIFT list only. The bounce detector below
             * still sees it, because a box returning to where it was is jitter
             * whatever its size did on the way — and a streaming text block, the
             * clearest case of "resized", is exactly where a 3px twitch hides.
             */
            const resized =
              Math.round(Math.abs(to.width - from.width) + Math.abs(to.height - from.height)) > 1;
            if (!resized) {
              state.shifts.push({
                phase: state.phase,
                at,
                node: key,
                moved,
                value: entry.value,
                inThread: inTranscript(node),
                from: `${Math.round(from.x)},${Math.round(from.y)} ${Math.round(from.width)}x${Math.round(from.height)}`,
                to: `${Math.round(to.x)},${Math.round(to.y)} ${Math.round(to.width)}x${Math.round(to.height)}`,
              });
            }
            const past = history.get(key) ?? [];
            // Did this node just come BACK to somewhere it was moments ago?
            const back = past.find(
              (p) => at - p.at < 600 && Math.abs(p.y - to.y) <= 1 && Math.abs(p.x - to.x) <= 1,
            );
            if (back !== undefined && !afterInput(performance.now())) {
              state.flashes.push({
                kind: 'bounce',
                phase: state.phase,
                at,
                node: key,
                ms: at - back.at,
                movedPx: moved,
              });
            }
            past.push({ at, x: from.x, y: from.y });
            history.set(key, past.slice(-12));
          }
        }
      }).observe({ type: 'layout-shift', buffered: true });
    } catch {
      // No layout-shift support ⇒ the other three recorders still run.
    }

    // ── FLASH ─────────────────────────────────────────────────────────────────
    const born = new Map();
    const observer = new MutationObserver((records) => {
      const now = Math.round(performance.now());
      for (const r of records) {
        for (const n of r.addedNodes) {
          if (n.nodeType !== 1) continue;
          const box = rectOf(n);
          if (box === null || box.w < 4 || box.h < 4) continue;
          born.set(n, { at: now, box, key: label(n) });
        }
        for (const n of r.removedNodes) {
          if (n.nodeType !== 1) continue;
          const b = born.get(n);
          born.delete(n);
          if (b === undefined) continue;
          const life = now - b.at;
          // Under a quarter second, and big enough to notice: a blink.
          if (life < 250 && b.box.w >= 8 && b.box.h >= 8 && !afterInput(b.at)) {
            state.flashes.push({
              kind: 'flash',
              phase: state.phase,
              at: b.at,
              node: b.key,
              ms: life,
              box: b.box,
            });
          }
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });

    // ── STALL ─────────────────────────────────────────────────────────────────
    let last = performance.now();
    const tick = () => {
      const now = performance.now();
      const dt = now - last;
      last = now;
      // A frame lost to laying out what the user just asked for is not a stall.
      if (dt > 100 && !afterInput(now)) {
        state.stalls.push({ phase: state.phase, at: Math.round(now), ms: Math.round(dt) });
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

/** Name the scenario that follows, so findings are attributable. */
export async function mark(page, phase) {
  await page.evaluate((p) => {
    if (window.__jitter !== undefined) window.__jitter.phase = p;
  }, phase);
}

/** Everything the recorders saw, grouped by scenario. */
export async function jitterReport(page) {
  return await page.evaluate(() => {
    const s = window.__jitter;
    if (s === undefined) return null;
    const byPhase = {};
    const bucket = (p) => (byPhase[p] ??= { shifts: [], flashes: [], bounces: [], stalls: [] });
    for (const x of s.shifts) bucket(x.phase).shifts.push(x);
    for (const x of s.flashes) bucket(x.phase)[x.kind === 'bounce' ? 'bounces' : 'flashes'].push(x);
    for (const x of s.stalls) bucket(x.phase).stalls.push(x);
    return byPhase;
  });
}

/**
 * Print the report and return the findings worth acting on.
 *
 * The thresholds are deliberately about NOTICEABILITY, not purity: a 2px settle
 * as a font loads is not what anyone means by jitter, and reporting it buries
 * the twitch that is. A bounce is always reported — that shape is never right.
 */
export function summarizeJitter(report, { shiftPx = 8, stallMs = 250 } = {}) {
  const findings = [];
  for (const [phase, r] of Object.entries(report ?? {})) {
    if (phase === 'idle') continue;
    // Content arriving in the transcript moves the transcript; that is the app
    // working. Everything ELSE that moves is a candidate defect.
    const bigShifts = r.shifts.filter((x) => x.moved >= shiftPx && x.inThread !== true);
    const bigStalls = r.stalls.filter((x) => x.ms >= stallMs);
    for (const b of r.bounces) {
      findings.push(`${phase}: ${b.node} moved ${b.movedPx}px and came back ${b.ms}ms later`);
    }
    for (const f of r.flashes) {
      findings.push(`${phase}: ${f.node} appeared for ${f.ms}ms (${f.box.w}x${f.box.h})`);
    }
    // Shifts are reported per NODE, loudest first — twenty entries for one
    // element is one bug, not twenty.
    const worst = new Map();
    for (const x of bigShifts) {
      const cur = worst.get(x.node);
      if (cur === undefined || x.moved > cur.moved) worst.set(x.node, x);
    }
    for (const x of [...worst.values()].sort((a, b) => b.moved - a.moved).slice(0, 5)) {
      const n = bigShifts.filter((y) => y.node === x.node).length;
      findings.push(`${phase}: ${x.node} shifted ${x.moved}px${n > 1 ? ` (${n}×)` : ''}`);
    }
    for (const x of bigStalls.slice(0, 3)) findings.push(`${phase}: ${x.ms}ms frame`);
  }
  return findings;
}
