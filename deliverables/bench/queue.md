# BENCH queue — the heavy-job ledger

The one list of every heavy job in the push: anything that starts a model server, runs a GPU
generation or a training run, converts a model, or downloads more than 200 MB
(`deliverables/research/PLAN.md` §4.3–§4.5, rule R13). Lanes never run these themselves. They add a
row here; BENCH runs it, one at a time, through `scripts/bench-run.sh`, and fills in the result.

**Gate.** Every row is a heavy job and needs the user's go on Q1 ("May BENCH run heavy jobs on this
Mac?", PLAN.md §5). When this ledger was written (2026-09-23), BENCH-1 was already running on the
heavy slot from another lane, so BENCH is live; rows that also wait on another answer (Q2, Q3, Q4,
an approval) say so in **State**. BENCH keeps the State column current.

## How a job runs

```bash
scripts/bench-run.sh --name <row-id> [--floor 30] -- <the command the authoring lane wrote>
```

`bench-run.sh` does all of the following, so a job's own script does none of it:

1. sweeps orphaned model servers (`ppid 1` under any `.cache/bobble` root) before and after;
2. takes the **heavy** lock (`scripts/with-lock.mjs` → `apps/desktop/tests/e2e/_locks.mjs`), which
   waits for AC power, for the user's own Bobble to have no model loaded and no generation running, for
   no orphan, and for at most one probe and one build to be running — and while it holds the lock,
   every lane's probes and builds drop to one slot;
3. waits for free memory to be at least the floor + 10 points before starting;
4. runs the job in its own process group under `caffeinate -i -w`;
5. traces `kern.memorystatus_level` and the job's resident size every 2 s (`memory.csv`);
6. **stops the whole job at the floor** (30% free by default; TR-0 asks for 25%) and exits 137;
7. writes `meta.txt`, `output.log`, `memory.csv` and `summary.json` to
   `deliverables/bench/runs/<stamp>-<name>/` (git-ignored) and appends a line to
   `deliverables/bench/runs/index.tsv`.

Copy the headline numbers (`seconds`, `minFreePct`, `peakRssMB`, `exitCode`, `watchdogKilled`) into
the row's **Result** cell below, with the run directory's name.

Before starting a batch: the Mac is on AC, the user's Bobble is idle (quit is best, never killed), at
least **40 GB** of disk is free (PLAN.md §4.6), and `node apps/desktop/tests/e2e/_locks.mjs status`
shows who else is holding slots. Overnight windows are preferred for the long rows.

Downloads land in the real library (`~/Bobble/Models`) only through a BENCH run with `REAL_LIBRARY`,
never from a lane's probe home.

## States

`queued` (waiting on nothing but BENCH time) · `blocked: <gate>` · `ready` (command written, inputs
on disk) · `running` · `done` · `failed: <why>` · `stopped by watchdog`

## The queue (PLAN.md §4.4, in unblocking order)

