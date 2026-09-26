/**
 * THE CHECKS — what a person would wince at, measured, and said so the next
 * call can fix it.
 *
 * the user, on the page this replaces: "overlapping text, low contrast text …
 * emojis absolutely not, wall of text mixed with bullets neither with reference
 * to what the visual / interactiveness is, not tied in". Each of those is a
 * number here: label boxes that intersect (in every step's state, since a step
 * moves the sliders), text below 4.5:1 on its ground, emoji (removed), a step
 * that is a list or a paragraph, steps that point at nothing in the figure.
 * Plus what breaks a figure outright: a point off the view, a curve with no
 * values, a slider that moves nothing, a step naming a part that does not exist.
 *
 * `fix` is a problem the page shows; `warn` is weak; `note` is information.
 */
import { valuesAtStep } from './build.js';
import { type Evaluators, mvHit, mvPlain, mvScene, type Values } from './runtime.js';
import type { Panel } from './scene-types.js';
import type { MathSpec } from './spec.js';

export interface Problem {
  readonly level: 'fix' | 'warn' | 'note';
  readonly text: string;
}

const words = (s: string) => s.split(/\s+/).filter(Boolean).length;
const q = (s: string) => `“${s}”`;

/** Every id a step may point at, with what it is. */
export function partsOf(spec: MathSpec): Map<string, string> {
  const parts = new Map<string, string>();
  for (const c of spec.plot?.curves ?? []) parts.set(c.id, c.label ?? 'curve');
  for (const p of spec.plot?.points ?? []) parts.set(p.id, p.label ?? 'point');
  for (const a of spec.plot?.areas ?? []) parts.set(a.id, a.label ?? 'area');
  for (const t of spec.plot?.tangents ?? []) parts.set(t.id, t.label ?? 'tangent');
  for (const r of spec.plot?.riemann ?? []) parts.set(r.id, 'rectangles');
  for (const s of spec.figure?.shapes ?? []) {
    parts.set(
      s.id,
      'label' in s && s.label !== undefined ? s.label : s.kind === 'label' ? s.text : s.kind,
    );
  }
  return parts;
}

function panelName(p: Panel): string {
  return p.kind === 'plot' ? 'the plot' : 'the figure';
}

