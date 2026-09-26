/**
 * THE PAGE — one standard look for every math visual, in Bobble's design kit.
 *
 * What the user saw instead ("flimsy feeling, text on dark blue background on
 * grid, cards seem out of place totally, blue text why? … not well formatted
 * or spaced") decides what is here and what is not: the kit's paper ground and
 * ink, no cards, no panels, no gradients, no coloured text — colour belongs to
 * the curves and shapes, and a label is tied to its curve by a short key in the
 * curve's colour. The figure leads; the steps sit beside it (below it on a
 * narrow window), numbered, one short paragraph each, and the one being read
 * is marked and lights its parts of the figure. Maths is typeset (KaTeX, fonts
 * inlined — the file stands alone). Light and dark follow the system.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { currentPlatform, type Kit, type KitColours } from '@pi-desktop/design-kit';
import katex from 'katex';
import { type Compiled, evaluatorsScript } from './build.js';
import {
  type Evaluators,
  mvEsc,
  mvRuns,
  mvScene,
  mvSvg,
  runtimeSource,
  type Values,
} from './runtime.js';
import type { MathSpec, Role } from './spec.js';

/** KaTeX's stylesheet with the fonts a page actually uses, as data URIs. */
let katexCss: string | undefined;
const FONTS = new Set([
  'KaTeX_Main-Regular',
  'KaTeX_Main-Bold',
  'KaTeX_Main-Italic',
  'KaTeX_Main-BoldItalic',
  'KaTeX_Math-Italic',
  'KaTeX_Math-BoldItalic',
  'KaTeX_AMS-Regular',
  'KaTeX_Size1-Regular',
  'KaTeX_Size2-Regular',
  'KaTeX_Size3-Regular',
  'KaTeX_Size4-Regular',
]);
export function inlineKatexCss(): string {
  if (katexCss !== undefined) return katexCss;
  const cssPath = createRequire(import.meta.url).resolve('katex/dist/katex.min.css');
  const dir = path.dirname(cssPath);
  const css = readFileSync(cssPath, 'utf8');
  katexCss = css.replace(/@font-face\{[^}]*\}/g, (block) => {
    const m = /url\(fonts\/(KaTeX_[\w-]+)\.woff2\)/.exec(block);
    const name = m?.[1];
    if (name === undefined || !FONTS.has(name)) return '';
    const data = readFileSync(path.join(dir, 'fonts', `${name}.woff2`)).toString('base64');
    return block.replace(/src:[^;}]*/, `src:url(data:font/woff2;base64,${data}) format("woff2")`);
  });
  return katexCss;
}

function tex(src: string, display: boolean): string {
  return katex.renderToString(src, {
    throwOnError: false,
    displayMode: display,
    output: 'html',
    strict: 'ignore',
  });
}

const GREEK = new Set([
  'alpha',
  'beta',
  'gamma',
  'delta',
  'epsilon',
  'theta',
  'lambda',
  'mu',
  'omega',
  'phi',
  'psi',
  'rho',
  'sigma',
  'tau',
  'Omega',
  'Delta',
  'Theta',
]);

/** A slider's name as maths: n → 𝑛, omega → ω, x0 → x₀; a word stays a word. */
function paramLabel(label: string): string {
  const m = /^([A-Za-z]+?)(_?\d+)?$/.exec(label);
  if (m !== null && (m[1]?.length === 1 || GREEK.has(m[1] ?? ''))) {
    const base = (m[1]?.length ?? 0) > 1 ? `\\${m[1]}` : (m[1] ?? '');
    const sub = m[2] !== undefined ? `_{${m[2].replace('_', '')}}` : '';
    return tex(base + sub, false);
  }
  return inline(label, new Map());
}

/**
 * Step text as HTML: `$…$` typeset, `$$…$$` on its own line, `{id}` a
 * reference to a part (its colour key and its name; hovering lights it), and
 * `**bold**`, `*italic*`. Everything else is escaped.
 */