| # | Row id | Job | Wave | Authored by | Downloads (source, size) | Peak (est.) | Est. time | Parks chat | Command | State | Result |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | BENCH-1 | Engine capabilities: json_schema per engine (llama.cpp b10603, rapid-mlx, mlx-lm), cancel-on-disconnect, `/completion` + `multimodal_data` + `n_probs`, image re-encode cost at 512/672/1024 px, 6k-chunk extraction latency, child-pi and help-pi spawn time and RSS | W1 | WF | none (the 4B already on disk) | ~7 GB | 1–2 h | — | `apps/desktop/tests/spikes/engine-caps-*.mjs` (WF writes) | running (on the heavy slot from 18:36) | |
| 2 | WP-M0 | Hindsight spike: RSS, recall p50/p95, retain seconds, fabricated-fact rate, cache-ram pressure | W1 | MEM | Hindsight wheels, PyPI, 0.45 GB | chat + ~1 GB | 2–3 h | no | `scratchpad/memory-spike/*` (MEM writes) | queued | |
| 3 | TR-0 | Training decision bench: {0.8B, 4B} × seq {512, 1024, 2048} × {stock, perf, unsloth} — peak GB, tok/s, loss after 5 steps (`--floor 25`) | W1 | TRAIN | Qwen3.5-0.8B 1.75 GB + 4B bf16 9.32 GB, Hugging Face (~11 GB) | ≤ ~11.5 GB | 2–3 h | yes | `apps/desktop/tests/train/train-bench.mjs` (TRAIN writes) | blocked: Q2 | |
| 4 | SPK-01 | Edit engines on 24 GB: klein edit, Mage-Flow-Edit, SeedVR2-3B, the ONNX tools — seconds, `residentFloorGB`, `peakResidentGB`; outputs looked at | W1 | EDIT | SeedVR2-3B, SAM 2.1 small, BiRefNet lite, LaMa, DFN3, Hugging Face (~2–4 GB est.) | 14.76 GB | ~3 h | yes | `scratchpad/measure/*.sh` (EDIT writes) | queued (FLUX Fill: Q3) | |
| 5 | MING-S0 | Ming 4-bit scratch run: OS free-memory drop per phase, s/step at 1024², 12 steps; one transparent run | W1 | MING | Ming 4-bit weights 13.4 GB + env ~2 GB, Hugging Face / PyPI | ~10–11 GB | 1–2 h | yes | `scratchpad/ming-spike/*` (MING writes) | queued | |
| 6 | MING-0 | mlx-vlm env warm + import check | W1 | MING | (same env as #5) | light | 15 min | — | (MING writes) | queued | |
| 7 | LR-08 | Template parity: renderer vs llama-server `/apply-template` on 200 captured bodies | W1–W2 | LORA | none | ~5 GB | 20 min | — | (LORA writes) | queued | |
| 8 | WP-M3b | Real memory-service probe | W2 | MEM | (M0 env) | light | 30 min | — | `memory-service-probe.mjs` | queued (after #2) | |
| 9 | MING-4 | Ming through the app | W2 | MING | none | ~11 GB | 1–2 h | yes | (MING writes) | queued | |
| 10 | BH-6 | Help pi spawn / RSS | W2 | HELP | none | light + 4B | 20 min | — | (HELP writes) | queued | |
| 11 | LR-09 | Stock-4B baseline scorecard | W2 | LORA | none | 4B + probes | overnight | — | (LORA writes) | queued | |
| 12 | TTFT-1 | TTFT/prefill batch #1 (every W1–W2 prompt/tool-surface change, R8) | end of W2 | INT | none | 4B | 30–60 min | — | `ttft-probe.mjs`, `ttft-slots-probe.mjs` | queued | |
| 13 | MING-5 | Ming recipe benchmark (bf16 fetch only with the user's approval and ≥100 GB free) | W3 | MING | +25 GB 8-bit; +53 GB bf16 only if approved | ~11–18 GB | 4–6 h | yes | (MING writes) | queued (bf16: the user's approval) | |
| 14 | WP-M-LR | Memory learn/recall + gate TTFT | W3 | MEM | none | 4B + 1 GB | ~2 h | — | (MEM writes) | queued | |
| 15 | IMG-RO | IMG-04/05/06 real ops | W3 | EDIT | none | ≤ 14.8 GB | ~2 h | yes | (EDIT writes) | queued | |
| 16 | WF-07R | Real research, 3 fixed questions | W3 | WF | none | 4B | 1–2 h | — | `workflows-research-real-probe.mjs` | queued | |
| 17 | VQ-LIVE | VQ-06/08 live 4B runs | W3 | VQ | none | 4B | ~1 h | — | (VQ writes) | queued | |
| 18 | TTFT-2 | TTFT/prefill batch #2 + CLI vocabulary freeze | end of W3 | INT | none | 4B | ~1 h | — | as #12 | queued | |
| 19 | EVALS | WP-M10 · BH-11 · WF-14 evals | W4 | MEM/HELP/WF | none | 4B/9B | 8–11 h total | — | (lanes write) | queued | |
| 20 | TR-13 | Real training acceptance: 0.8B run → Q8_0 → chat | W4 | TRAIN | export module ~0.5 GB | ~3 GB + convert | ~1 h | — | (TRAIN writes) | blocked: Q2 | |
| 21 | DEV-9 | Two Bobbles on one Mac (`PI_CLUSTER_BIND=127.0.0.1`) | W4 | DEV | none | ~5 GB | 30 min | — | (DEV writes) | queued | |
| 22 | LR-16 | Release gates on the Mac | W4–W5 | LORA | candidate ~5 GB | 4B | overnight | — | (LORA writes) | blocked: Q2, Q4 | |
| 23 | GEN-REAL | AUD/VID/MING-8/MING-13 real runs | W4–W5 | EDIT-av/MING | per job | ≤ ~15 GB | per job | yes | (lanes write) | queued | |

**Core downloads:** about 31 GB (0.45 + 11 + ~3 + ~15.4 + ~1.2 for the training and export
modules). Optional, and only with the user's approval: the Ming 8-bit weights (25 GB) and the bf16
release (53 GB).

### Rows added since the plan

| Row id | Job | Wave | Authored by | Downloads | Peak (est.) | Est. time | Parks chat | Command | State | Result |
|---|---|---|---|---|---|---|---|---|---|---|
| MOCK-FID | Fidelity of the model double: the same requests to a real llama-server b10603 and to `_mock-openai.mjs`, compared path by path (fails only on fields the app's provider reads); cancel-to-idle timed on both. Best run beside BENCH-1, which already has this server and model warm | W1 | INT (W0-B) | none (the 4B Q8_0 already on disk) | ~5–7 GB | ~5 min | — | `scripts/bench-run.sh --name mock-fid -- sh -c 'S="$HOME/.cache/bobble/llamacpp/b10603/llama-b10603/llama-server"; M="$HOME/Bobble/Models/LLM/qwen3.5-4b-mtp/Qwen3.5-4B-Q8_0.gguf"; "$S" -m "$M" --host 127.0.0.1 --port 18089 -c 8192 -ngl 99 --reasoning-format deepseek --no-webui & SRV=$!; trap "kill $SRV" EXIT; until curl -sf http://127.0.0.1:18089/health > /dev/null; do sleep 1; done; REAL_BASE_URL=http://127.0.0.1:18089 node apps/desktop/tests/e2e/mock-openai-fidelity.mjs'` | queued | |

## Never at the same time (PLAN.md §4.5)

- Any two heavy jobs (the heavy lock has one slot).
- A heavy job while the user's own Bobble has a model loaded (the lock waits).
- A heavy job and more than one probe (the lock waits for ≤ 1, then caps probes at 1).
- Any two of: image/video/3D generation, a Ming run, a training run, a second chat model, a ≥ 4B
  export conversion.
- `npm run build` in a worktree while that worktree's probes run.

## Adding a row

A lane that needs a heavy run appends a row with: a row id (its package id), the job in one line, the
wave, the downloads with their **source and size**, the expected peak and time, whether the chat
model must be parked, and the exact command (it must run under `scripts/bench-run.sh` with no other
setup). It also lists the row under `bench_requests` in its report. BENCH keeps the table in
unblocking order.
