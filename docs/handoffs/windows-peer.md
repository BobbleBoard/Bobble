# Handoff — Bobble on Windows

Paste this whole file into a Claude Code session on the Windows machine, at the
root of the `OSS-harness` repo (pull `main` first).

---

You are bringing **Bobble** — an offline local-AI Electron app, currently
macOS-only in practice — up on Windows, and making it a working peer in a
Tailscale cluster.

**Read `docs/handoffs/README.md` first.** Shared context, the peer contract, the
known blockers, the house rules. Everything below assumes it.

## The point, and the trap

Not "make it work on my PC" — make it work on *Windows and whatever hardware is
there*. NVIDIA, AMD, Intel Arc, or nothing but a CPU. Every task below has a
shortcut that bakes in what happens to be true on this machine. Those shortcuts
are the debt the macOS-first code is being unwound from right now; do not open a
second front of it.

Windows adds its own version of the same trap: paths with spaces, backslashes,
no POSIX shell, and a different notion of an executable. Write it so a Mac or a
Linux box reading the same code is unaffected.

## Start by finding out what is actually true

Report this in your first message back:

```powershell
node -v; pnpm -v
[Environment]::OSVersion.VersionString
(Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1GB
(Get-CimInstance Win32_Processor).Name
(Get-CimInstance Win32_VideoController).Name
tailscale status --json | Select-Object -First 20
```

## The work

### 1. Build and start

```powershell
pnpm install
pnpm check
pnpm --filter @pi-desktop/desktop build
```

Expect: POSIX assumptions in scripts, `/`-joined paths, shelling out to `sh`,
macOS-only modules imported at load time. Fix the mechanical ones with
`path.join` / `os.platform()` rather than a Windows branch where a general fix
exists. Genuine macOS reimplementations (`pi-mac`, Mac connectors, mac
computer-use) get **gated**, not ported: report unavailable, keep the app
running, and note each one.

Watch specifically for anything spawning a shell. The bash-CLI tool interface
(`Settings → Harness → Tool interface`) writes POSIX `#!/bin/sh` shims — on
Windows that mode should either produce `.cmd` shims or declare itself
unavailable. Declaring it unavailable is a perfectly good first answer; a
half-working one is not.

### 2. `llama.cpp` for Windows

`packages/inference` downloads from a manifest carrying macOS assets only. Add
Windows, and keep the *selection* general: arch, plus whichever acceleration
exists (CUDA / Vulkan / CPU). The plain CPU build must always be a valid
fallback — a machine with no usable GPU should still run, slowly and correctly.
Do not hard-code a CUDA version.

Verify by loading a model and getting tokens out.

### 3. Answer the cluster hello

Implement `GET :8765/cluster/hello` per the README contract, from the Electron
main process, bound so the tailnet can reach it — check Windows Firewall, and
say so in your report if you had to add a rule, because the next person will hit
it too.

Fill it from `describeHost()` in `packages/cluster`. That function reports
`accelerator: 'unknown'` off macOS today, deliberately. Part of this job is
making it honest on Windows — probe for NVIDIA/AMD/Intel and report `cuda` /
`rocm` / `cpu`, still returning `unknown` when the probe itself fails. Put the
probe in `packages/cluster` so every platform shares one implementation.

### 4. Prove the machines see each other

The Mac (`100.101.102.103`) already discovers peers and probes them; it currently
gets `fetch failed` because nothing answers. When step 3 works, from either
machine:

```
curl http://<this-machine-tailnet-ip>:8765/cluster/hello
```

That plus the Mac's cluster view showing this machine with real RAM, cores and
accelerator is what "done" means.

### 5. Package it

Add a Windows `electron-builder` target (NSIS is fine). Unsigned is acceptable;
note the SmartScreen behaviour so nobody is surprised.

## What to report back

- The ground-truth block (what this machine actually is).
- What broke, and whether each fix was general or a Windows branch — and if a
  branch, why a general fix was not possible.
- Every macOS-only feature you gated.
- Whether bash-CLI mode is implemented, gated, or broken here.
- Anything you could not verify, said plainly.
