# Handoff — Bobble on Linux

Paste this whole file into a Claude Code session on the Linux machine, at the
root of the `OSS-harness` repo (pull `main` first).

---

You are bringing **Bobble** — an offline local-AI Electron app, currently
macOS-only in practice — up on Linux, and making it a working peer in a
Tailscale cluster.

**Read `docs/handoffs/README.md` first.** It has the shared context: what
`packages/cluster` already does, the peer contract, the known blockers, and the
house rules. Everything below assumes it.

## The point, and the trap

You are not "porting to my Linux box". You are making the app run on *Linux and
whatever hardware it has*. The machine you are on is one sample: it may have an
NVIDIA card, or AMD, or neither. It may be x86_64 or aarch64. Someone else's
will differ.

Every task below has a shortcut that hard-codes what is true here — a CUDA
assumption, an `/usr/bin` path, a glibc detail, an x86 binary. Those shortcuts
are precisely the debt the macOS-first code is being unwound from right now.
Write the general version: probe rather than assume, list candidates rather than
pick one, and report `unknown` rather than guessing.

## Start by finding out what is actually true

Before changing anything, establish the ground truth on this machine and write
it down in your first message back:

```bash
node -v && pnpm -v
uname -srm
free -g | head -2
lscpu | grep -E "Model name|Architecture|CPU\(s\)"
# GPU, whichever exists — none of these are guaranteed
nvidia-smi 2>/dev/null | head -12 || echo "no nvidia-smi"
rocminfo 2>/dev/null | head -12 || echo "no rocminfo"
ls /dev/dri 2>/dev/null || echo "no /dev/dri"
tailscale status --json | head -20
```

## The work

### 1. Make the app build and start at all

```bash
pnpm install
pnpm check          # lint + typecheck + test + build, everywhere
pnpm --filter @pi-desktop/desktop build
```

Expect breakage that is *mechanical* rather than deep: missing native deps,
macOS-only imports reached at module load, an `electron-builder` config with no
Linux target. Fix the mechanical ones. When you hit something that is genuinely
a macOS reimplementation (`pi-mac`, the Mac connectors, mac computer-use), do
**not** port it — make it degrade cleanly: the feature reports itself
unavailable on this platform and the app runs without it. Note each one you
gate.

### 2. `llama.cpp` for Linux

`packages/inference` downloads a llama.cpp build from a manifest that currently
carries macOS assets only. Add Linux, and make the *selection* general:

- The asset depends on **arch** (`x86_64` / `aarch64`) and on what acceleration
  is present (CUDA build, ROCm build, or a plain CPU build).
- The CPU build must always be a valid fallback. A machine with no GPU should
  still run — slowly, correctly.
- Do not hard-code a CUDA version. Detect, and fall back.

Verify by actually loading a model and getting tokens out, not by asserting the
download URL is well-formed.

### 3. Answer the cluster hello

Implement the endpoint from the README's contract — `GET :8765/cluster/hello` —
served by the Electron main process, bound to the tailnet interface. Fill it
from `describeHost()` in `packages/cluster`, plus the models this machine can
actually serve.

`describeHost()` returns `accelerator: 'unknown'` off macOS today, on purpose.
**Your job includes making that honest on Linux**: probe for NVIDIA/ROCm and
report `cuda` / `rocm` / `cpu`, still returning `unknown` when the probe itself
fails. Put the probe in `packages/cluster` so every platform shares it, not in a
Linux-specific corner.

### 4. Prove the two machines see each other

The Mac (`My MacBook Pro`, `100.101.102.103`) already runs discovery and
already lists this box as an online peer — it currently gets `fetch failed` from
the probe because nothing answers yet. When step 3 works:

```bash
curl -s http://100.101.102.110:8765/cluster/hello | jq   # from either machine
```

That, and the Mac's cluster view showing this machine with real RAM/cores/
accelerator, is what "done" means for this handoff.

### 5. Package it

Add a Linux `electron-builder` target (AppImage and/or deb). It does not need to
be signed or polished; it needs to produce something installable so the next
person is not building from source.

## What to report back

- The ground-truth block from the top (what this machine actually is).
- What broke, and whether the fix was general or a gate.
- Every place you gated a macOS-only feature, so the list is known rather than
  discovered later.
- Anything you could not verify, said plainly.
