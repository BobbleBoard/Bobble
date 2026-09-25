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

## Many worktrees, one Mac: locks

A dozen worktrees share this machine during the push (`deliverables/research/PLAN.md` §4). The
slots live in `_locks.mjs` — heavy 1, probe 3, build 2, test 6; probes and builds drop to one while
a heavy job runs, and while one waits for them to drain:

```bash
node ../../scripts/with-lock.mjs build -- npm run build          # from apps/desktop
node ../../scripts/with-lock.mjs probe -- node tests/e2e/x.mjs
node tests/e2e/_locks.mjs status                                   # who holds what, and why heavy may not start
node tests/e2e/_locks.mjs orphans [--kill]                         # orphaned model servers
../../scripts/bench-run.sh --name <id> -- <heavy command>          # BENCH only; see deliverables/bench/queue.md
```

`launchApp` takes a probe slot itself for as long as the app is up (one per process; skipped when a
wrapper above already holds one; `PD_PROBE_LOCK=0` opts out). The default screenshot directory and
stable probe homes carry the worktree's tag (`PD_WORKTREE_TAG`, or the `.claude/worktrees/<name>`
the checkout lives in). `scripts/worktree-new.sh <lane>` makes a lane's worktree: add, plain
`pnpm install`, build under the lock.

## Test doubles

Model-free, network-free stand-ins for the things the app talks to. Each serves the real protocol
from loopback, logs every request, and has a smoke probe that runs the app's REAL client code
against it:

| Double | Stands in for | Smoke probe |
|---|---|---|
| `_mock-openai.mjs` | llama-server / any OpenAI-compatible model: SSE content, `reasoning_content`, tool calls, `/completion` (+`n_probs`), `/props`, `/slots`, `/health`, `/v1/models`, cancel-on-disconnect, latency, a prompt cache that reports `cache_n`/`prompt_n` | `mock-openai-smoke-probe.mjs` — the real pi in the hidden app, one scripted `bash` call |
| `_mock-web.mjs` | DuckDuckGo html/lite, the anomaly page, articles, a PDF, redirects, dead links; `web.fetch` never leaves loopback | `mock-web-smoke-probe.mjs` — web-tools' real `runWebSearch` and `fetchReadable` |
| `_fake-tailscale.mjs` + `fixtures/tailscale/` | the `tailscale` CLI: `status`, `ip`, `ping`, `whois`, `version` in Running (8 kinds of peer), NeedsLogin, NeedsMachineAuth, Stopped, not installed | `fake-tailscale-smoke-probe.mjs` — `readTailnet()`, also from an empty (Finder-like) environment |
| `fixtures/fake-hindsight.mjs` | the Hindsight memory service: retain (async, idempotent), list, recall, curate, documents, stats, tenant key | `fake-hindsight-smoke-probe.mjs` — also through the real `@vectorize-io/hindsight-client` when `HINDSIGHT_CLIENT_DIR` points at one |

Two more smoke probes cover the machinery itself: `locks-smoke-probe.mjs` (two competing scripts
serialize; a SIGKILLed owner is taken over) and `bench-run-smoke-probe.mjs` (exit codes, the memory
watchdog, interrupts — harmless commands in a private lock root). `_ts-source.mjs` lets a probe
import workspace TypeScript source whose relative imports end in `.js`.

`mock-openai-fidelity.mjs` holds the model double to the REAL server's wire format: the same
requests to a running llama-server (`REAL_BASE_URL`) and to the mock, compared key path by key
path; it fails only on fields the app's provider reads. It never starts a server itself — it is a
BENCH row (`MOCK-FID` in `deliverables/bench/queue.md`).

Pointing the real pi at the model double (what `mock-openai-smoke-probe.mjs` does):

```js
const mock = await startMockOpenAI({ model: 'mock-4b', rules: [/* … */] });
const home = probeHome('my-probe');
writeModelsJson(home, { provider: 'mock', baseUrl: mock.baseUrl, model: 'mock-4b' });
const { page } = await launchApp('my-probe', {
  env: { HOME: home, PI_BIN: undefined, PI_E2E_NO_SERVER: '1' },
});
await page.evaluate(() => window.piDesktop.invoke('pi:start', {}));
await page.evaluate(() => window.piDesktop.invoke('pi:set-model', { provider: 'mock', modelId: 'mock-4b' }));
// …then type into [data-testid="composer-input"] and press Enter, like a person.
```
