#!/usr/bin/env bash
# bench-run.sh — run ONE heavy job the way this 24 GB Mac can survive it.
#
# A heavy job is anything that loads a model, generates on the GPU, trains,
# converts, or downloads more than 200 MB (deliverables/research/PLAN.md §4.3).
# Only BENCH runs them, one at a time, and always through this script:
#
#   scripts/bench-run.sh --name bench-1 -- node apps/desktop/tests/spikes/engine-caps.mjs
#
# What it does, in order:
#   1. Sweeps ORPHANED model servers (ppid 1, from the app's own cache roots):
#      each one holds a whole model and fakes "Compute error"/OOM in whatever
#      runs next (memory pi-desktop-orphan-servers).
#   2. Takes the HEAVY lock (scripts/with-lock.mjs → tests/e2e/_locks.mjs):
#      waits for AC power, for the user's own Bobble to be idle, for no orphan, and
#      for at most one probe and one build to be running. While it holds the
#      lock, every lane's probes and builds drop to one slot.
#   3. Waits for free memory to be comfortably above the floor, then starts the
#      job in its own process group, under `caffeinate -i -w <pid>` so the Mac
#      does not idle-sleep halfway through an overnight run.
#   4. Traces `kern.memorystatus_level` (the % of memory macOS considers free)
#      and the job's resident size every --interval seconds into memory.csv.
#   5. WATCHDOG: if free memory falls below --floor (30% by default), the whole
#      job — its process group and every descendant — is stopped (TERM, then
#      KILL). A frozen Mac costs the user their machine; a killed job costs a rerun.
#   6. Sweeps orphans again, writes summary.json, appends a line to the run
#      index, and exits with the job's own exit code (or 137 when the watchdog
#      stopped it, 75 when the lock or the memory wait timed out).
#
# Options:
#   --name NAME        run name (default: the command's first word)
#   --floor PCT        watchdog floor, % free (default 30; TR-0 uses 25)
#   --interval SEC     trace/watchdog period (default 2)
#   --log-dir DIR      where this run's files go (default deliverables/bench/runs/<stamp>-<name>)
#   --start-wait MIN   how long to wait for free memory before starting (default 30)
#   --no-sweep         skip the orphan sweeps (never for a real BENCH run)
#
# Test seams: BENCH_MEMLEVEL_CMD replaces the free-memory reading (a command
# printing a number); BOBBLE_LOCK_DIR moves the lock root (tests use a private one).
set -euo pipefail

SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
REPO_ROOT="$(cd "$(dirname "$SCRIPT")/.." && pwd)"
LOCKS="$REPO_ROOT/apps/desktop/tests/e2e/_locks.mjs"
WITH_LOCK="$REPO_ROOT/scripts/with-lock.mjs"

NAME=""
FLOOR=30
INTERVAL=2
LOG_DIR=""
START_WAIT_MIN=30
SWEEP=1
INNER=0
ARGS=("$@")

usage() {
  sed -n '2,40p' "$SCRIPT" | sed 's/^# \{0,1\}//'
  exit 64
}

while [ $# -gt 0 ]; do
  case "$1" in
    --inner) INNER=1; shift ;;
    --name) NAME="$2"; shift 2 ;;
    --floor) FLOOR="$2"; shift 2 ;;
    --interval) INTERVAL="$2"; shift 2 ;;
    --log-dir) LOG_DIR="$2"; shift 2 ;;
    --start-wait) START_WAIT_MIN="$2"; shift 2 ;;
    --no-sweep) SWEEP=0; shift ;;
    -h|--help) usage ;;
    --) shift; break ;;
    *) echo "bench-run: unknown option $1 (the command goes after --)" >&2; exit 64 ;;
  esac