export function inline(
  text: string,
  parts: ReadonlyMap<string, { name: string; role?: Role }>,
): string {
  const out: string[] = [];
  const re = /\$\$([^$]+)\$\$|\$([^$]+)\$|\{([A-Za-z_][\w-]*)\}/g;
  let last = 0;
  const plain = (s: string) =>
    mvEsc(s)
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    out.push(plain(text.slice(last, m.index)));
    if (m[1] !== undefined) out.push(`<span class="mv-display">${tex(m[1], true)}</span>`);
    else if (m[2] !== undefined) out.push(tex(m[2], false));
    else {
      const id = m[3] ?? '';
      const part = parts.get(id);
      if (part === undefined) out.push(mvEsc(id));
      else {
        const key =
          part.role !== undefined
            ? `<svg class="mv-swatch" viewBox="0 0 14 10" aria-hidden="true"><line x1="1.5" y1="5" x2="12.5" y2="5" class="mv-s-${part.role}" stroke-width="3" stroke-linecap="round"/></svg>`
            : '';
        out.push(
          `<span class="mv-ref" data-mv-ref="${mvEsc(id)}">${key}${labelHtml(part.name)}</span>`,
        );
      }
    }
    last = m.index + m[0].length;
  }
  out.push(plain(text.slice(last)));
  return out.join('');
}

/**
 * How a step's `{id}` reads: the part's label when it is a name ("square
 * wave", "molecule"); its id when the label is only a symbol ("m" → "mass");
 * what it is for a tangent or rectangles. A label's `{n}` parts are dropped.
 */
function partsWithRoles(spec: MathSpec): Map<string, { name: string; role?: Role }> {
  const m = new Map<string, { name: string; role?: Role }>();
  const named = (label: string | undefined, id: string, what?: string) => {
    const clean =
      label
        ?.replace(/\{[^}]*\}/g, '')
        .replace(/[,:=]\s*$/, '')
        .trim() ?? '';
    if ((clean.match(/\p{L}/gu)?.length ?? 0) >= 3) return clean;
    if (what !== undefined) return what;
    return /^[A-Za-z][A-Za-z ]{2,}$/.test(id) ? id.replace(/_/g, ' ') : clean || id;
  };
  for (const c of spec.plot?.curves ?? [])
    m.set(c.id, { name: named(c.label, c.id), role: c.role });
  for (const p of spec.plot?.points ?? [])
    m.set(p.id, { name: named(p.label, p.id), role: p.role });
  for (const a of spec.plot?.areas ?? [])
    m.set(a.id, { name: named(a.label, a.id, 'shaded area'), role: a.role });
  for (const t of spec.plot?.tangents ?? []) m.set(t.id, { name: 'tangent', role: t.role });
  for (const r of spec.plot?.riemann ?? []) m.set(r.id, { name: 'rectangles', role: r.role });
  for (const s of spec.figure?.shapes ?? []) {
    const label =
      'label' in s && s.label !== undefined ? s.label : s.kind === 'label' ? s.text : undefined;
    const name = named(label, s.id, s.kind === 'box3d' ? 'box' : undefined);
    const role = 'role' in s ? s.role : undefined;
    m.set(s.id, role !== undefined ? { name, role } : { name });
  }
  return m;
}

/** A label's light TeX as HTML — x^2 raised, v_0 lowered, a lone letter in italic — as the figure sets it. */
export function labelHtml(text: string): string {
  return mvRuns(text)
    .map((r) => {
      const t = mvEsc(r.s);
      return r.sup ? `<sup>${t}</sup>` : r.sub ? `<sub>${t}</sub>` : r.it ? `<i>${t}</i>` : t;
    })
    .join('');
}

function vars(c: KitColours): string {
  return [
    `--mv-paper:${c.paper}`,
    `--mv-ink:${c.ink}`,
    `--mv-mute:${c.mute}`,
    `--mv-line:${c.line}`,
    `--mv-tint:${c.tint}`,
    `--mv-accent:${c.accent}`,
    `--mv-on-accent:${c.onAccent}`,
    `--mv-main:${c.series[0] ?? c.accent}`,
    `--mv-second:${c.series[1] ?? c.highlight}`,
    `--mv-third:${c.series[2] ?? c.ink}`,
    `--mv-reference:${c.mute}`,
    `--mv-highlight:${c.highlight}`,
  ].join(';');
}

