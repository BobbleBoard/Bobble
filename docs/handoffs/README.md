# Handoff prompts — bringing Bobble to other machines

Paste one of these files into a Claude Code session **on the machine it names**.
Each is self-contained: it assumes the session knows nothing about this project
beyond what it can read in the repo.

| File | For |
|---|---|
| [`linux-peer.md`](./linux-peer.md) | A Linux box (the tailnet already has one: `linux-MS-7E59`) |
| [`windows-peer.md`](./windows-peer.md) | A Windows machine |
| [`mac-peer.md`](./mac-peer.md) | A second Mac — the easy case, and the one that proves the seam |

## The one thing every session must understand

**This is not about making the app work on one particular computer.** It is about
making it work on *whatever hardware someone has*, which happens to be tested on
that computer. Every one of these tasks has a tempting shortcut that hard-codes
something true of the machine in front of you — a path, a GPU vendor, a driver, a
CPU architecture, an assumption that a binary exists. Those shortcuts are exactly
the debt this project is currently paying off: nearly all of the OS-touching code
was written for macOS first and is now being ported at real cost.

So: if you find yourself writing `/usr/local/bin/…`, `cuda`, `x86_64`, or "on
this machine we know that…", stop and write the general version. A list of
candidates beats one path. A capability probe beats a vendor name. An honest
`unknown` beats a confident guess.

## What already exists (read this before starting)

`packages/cluster` — written on the Mac, deliberately platform-neutral from the
first line, and already verified against the real tailnet:

- `readTailnet()` — runs `tailscale status --json` and returns the peers. It
  searches a **list** of locations per platform, because "is Tailscale
  installed" has a different answer per OS and `PATH` is not a reliable witness
  on any of them. Measured: on macOS the App Store build hides its CLI inside
  `Tailscale.app` and never puts it on `PATH`, so `which tailscale` reports
  "not installed" on a machine where it is running perfectly.
- `describeHost()` — hostname, platform, arch, RAM, cores, accelerator. Uses
  Node's own `os` module, so it works everywhere without spawning anything.
- `probePeer()` — asks another machine what it can do, over the tailnet, with a
  short timeout. An unreachable peer is a normal answer, not an error.
- `CLUSTER_PORT` / `CLUSTER_HELLO_PATH` — the contract a peer answers on.

Its tests run against a **real captured `tailscale status --json`** from a live
tailnet (one Mac, one Linux box, two sleeping Macs), not a hand-written fixture.

## The three known blockers, from `ROADMAP-LATEST.md`

1. **Linux/Windows `llama.cpp` binary in the manifest.** The download manifest
   only carries macOS builds.
2. **`hardware.ts` returned RAM 0 off macOS.** *Fixed* — it now reads
   `os.totalmem()` / `os.cpus()` on non-Darwin. Everything that decides "will
   this model fit" reads that number, so 0 meant nothing fit and the app could
   not choose a model at all.
3. **No linux/win `electron-builder` target.**

Two seams are already indirected and will carry most of the clustering:
`ComfyClient.resolveOrigin()` and the inference `baseUrl`.

## The contract a peer must answer

`GET http://<tailnet-ip>:8765/cluster/hello` →

```json
{
  "version": "0.1.0",
  "ramGB": 64,
  "cpuCount": 16,
  "chip": "AMD Ryzen 9 7950X",
  "accelerator": "cuda",
  "models": ["qwen3.5-9b-mtp"]
}
```

`accelerator` is one of `metal` | `cuda` | `rocm` | `cpu` | `unknown`. Report
`unknown` rather than guessing `cpu` — "there is no GPU" and "we did not look"
lead to different scheduling decisions, and conflating them either wastes a
capable machine or sends heavy work to one that cannot do it.

## House rules for these sessions

- **Verify by running, not by reading.** This project has been bitten repeatedly
  by code that is correct in source and inert in fact. If you claim something
  works, have the output that shows it.
- **Tests that can fail.** Prove a new test fails without your change before you
  keep it.
- **Say what you did not do.** A precise "this part is unverified because X" is
  worth more than an optimistic summary.
- Run `pnpm check` (lint + typecheck + test + build) before committing.
