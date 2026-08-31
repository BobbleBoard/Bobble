# Probes

End-to-end probes drive the **real** app: a real Electron process, the real
renderer, the real IPC. They are how a UI claim gets earned rather than
asserted.

## They do not take your screen

Any run with `PI_E2E=1` — which every probe sets — is **invisible**:

- the window is created and **never shown**;
- the app uses the `accessory` activation policy, so it is not in the dock or
  the ⌘-Tab switcher;
- OS notifications are suppressed;
- the computer-use overlay (always-on-top, rides every space) is never shown;
- second-instance activation and the popout's focus grab are skipped.

A hidden window is **not** a degraded window. It runs its renderer, lays out at
its real size, animates at full rate, and screenshots correctly. `snap.mjs`'s
output and every screenshot in this directory were taken from a window nobody
could see.

`headless-probe.mjs` asserts all of that, so it goes red before a window appears
over someone's work. And `harness.mjs` records the frontmost application at
launch and **fails the probe** if it ever changed — the difference between
believing the suite is unobtrusive and knowing it.

```bash
node tests/e2e/palette-probe.mjs      # invisible, no flags needed
PI_E2E_VISIBLE=1 node tests/e2e/palette-probe.mjs   # watch it happen
pnpm e2e                              # the whole chain, invisible
pnpm e2e:visible                      # the whole chain, watchable
```

## Looking at the app without writing a probe

`snap.mjs` launches invisibly, optionally does a few things, and writes a PNG:

```bash
node tests/e2e/snap.mjs --key Meta+k --wait 500 --out /tmp/palette.png
node tests/e2e/snap.mjs --type "hello" --key Enter --wait 3000
node tests/e2e/snap.mjs --click '[data-testid=nav-connectors]' --shot connectors
node tests/e2e/snap.mjs --eval "document.querySelectorAll('[role=tab]').length"
```

## Writing one

Use `harness.mjs` — it gives you the invisible launch, the focus guard, a
`shot()` that fails on a blank frame, and a `check()` that sets the exit code:

```js
import { launchApp } from './harness.mjs';

const { page, shot, check, finish } = await launchApp('my-probe');
await page.click('[data-testid="thing"]');
check((await page.$('[data-testid="result"]')) !== null, 'the thing did nothing');
await shot('after-click');
await finish();
```

Older probes hand-roll their own `electron.launch`. They are still invisible —
that comes from the app side, not the probe — but they do not get the focus
guard or `shot()`. Move one over when you touch it.

## Tuning the prompt enhancer

`tests/enhance/enhance-probe.mjs` is not an e2e probe — it drives ONLY the
prompt rewrite, against a real llama-server, with generation switched off:

```bash
llama-server -m <a small gguf> --port 8899 -c 8192 -ngl 99 --jinja
node tests/enhance/enhance-probe.mjs --base http://127.0.0.1:8899/v1
```

It grades each rewrite on what a bad one actually does — drops the user's
subject, comes back shorter than it went in, answers as chat, breaks the target
model's house style, runs over the word cap — and prints a pass count and the
average latency. `--case <n>` runs one case, `--json` prints the table for
diffing two versions of the system prompt.

Doing it this way is the point: a diffusion run would dominate the wall clock
and tell you almost nothing, because you cannot separate "the prompt got better"
from "the seed was kind".