function css(kit: Kit): string {
  const platform = currentPlatform();
  return `
:root{color-scheme:light dark;${vars(kit.light)};--mv-font:${kit.type.text[platform]};--mv-display-font:${kit.type.display[platform]};
--mv-grid:color-mix(in srgb,var(--mv-line) 62%,transparent);--mv-axis:color-mix(in srgb,var(--mv-ink) 72%,var(--mv-paper));
--mv-shade:color-mix(in srgb,var(--mv-line) 78%,var(--mv-paper))}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){${vars(kit.dark)}}}
:root[data-theme=dark]{${vars(kit.dark)}}
*{box-sizing:border-box}
html,body{margin:0;background:var(--mv-paper);color:var(--mv-ink)}
body{font:17px/1.55 var(--mv-font);-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
.mv{max-width:1200px;margin:0 auto;padding:44px 40px 64px}
.mv-head{max-width:70ch}
.mv-head h1{font:650 30px/1.15 var(--mv-display-font);letter-spacing:-0.015em;margin:0}
.mv-cap{margin:10px 0 0;color:var(--mv-mute);font-size:17px}
.mv-body{display:grid;grid-template-columns:minmax(0,1.6fr) minmax(300px,1fr);gap:48px;margin-top:32px;align-items:start}
.mv-body.is-single{grid-template-columns:minmax(0,860px)}
@media (max-width:900px){.mv{padding:28px 20px 48px}.mv-body{grid-template-columns:1fr;gap:28px}}
.mv-panel{margin:0 auto}
.mv-panel+.mv-panel{margin-top:24px}
.mv-svg{display:block;width:100%;height:auto}
.mv-controls{display:grid;gap:12px;margin-top:18px;padding-top:16px;border-top:1px solid var(--mv-line)}
.mv-slider{display:grid;grid-template-columns:minmax(2.2em,auto) 1fr 3.6em 32px;align-items:center;gap:14px}
.mv-slider .mv-name{color:var(--mv-ink);font-size:17px;white-space:nowrap}
.mv-slider input{width:100%;accent-color:var(--mv-accent);margin:0}
.mv-slider output{font-variant-numeric:tabular-nums;text-align:right;color:var(--mv-ink);font-size:16px}
.mv-play{width:32px;height:32px;border-radius:50%;border:1px solid var(--mv-line);background:transparent;color:var(--mv-ink);display:grid;place-items:center;cursor:pointer;padding:0}
.mv-play:hover{border-color:var(--mv-mute)}
.mv-play svg{width:12px;height:12px}
.mv-play .mv-pause,.mv-play.is-playing .mv-go{display:none}
.mv-play.is-playing .mv-pause{display:block}
.mv-play.is-playing{background:var(--mv-accent);border-color:var(--mv-accent);color:var(--mv-on-accent)}
.mv-steps ol{list-style:none;margin:0;padding:0;display:grid;gap:2px}
.mv-steps li{display:grid;grid-template-columns:26px 1fr;gap:14px;padding:12px 14px 12px 12px;border-left:2px solid transparent;color:var(--mv-mute);cursor:pointer}
.mv-steps li:hover{color:var(--mv-ink)}
.mv-steps li.is-on{border-left-color:var(--mv-accent);color:var(--mv-ink)}
.mv-num{width:26px;height:26px;border-radius:50%;border:1px solid var(--mv-line);display:grid;place-items:center;font-size:13px;font-weight:600;font-variant-numeric:tabular-nums;color:var(--mv-mute);margin-top:-1px}
.mv-steps li.is-on .mv-num{background:var(--mv-accent);border-color:var(--mv-accent);color:var(--mv-on-accent)}
.mv-text p{margin:0}
.mv-text p+p{margin-top:8px}
.mv-display{display:block;margin:8px 0}
.mv-nav{display:flex;align-items:center;gap:12px;margin:16px 0 0 14px}
.mv-nav button{font:inherit;font-size:15px;color:var(--mv-ink);background:transparent;border:1px solid var(--mv-line);border-radius:8px;padding:6px 14px;cursor:pointer}
.mv-nav button:hover{border-color:var(--mv-mute)}
.mv-nav span{color:var(--mv-mute);font-size:14px;font-variant-numeric:tabular-nums}
.mv-ref{border-bottom:1px dotted var(--mv-mute);white-space:nowrap;cursor:default}
.mv-swatch{width:14px;height:10px;margin-right:5px;vertical-align:0}
.katex{font-size:1.06em}
.mv-s-grid{stroke:var(--mv-grid)}.mv-s-axis{stroke:var(--mv-axis)}.mv-s-ink{stroke:var(--mv-ink)}.mv-s-mute{stroke:var(--mv-mute)}
.mv-s-main{stroke:var(--mv-main)}.mv-s-second{stroke:var(--mv-second)}.mv-s-third{stroke:var(--mv-third)}
.mv-s-reference{stroke:var(--mv-reference)}.mv-s-highlight{stroke:var(--mv-highlight)}.mv-s-none{stroke:none}
.mv-f-main{fill:var(--mv-main)}.mv-f-second{fill:var(--mv-second)}.mv-f-third{fill:var(--mv-third)}
.mv-f-reference{fill:var(--mv-reference)}.mv-f-highlight{fill:var(--mv-highlight)}.mv-f-tint{fill:var(--mv-tint)}
.mv-f-shade{fill:var(--mv-shade)}.mv-f-axis{fill:var(--mv-axis)}.mv-f-mute{fill:var(--mv-mute)}.mv-f-ink{fill:var(--mv-ink)}
.mv-nofill{fill:none}
.mv-svg line,.mv-svg path{stroke-linecap:round;stroke-linejoin:round}
.mv-dash{stroke-dasharray:7 6}
.mv-dot{stroke:var(--mv-paper);stroke-width:2}
.mv-t{font-family:var(--mv-font);fill:var(--mv-ink);paint-order:stroke;stroke:var(--mv-paper);stroke-width:4px;stroke-linejoin:round}
.mv-t-mute{fill:var(--mv-mute)}
.mv-dim{opacity:.38}
@media (prefers-reduced-motion:reduce){*{transition:none!important}}
`;
}

