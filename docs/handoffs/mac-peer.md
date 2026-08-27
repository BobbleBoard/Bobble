# Handoff — a second Mac as a cluster peer

Paste this whole file into a Claude Code session on the other Mac, at the root
of the `OSS-harness` repo (pull `main` first).

---

You are making a second Mac a working peer in a Tailscale cluster for
**Bobble**, an offline local-AI Electron app.

**Read `docs/handoffs/README.md` first.** Shared context, the peer contract, the
known blockers, the house rules.

## Why this one matters more than it looks

This is the easy case — the app already runs on macOS — and that is exactly its
value: it isolates the **clustering** from the **porting**. If two Macs cannot
find each other, describe themselves honestly and hand work back and forth, then
nothing learned on Linux or Windows can be trusted either, because every failure
there will be ambiguous between "the port is wrong" and "the cluster is wrong".

So the bar here is not "it runs". It is: the seam is real, and it is general.
Resist anything that works only because both ends are Macs — a hard-coded
`metal`, an assumption that the peer has the same models, the same paths, the
same chip. The next peer is a Linux box that is already online on this tailnet.

## Start by finding out what is actually true

Report this in your first message back:

```bash
node -v && pnpm -v
sw_vers && uname -m
sysctl -n hw.memsize | awk '{print $1/1073741824" GB"}'
sysctl -n machdep.cpu.brand_string
/Applications/Tailscale.app/Contents/MacOS/Tailscale status --json | head -20
```

(That path is not a typo. The App Store build never puts its CLI on `PATH`, so
`which tailscale` fails on a machine where Tailscale is running fine —
`packages/cluster` searches a list of locations for exactly this reason.)

## The work

### 1. Confirm discovery already works

```bash
pnpm install
pnpm --filter @pi-desktop/cluster test
```

Then run discovery live and paste the output:

```bash
cd apps/desktop && node --import ./tests/e2e/ts-js-register.mjs --input-type=module -e "
import { readTailnet, describeHost, probePeer } from '../../packages/cluster/src/index.ts';
console.log(describeHost());
const net = await readTailnet();
for (const p of net.peers) console.log(p.hostname, p.os, p.ip, p.online);
"
```

On the first Mac this correctly lists all four tailnet machines with their real
online/offline state. If it does not here, that is the finding — report it
before doing anything else.

### 2. Answer the cluster hello

Implement `GET :8765/cluster/hello` per the README contract, served from the
Electron main process, filled from `describeHost()` plus the models this machine
can actually serve.

`describeHost()` already reports `metal` on Apple Silicon. Do **not** stop
there: put the accelerator probe somewhere `packages/cluster` shares, shaped so
a CUDA or ROCm answer slots in without restructuring. The Linux session is
writing that half; leave it a seam rather than a special case.

### 3. Make the two Macs prove it

With both running:

```bash
curl -s http://100.101.102.103:8765/cluster/hello | jq   # the other Mac
curl -s http://<this-machine>:8765/cluster/hello | jq
```

Each should describe the *other* machine correctly — different RAM, different
chip, different model list. If both answers look identical, something is
reporting itself instead of its peer, and that bug would be invisible between
two similar Macs and obvious later. Check it deliberately.

### 4. One honest scheduling decision

Do not build a scheduler. Build the smallest thing that proves the data is
usable: given the peer list, pick the machine that should run a given model and
explain why (RAM headroom, accelerator, already has the model). A pure function
with tests. It is the seam everything later hangs on, and it is cheap to get
right now and expensive to retrofit.

## What to report back

- The ground-truth block.
- The live discovery output.
- Both `hello` responses, side by side, showing they differ.
- Anything you could not verify, said plainly.