done
[ $# -gt 0 ] || usage
CMD=("$@")
[ -n "$NAME" ] || NAME="$(basename "${CMD[0]}")"
NAME="$(printf '%s' "$NAME" | tr -c 'A-Za-z0-9._-' '-')"

say() { printf 'bench-run: %s\n' "$*" >&2; }

# % of memory free, as macOS's memorystatus sees it (or /proc/meminfo elsewhere).
memlevel() {
  if [ -n "${BENCH_MEMLEVEL_CMD:-}" ]; then
    sh -c "$BENCH_MEMLEVEL_CMD"
  elif [ "$(uname)" = "Darwin" ]; then
    sysctl -n kern.memorystatus_level
  else
    awk '/^MemTotal:/ {t=$2} /^MemAvailable:/ {a=$2} END {printf "%d\n", a*100/t}' /proc/meminfo
  fi
}

sweep() {
  [ "$SWEEP" = 1 ] || return 0
  node "$LOCKS" orphans --kill >&2 || true
}

# ── outer: sweep, then run ourselves again under the heavy lock ──────────────
if [ "$INNER" = 0 ]; then
  sweep
  say "waiting for the heavy lock (AC power, the user's Bobble idle, no orphans, ≤1 probe and build)…"
  exec node "$WITH_LOCK" heavy -- bash "$SCRIPT" --inner "${ARGS[@]}"
fi

# ── inner: we hold the heavy lock ────────────────────────────────────────────
STAMP="$(date +%Y%m%d-%H%M%S)"
[ -n "$LOG_DIR" ] || LOG_DIR="$REPO_ROOT/deliverables/bench/runs/$STAMP-$NAME"
mkdir -p "$LOG_DIR"
TRACE="$LOG_DIR/memory.csv"
OUTPUT="$LOG_DIR/output.log"
REV="$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)"

START_FLOOR=$((FLOOR + 10))
deadline=$(( $(date +%s) + START_WAIT_MIN * 60 ))
level="$(memlevel)"
while [ "$level" -lt "$START_FLOOR" ]; do
  if [ "$(date +%s)" -ge "$deadline" ]; then
    say "free memory stayed at ${level}% (< ${START_FLOOR}%) for ${START_WAIT_MIN} min — not starting"
    exit 75
  fi
  say "free memory ${level}% — waiting for ${START_FLOOR}% before starting"
  sleep 10
  level="$(memlevel)"
done
START_LEVEL="$level"

{
  echo "name: $NAME"
  echo "command: ${CMD[*]}"
  echo "cwd: $(pwd)"
  echo "rev: $REV"
  echo "started: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "floor: $FLOOR%"
  echo "free at start: $START_LEVEL%"
} > "$LOG_DIR/meta.txt"
echo "epoch,free_pct,job_rss_mb" > "$TRACE"
say "run $NAME → $LOG_DIR (free ${START_LEVEL}%, watchdog at ${FLOOR}%)"

# The job, in its own process group (job control on), so the watchdog can stop
# everything it started in one signal.
START_EPOCH="$(date +%s)"
set -m
"${CMD[@]}" > >(tee -a "$OUTPUT") 2> >(tee -a "$OUTPUT" >&2) &
JOB=$!
set +m
CAF=""
if command -v caffeinate > /dev/null 2>&1; then
  caffeinate -i -w "$JOB" &
  CAF=$!
fi

# Every live descendant of $1 (processes that left the group with setsid included).
descendants() {
  ps -axo pid=,ppid= | awk -v root="$1" '
    { parent[$1] = $2 }
    END {
      changed = 1; mark[root] = 1
      while (changed) { changed = 0
        for (p in parent) if (!(p in mark) && (parent[p] in mark)) { mark[p] = 1; changed = 1 } }
      for (p in mark) if (p != root) print p
    }'
}

group_rss_mb() {
  local pids
  pids="$(printf '%s\n' "$1" $(descendants "$1") | paste -sd, -)"
  ps -o rss= -p "$pids" 2> /dev/null | awk '{s += $1} END {printf "%d\n", s / 1024}'
}

stop_job() {
  local kids
  kids="$(descendants "$JOB")"
  kill -TERM -- "-$JOB" 2> /dev/null || true
  # shellcheck disable=SC2086
  [ -z "$kids" ] || kill -TERM $kids 2> /dev/null || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    kill -0 "$JOB" 2> /dev/null || break
    sleep 0.5
  done
  kill -KILL -- "-$JOB" 2> /dev/null || true
  # shellcheck disable=SC2086
  [ -z "$kids" ] || kill -KILL $kids 2> /dev/null || true
}

WATCHDOG=0
INTERRUPTED=0
trap 'INTERRUPTED=1; say "interrupted — stopping the job"; stop_job' INT TERM HUP

MIN_LEVEL="$START_LEVEL"
PEAK_RSS=0
while kill -0 "$JOB" 2> /dev/null; do
  level="$(memlevel)"
  rss="$(group_rss_mb "$JOB")"
  echo "$(date +%s),$level,$rss" >> "$TRACE"
  if [ "$level" -lt "$MIN_LEVEL" ]; then MIN_LEVEL="$level"; fi
  if [ "$rss" -gt "$PEAK_RSS" ]; then PEAK_RSS="$rss"; fi
  if [ "$level" -lt "$FLOOR" ]; then
    say "WATCHDOG: free memory ${level}% < ${FLOOR}% — stopping the job"
    WATCHDOG=1
    stop_job
    break
  fi
  sleep "$INTERVAL"
done

set +e
wait "$JOB"
CODE=$?
set -e
if [ -n "$CAF" ]; then kill "$CAF" 2> /dev/null || true; fi
if [ "$WATCHDOG" = 1 ]; then CODE=137; fi
END_LEVEL="$(memlevel)"
sweep

ENDED="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
SECONDS_TAKEN=$(( $(date +%s) - START_EPOCH ))
node -e '
  const [file, ...kv] = process.argv.slice(1);
  const o = {};
  for (let i = 0; i < kv.length; i += 2) o[kv[i]] = /^-?\d+$/.test(kv[i + 1]) ? Number(kv[i + 1]) : kv[i + 1];
  o.watchdogKilled = o.watchdogKilled === 1;
  o.interrupted = o.interrupted === 1;
  require("node:fs").writeFileSync(file, JSON.stringify(o, null, 2) + "\n");
' "$LOG_DIR/summary.json" \
  name "$NAME" command "${CMD[*]}" rev "$REV" ended "$ENDED" seconds "$SECONDS_TAKEN" \
  exitCode "$CODE" watchdogKilled "$WATCHDOG" interrupted "$INTERRUPTED" floorPct "$FLOOR" \
  startFreePct "$START_LEVEL" minFreePct "$MIN_LEVEL" endFreePct "$END_LEVEL" peakRssMB "$PEAK_RSS"

INDEX="$(dirname "$LOG_DIR")/index.tsv"
[ -f "$INDEX" ] || printf 'stamp\tname\texit\twatchdog\tseconds\tmin_free_pct\tpeak_rss_mb\trev\tlog\n' > "$INDEX"
printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$STAMP" "$NAME" "$CODE" "$WATCHDOG" "$SECONDS_TAKEN" \
  "$MIN_LEVEL" "$PEAK_RSS" "$REV" "$LOG_DIR" >> "$INDEX"

say "done: exit $CODE, ${SECONDS_TAKEN}s, free min ${MIN_LEVEL}%, peak ${PEAK_RSS} MB$([ "$WATCHDOG" = 1 ] && echo ', STOPPED BY WATCHDOG')"
exit "$CODE"