const PLAY_ICON =
  '<svg class="mv-go" viewBox="0 0 12 12" aria-hidden="true"><path d="M3 1.8v8.4L10 6z" fill="currentColor"/></svg><svg class="mv-pause" viewBox="0 0 12 12" aria-hidden="true"><path d="M3 2h2v8H3zM7 2h2v8H7z" fill="currentColor"/></svg>';

export interface PageInput {
  readonly spec: MathSpec;
  readonly compiled: Compiled;
  readonly start: Values;
  readonly kit: Kit;
}

/** The whole page: head, figure and sliders, steps, and the script that runs them. */
export function mathPage({ spec, compiled, start, kit }: PageInput): string {
  const E: Evaluators = compiled.E;
  const scene = mvScene(spec, E, start, spec.steps.length > 0 ? 1 : 0);
  // Every panel at one scale: a narrow figure takes its share of the column, centred.
  const panels = scene.panels
    .map(
      (p, i) =>
        `<figure class="mv-panel" data-mv-panel style="width:${Math.min(100, (p.w / 720) * 100).toFixed(2)}%">${mvSvg(p, i, spec.title)}</figure>`,
    )
    .join('');
  const parts = partsWithRoles(spec);
  const sliders = spec.params
    .map((p) => {
      const v = start[p.name] ?? p.value;
      return `<div class="mv-slider"><label class="mv-name" for="mv-${mvEsc(p.name)}">${paramLabel(p.label)}</label><input id="mv-${mvEsc(p.name)}" type="range" min="${p.min}" max="${p.max}" step="${p.step}" value="${v}" data-mv-param="${mvEsc(p.name)}"><output data-mv-value="${mvEsc(p.name)}">${mvEsc(String(Number(v.toPrecision(3))).replace('-', '−'))}</output><button type="button" class="mv-play" data-mv-play="${mvEsc(p.name)}" aria-pressed="false" aria-label="Play ${mvEsc(p.name)}">${PLAY_ICON}</button></div>`;
    })
    .join('');
  const steps = spec.steps
    .map(
      (s, i) =>
        `<li data-mv-step${i === 0 ? ' class="is-on" aria-current="step"' : ''}><span class="mv-num">${i + 1}</span><div class="mv-text">${s.text
          .split(/\n{2,}/)
          .map((para) => `<p>${inline(para.trim(), parts)}</p>`)
          .join('')}</div></li>`,
    )
    .join('');
  const stepsHtml =
    spec.steps.length > 0
      ? `<section class="mv-steps" aria-label="Explanation"><ol>${steps}</ol>${spec.steps.length > 1 ? `<nav class="mv-nav"><button type="button" data-mv-prev>Back</button><span data-mv-count>1 / ${spec.steps.length}</span><button type="button" data-mv-next>Next</button></nav>` : ''}</section>`
      : '';
  const data = JSON.stringify({ spec, start }).replace(/</g, '\\u003c');
  const script = `${runtimeSource()}\nvar MV_DATA = ${data};\nvar MV_E = ${evaluatorsScript(compiled)};\nmvMount(document, window, MV_DATA, MV_E);`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${mvEsc(spec.title)}</title>
<style>${inlineKatexCss()}</style>
<style>${css(kit)}</style>
</head><body><main class="mv">
<header class="mv-head"><h1>${inline(spec.title, new Map())}</h1>${spec.caption !== undefined ? `<p class="mv-cap">${inline(spec.caption, parts)}</p>` : ''}</header>
<div class="mv-body${stepsHtml === '' ? ' is-single' : ''}"><section class="mv-stage">${panels}${sliders !== '' ? `<div class="mv-controls">${sliders}</div>` : ''}</section>${stepsHtml}</div>
</main>
<script>${script.replace(/<\/script/gi, '<\\/script')}</script>
</body></html>
`;
}
