---
name: design-parity-review
description: Judge a UI against reference products and produce feedback so complete that acting on all of it leaves practically nothing more to give — an impact-ordered, categorised, unambiguous work order plus a separate feel-and-vibe section for everything real that cannot be pinned to a rule. Use whenever someone asks whether a screen is "on par with" or "as good as" a reference app, asks for a design critique or UI/UX review, says a surface looks amateur / generic / off, or when you are about to hand a builder a list of design fixes. Also use before claiming a design is at parity or better.
---

# Judging a UI against references

The point is not to find some problems. It is to find **all** of them, so that a
builder who fixes the list is done — the screen reads as something a prominent
company would be proud to ship, at parity with or better than the references.

That standard has one practical consequence: **every thought you have while
looking must have somewhere to go.** A reaction like "this modal feels amazing
but that page feels amateur" is real information. If the format has no room for
it, it is lost, and the next round rediscovers it as a vague complaint. So the
format below ends with a place for exactly those.

## 1. Imagine the ideal FIRST, before you look at anything

Do this before opening the references and before opening the product. Written
down, in the document, so it can be checked later.

What would 100% look like for a surface of this kind? Not "like the reference" —
the references may themselves be mediocre, and copying them caps you at their
level. Ask instead:

- What is this surface actually **for**? What does a person come here to find out
  or to do, and how fast should that be?
- What does the best version make **effortless** that most versions make fiddly?
- What would make someone screenshot it and send it to a friend?
- What are the states nobody designs — empty, one item, hundreds, failing,
  half-configured, offline — and what does the ideal do in each?
- What would an expert user need on day 200 that a new user does not need on day 1,
  and how does the surface serve both without becoming a control panel?

If you can find or make pictures of that ideal, do — a sketch, a mockup, a
reference from an unrelated product that nails one part of it. Images beat words.
**Words beat nothing**, so write it down either way.

Keep this section in the final document. When the review is over, the honest
question is not "did we match the references" but "how far are we from the thing
we described before we looked at anything".

## 2. Ingest the references properly

Look at **every** reference image or clip, one at a time, as images — not a
contact sheet, not a summary, not from memory. For video, use the
`video-reference-review` skill; frames at ~4fps, every frame, in order.

**If references were not provided but the surface obviously has well-known
exemplars, go and find them** — search the web for the two or three products
best known for this kind of screen, and say in the document which you used and
why. A review with no comparison class is an opinion.

For each reference, write down not what it contains but what makes it feel good:
the one decision that carries the screen, what it refuses to show, where it
spends its space, what it does at the moment of action. And be willing to write
"this reference is bad at X" — the owner has said some of these products make
poor choices, and copying their noise instead of their good ideas is the standard
failure mode of this work.

## 3. Play with the product, do not just look at it

Drive it. Click things, resize it, type into it, open the failing states, tab
through it, hover. Stills hide half of what is wrong: focus rings, transitions
that pop instead of fade, a control that moves the layout when it appears, a
hover that does nothing, a spinner nobody ever saw resolve.

Run headlessly — never take the user's screen (`headless-testing`). Capture what
you claim; every finding cites the frame or interaction it came from.

## 4. The output

One document. This shape:

### The ideal, before looking
From step 1, verbatim, unedited by what you later saw.

### The references
What each one does well, what it does badly, and the two or three ideas worth
taking.

### The work order
Ordered by **impact**, biggest first, and grouped into categories. Order within
each category too. Categories are whatever the surface actually needs — commonly
something like: *Information architecture · Layout and density · Typography ·
Colour and depth · Motion and state transitions · Copy · Interaction and input ·
Failure and edge states · Accessibility*.

Every item must be:
- **Fine-grained** — one change, not a theme. "Fix the typography" is not an item.
- **Unambiguous** — a builder who was not you can act on it without asking a
  question. Name the element, the current value, the wanted value, the frame it
  is visible in.
- **Justified** — what it costs the person using it, or which reference does it
  better and how.

A useful item reads like: *"The card's second line is 14px, the same as the name
above it (`shelf-plus-bobble-dark.png`), so the two read as one block; the
reference sets the note a step down. Take it to 13px/18px."*

### Feel and vibe
**After** all the categories, and deliberately separate.

This is for everything true that does not reduce to a rule. Screen by screen,
element by element where it matters: *this feels generic · this modal feels
genuinely special · this page reads as amateur · this list is beautiful and I do
not entirely know why · this transition makes the app feel slow even though it is
fast.*

Do not suppress a reaction because you cannot justify it — an unexplained real
reaction is more useful than a justified fake one. Where you *can* attach
something concrete, do; concrete advice is welcome here too. But the section
exists so that nothing gets dropped for want of a rule to hang it on.

### What is already better than the references
So the next round does not "fix" it.

### Not worth fixing
Differences from the references you judged cosmetic, said out loud, so nobody
re-raises them.

### What you could not judge
And exactly what would have to be captured to judge it.

## 5. The bar

Before you finish, ask: *if a builder fixed every item on this list, would the
screen be something a prominent company would be proud to ship?* If not, the list
is incomplete — go back and find what is missing. "I found twelve things" is not
the goal. "There is practically nothing left to say" is.
