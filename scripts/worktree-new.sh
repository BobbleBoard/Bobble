#!/usr/bin/env bash
# worktree-new.sh — make a lane's worktree the way the push needs it
# (deliverables/research/PLAN.md §2.1): .claude/worktrees/<lane> on branch
# push/<lane>, installed and built, ready for probes.
#
#   scripts/worktree-new.sh <lane> [--base <ref>] [--no-build]
#
# Steps, each one safe to rerun:
#   1. `git worktree add` — reusing push/<lane> when it already exists, and
#      retrying when another worktree operation holds git's lock (a dozen
#      agents create worktrees at once in a wave's first minute).
#   2. a PLAIN `pnpm install` at the worktree root. Never `pnpm -w install`:
#      `-w` installs the root project only and leaves every package's
#      node_modules empty, so `tsc` and `vitest` silently resolve to the wrong
#      thing (memory pi-desktop-worktrees-and-build). If the per-package
#      binaries are still missing afterwards, it reinstalls with --force.
#   3. `npm run build` in apps/desktop under the BUILD lock (two at a time on
#      this machine), because probes run the built app, not the source.
#
# It prints the worktree's PD_WORKTREE_TAG at the end: the probe harness
# derives the same tag from the path on its own, so screenshots and stable
# probe homes never collide with another lane's.
set -euo pipefail

usage() {
  sed -n '2,26p' "$0" | sed 's/^# \{0,1\}//'
  exit 64
}

LANE=""
BASE="main"
BUILD=1
while [ $# -gt 0 ]; do
  case "$1" in
    --base) BASE="$2"; shift 2 ;;
    --no-build) BUILD=0; shift ;;
    -h|--help) usage ;;
    -*) echo "worktree-new: unknown option $1" >&2; exit 64 ;;
    *) [ -z "$LANE" ] || usage; LANE="$1"; shift ;;
  esac
done
[ -n "$LANE" ] || usage
case "$LANE" in
  *[!A-Za-z0-9._-]*) echo "worktree-new: lane names are letters, digits, . _ - ($LANE)" >&2; exit 64 ;;
esac

say() { printf 'worktree-new: %s\n' "$*" >&2; }

# The MAIN checkout, even when this runs from inside another worktree.
COMMON="$(git rev-parse --path-format=absolute --git-common-dir)"
MAIN="$(cd "$COMMON/.." && pwd)"
WT="$MAIN/.claude/worktrees/$LANE"
BRANCH="push/$LANE"

git_retry() {
  local attempt out
  for attempt in 1 2 3 4 5 6; do
    if out="$(git -C "$MAIN" "$@" 2>&1)"; then
      [ -z "$out" ] || printf '%s\n' "$out" >&2
      return 0
    fi
    if printf '%s' "$out" | grep -qiE 'index\.lock|could not lock|unable to lock|is locked'; then
      say "git is busy (attempt $attempt), retrying in 3 s…"
      sleep 3
      continue
    fi
    printf '%s\n' "$out" >&2
    return 1
  done
  printf '%s\n' "$out" >&2
  return 1
}

if [ -d "$WT/.git" ] || [ -f "$WT/.git" ]; then
  say "$WT already exists — reusing it"
elif git -C "$MAIN" show-ref --verify --quiet "refs/heads/$BRANCH"; then
  say "adding $WT on the existing branch $BRANCH"
  git_retry worktree add "$WT" "$BRANCH"
else
  say "adding $WT on a new branch $BRANCH from $BASE"
  git_retry worktree add "$WT" -b "$BRANCH" "$BASE"
fi

cd "$WT"
say "pnpm install (plain, never -w)…"
pnpm install
if [ ! -x apps/desktop/node_modules/.bin/vitest ] || [ ! -x apps/desktop/node_modules/.bin/tsc ]; then
  say "per-package binaries are missing after install — reinstalling with --force"
  pnpm install --force
fi
[ -x apps/desktop/node_modules/.bin/vitest ] || { say "apps/desktop has no vitest after install"; exit 1; }

if [ "$BUILD" = 1 ]; then
  say "building apps/desktop under the build lock…"
  (cd apps/desktop && node "$WT/scripts/with-lock.mjs" build -- npm run build)
fi

say "ready: $WT (branch $BRANCH, PD_WORKTREE_TAG=$LANE)"
printf '%s\n' "$WT"
