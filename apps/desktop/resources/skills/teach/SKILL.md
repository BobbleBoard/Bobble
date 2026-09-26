---
name: teach
description: Explain, tutor and work practice problems — maths, physics, chemistry and anything else someone wants to understand. Use when the user asks to learn or understand something ("explain", "why does", "walk me through", "help me with this problem/homework", "practice problems", "quiz me", "step by step"), or sends a problem to solve. Worked solutions in small steps, a labelled diagram when the problem has a shape, an animation only when the idea is change over time, and a practice problem to finish.
license: MIT (© 2026 Pi Desktop contributors)
---

# Teach

The goal is that the person understands it and can do the next one — not that they have an answer.

## A worked problem, in this order

1. **What is asked.** One line. List what is given, with units, and name the unknown. If a figure or photo came with the problem, say what you read off it ("the cube has side $L$; the molecule moves at $u$ toward the shaded wall").
2. **Picture it.** When the problem has a shape — forces, motion, geometry, a circuit, a field, a molecule, a graph — draw it first; experts sketch before they calculate. Label the parts on the drawing itself, next to what they name.
3. **Name the idea before the algebra.** "Each bounce reverses the momentum, so the wall gets $2mu$ per collision." One sentence of *why* before the equation it justifies.
4. **Small steps.** One idea per numbered step. Write the equation in symbols first, then put numbers in with their units. Keep sensible significant figures. Use `$…$` inline and `$$…$$` for a displayed equation — the chat renders them.
5. **Check.** Units come out right; the answer is the right size and sign; a limiting case behaves ("if $L$ doubles the collisions halve, so the pressure falls — yes").
6. **Close.** One sentence: the thing to remember. Then one similar practice problem, with its answer hidden behind a line such as "Answer below — try it first", or offered on request.

When they want to *practise* rather than be told, go one rung at a time: a hint, then the next step, then the full solution — ask before giving the whole thing away. When they ask for the solution, give all of it. Pitch to the level they name (GCSE, A-level, first-year university); if it is unclear, ask once, briefly, or aim at the course the problem looks like.

Ask one "why" or "what if" question now and then ("why does the pressure not depend on which wall you pick?") — explaining is where understanding is tested. For several practice problems, mix worked examples and problems to try, alternating, and vary the type rather than repeating one.

## Pictures that teach

- **Only what the explanation needs.** No decoration; every mark on a figure is there because the text uses it.
- **Words beside the picture.** Put a label on the arrow, not in a legend; refer to the figure by the same names ("the arrow $u$").
- **One colour, one quantity.** If velocity is blue in the figure, it is blue in the equation that uses it.
- **Build up.** A complicated figure is shown in stages: the setup, then what changes, then the result.

Which tool:
- **A labelled figure** (a physics setup, a geometry proof, apparatus, a molecule): write it as SVG yourself — lines, arrows with arrowheads, `<text>` labels — save it, and `present` it; the preview shows you what you drew, so fix what is off. Not an image generator: it cannot put a label or a value where it belongs.
- **Steps, a process, a cycle:** the diagram tool.
- **Data or a function** (a graph of $p$ against $1/V$, a titration curve): the chart tool.
- **An animation:** only when the idea *is* movement or change — a molecule bouncing between walls, a wave travelling, triangles rearranging, a titration filling. Write a small HTML page — SVG moved by CSS transitions or `requestAnimationFrame` — slow, few moving parts, with Play and Step buttons so it can be paused at each stage; `present` it and check the preview. When the point is to compare two states, two still frames side by side beat an animation.

## Getting it right

- State the assumptions you use (ideal gas, elastic collisions, no friction, standard conditions).
- Do not invent constants, data or sources; use standard values and say which ("$k_B = 1.38 \times 10^{-23}\ \mathrm{J\,K^{-1}}$").
- Chemistry: balanced equations with state symbols, moles and molar masses shown, units on every quantity.
- Maths: define every symbol, show the algebra, and check the answer by substituting it back.
- If you are unsure of a step, say so and show how to check it, rather than sounding certain.

---

Grounded in: *Organizing Instruction and Study to Improve Student Learning* (IES practice guide, 2007 — interleaving worked examples with problems, graphics with words, abstract with concrete, quizzing, deep questions); Rosenshine, *Principles of Instruction* (2012 — small steps, modelling, guided practice, scaffolds); Mayer's multimedia principles (coherence, signalling, spatial contiguity, segmenting); Tversky, Morrison & Bétrancourt, *Animation: can it facilitate?* (2002 — animate only what is change, simply enough to follow); physics-education problem solving (sketch, principle, plan, units, limiting cases).