export function checkMath(
  spec: MathSpec,
  E: Evaluators,
  reads: ReadonlyMap<string, ReadonlySet<string>>,
): Problem[] {
  const out: Problem[] = [];
  const seen = new Set<string>();
  const say = (level: Problem['level'], text: string) => {
    if (seen.has(text)) return;
    seen.add(text);
    out.push({ level, text });
  };
  const parts = partsOf(spec);
  const n = spec.steps.length;

  // Layout, in the state each step leaves the sliders in. A problem seen at
  // several steps is said once, with the steps it is seen at.
  const states: { step: number; values: Values }[] =
    n === 0
      ? [{ step: 0, values: valuesAtStep(spec, E, 0) }]
      : spec.steps.map((_, i) => ({ step: i + 1, values: valuesAtStep(spec, E, i + 1) }));
  const layout = new Map<string, { level: Problem['level']; steps: number[]; tail: string }>();
  const at = (level: Problem['level'], head: string, tail: string, stepNo: number) => {
    const e = layout.get(head) ?? { level, steps: [], tail };
    if (stepNo > 0 && !e.steps.includes(stepNo)) e.steps.push(stepNo);
    layout.set(head, e);
  };
  for (const st of states) {
    const scene = mvScene(spec, E, st.values, st.step);
    for (const panel of scene.panels) {
      const texts = panel.items.filter((it) => it.t === 'text');
      for (let i = 0; i < texts.length; i += 1) {
        const a = texts[i];
        if (a === undefined || a.t !== 'text') continue;
        const b0 = a.box;
        if (
          b0.x < -0.5 ||
          b0.y < -0.5 ||
          b0.x + b0.w > panel.w + 0.5 ||
          b0.y + b0.h > panel.h + 0.5
        ) {
          at(
            'fix',
            `the label ${q(mvPlain(a.text))} runs off the edge of ${panelName(panel)}`,
            ' — move what it names inward, or widen the view',
            st.step,
          );
        }
        for (let j = i + 1; j < texts.length; j += 1) {
          const b = texts[j];
          if (b === undefined || b.t !== 'text') continue;
          if (!(a.placed === true || b.placed === true)) continue;
          if (mvHit(a.box, b.box, -1)) {
            at(
              'fix',
              `labels overlap in ${panelName(panel)}: ${q(mvPlain(a.text))} and ${q(mvPlain(b.text))}`,
              ' — move one of the parts they name, or shorten a label',
              st.step,
            );
          }
        }
      }
      for (const o of panel.outside)
        at('fix', `${o.id} ${o.what.startsWith('(') ? 'at ' : '— '}${o.what}`, '', st.step);
      for (const h of panel.curveHealth) {
        const range =
          spec.plot !== undefined
            ? `x from ${spec.plot.x.min.toPrecision(3)} to ${spec.plot.x.max.toPrecision(3)}`
            : '';
        if (h.finite === 0) {
          say(
            'fix',
            `curve ${h.id} has no value anywhere on ${range} — check its expression (a square root or log of a negative, a division by zero)`,
          );
        } else if (h.finite < 0.6) {
          say(
            'warn',
            `curve ${h.id} has a value on only ${Math.round(h.finite * 100)}% of ${range}`,
          );
        } else if (h.flat && h.usesVar) {
          say('warn', `curve ${h.id} is flat everywhere — is its expression what you meant?`);
        }
      }
    }
  }

  for (const [head, e] of layout) {
    const all = n === 0 || e.steps.length === n;
    const steps = [...e.steps].sort((a, b) => a - b);
    const where = all
      ? ''
      : steps.length === 1
        ? ` at step ${steps[0]}`
        : ` at steps ${steps.slice(0, -1).join(', ')} and ${steps[steps.length - 1]}`;
    say(e.level, `${head}${where}${e.tail}`);
  }

  // Each slider's ends: a part that leaves the view while a slider is dragged.
  for (const p of spec.params.filter((q) => q.hidden !== true)) {
    for (const end of [p.min, p.max]) {
      const values = { ...valuesAtStep(spec, E, 0), [p.name]: end };
      for (const panel of mvScene(spec, E, values, 0).panels) {
        for (const o of panel.outside) {
          say(
            'warn',
            `with ${p.name} = ${end}, ${o.id} ${o.what.startsWith('(') ? 'is at ' : '— '}${o.what}`,
          );
        }
      }
    }
  }

  // Sliders that move nothing.
  const used = new Set<string>();
  for (const names of reads.values()) for (const nm of names) used.add(nm);
  for (const p of spec.params.filter((q) => q.hidden !== true)) {
    if (!used.has(p.name))
      say('warn', `slider ${p.name} moves nothing — use it in an expression, or remove it`);
  }

  // Steps.
  if (n === 0) {
    say(
      'note',
      'no steps — add 2 to 6, each one short paragraph that points at a part (its "highlight") or moves a slider ("set")',
    );
  }
  if (n > 8)
    say('warn', `${n} steps — a figure carries about 6; merge some, or make a second visual`);
  const loose: number[] = [];
  spec.steps.forEach((st, i) => {
    const k = i + 1;
    for (const id of st.highlight) {
      if (!parts.has(id))
        say(
          'fix',
          `step ${k} highlights ${q(id)}, which is not a part — the parts are ${[...parts.keys()].join(', ')}`,
        );
    }
    for (const name of Object.keys(st.set)) {
      if (!spec.params.some((p) => p.name === name)) {
        say(
          'fix',
          `step ${k} sets ${name}, which is not a slider${spec.params.length > 0 ? ` (sliders: ${spec.params.map((p) => p.name).join(', ')})` : ''}`,
        );
      }
    }
    const w = words(st.text.replace(/\$[^$]*\$/g, 'x'));
    if (w > 70) say('warn', `step ${k} is ${w} words — a step says one thing; split it`);
    if (
      /(^|\n)\s*([-*•]|\d+[.)])\s+\S/.test(st.text) &&
      st.text.split('\n').filter((l) => l.trim() !== '').length > 1
    ) {
      say(
        'warn',
        `step ${k} is a list — make each item its own step, pointing at its part of the figure`,
      );
    }
    const appears = [
      ...(spec.plot?.curves ?? []),
      ...(spec.plot?.points ?? []),
      ...(spec.plot?.areas ?? []),
      ...(spec.plot?.tangents ?? []),
      ...(spec.plot?.riemann ?? []),
      ...(spec.figure?.shapes ?? []),
    ].some((it) => it.appear === k && k > 1);
    const refs = /\{[A-Za-z_][\w-]*\}/.test(st.text);
    if (st.highlight.length === 0 && Object.keys(st.set).length === 0 && !appears && !refs)
      loose.push(k);
  });
  if (n >= 2 && loose.length >= 2) {
    say(
      'warn',
      `step${loose.length > 1 ? 's' : ''} ${loose.join(', ')} point${loose.length > 1 ? '' : 's'} at nothing in the figure — give each a "highlight" (the ids of the parts it talks about) or a "set" (the slider values it shows)`,
    );
  }
  for (const it of [
    ...(spec.plot?.curves ?? []),
    ...(spec.plot?.points ?? []),
    ...(spec.figure?.shapes ?? []),
  ]) {
    if (it.appear > Math.max(1, n))
      say(
        'warn',
        `${it.id} appears at step ${it.appear}, but there ${n === 1 ? 'is 1 step' : `are ${n} steps`}`,
      );
  }
  if (spec.title.length > 80)
    say(
      'warn',
      `the title is ${spec.title.length} characters — keep it under 60; the steps carry the explanation`,
    );
  for (const [id, text] of parts) {
    if (text.length > 36 && id !== text)
      say(
        'warn',
        `the label of ${id} is a sentence (${text.length} characters) — labels name things; sentences go in the steps`,
      );
  }
  for (const note of spec.notes) say('note', note);
  return out;
}

/** WCAG contrast of two #rrggbb colours. */
export function contrast(a: string, b: string): number {
  const lum = (hex: string) => {
    const n = Number.parseInt(hex.replace('#', '').slice(0, 6), 16);
    const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * (ch[0] ?? 0) + 0.7152 * (ch[1] ?? 0) + 0.0722 * (ch[2] ?? 0);
  };
  const [x, y] = [lum(a), lum(b)].sort((p, r) => r - p);
  return ((x ?? 0) + 0.05) / ((y ?? 0) + 0.05);
}
