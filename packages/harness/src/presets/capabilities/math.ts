/**
 * The `math` capability.
 *
 * One file per capability (the W0-A pre-wire, deliverables/research/PLAN.md
 * §2.3): the lane that owns a capability's wording edits this file and nothing
 * else. Every byte of `summary` is in the canonical prompt — a change here is a
 * prompt change (the snapshot test in ../../prompt, a prefill check).
 */
import type { Capability } from './types.js';

export const math: Capability = {
  name: 'math',
  /* The user (2026-09-25): "instead of it remaking these math things from scratch
     every time, let's give it a standard style and control". MEASURED the
     same night on a 4B: a physics figure went to `svg` with hand-written
     markup, an animation to video generation then a bar chart, a derivative
     to a hand-written SVG — so the line claims every one of those asks, and
     says where they are NOT to go. */
  summary:
    'Plot functions and equations with sliders, draw geometry and physics figures, and animate them — ' +
    'with the explanation as steps tied to the visual, on one interactive page. Every maths, physics or ' +
    'chemistry visual in an explanation goes here; never hand-written HTML or SVG, and never chart (that is data).',
  guidance:
    'math takes a spec — sliders, a plot (curves as expressions, points, areas, tangents) and/or a figure ' +
    '(points, vectors, polygons, circles, angles, dimensions, a 3D box, a spring), and 2–6 steps that each ' +
    "highlight the parts they talk about — and draws it in Bobble's own style, then checks it (labels on " +
    'labels, parts out of view, steps tied to nothing) and tells you what to fix. Write the spec to ' +
    'name.math.json, run `math name.math.json`, fix what it reports in the file, and run it again. ' +
    '`math --help` shows a whole spec.',
  tools: ['math'],
};
