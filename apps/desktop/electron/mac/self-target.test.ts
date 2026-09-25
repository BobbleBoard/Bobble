/**
 * A look or an act that names no app must never land on Bobble itself.
 *
 * The helper resolves a request the way Serve.swift does (targetFrom /
 * actTargetPid): a running pid first, then an app by name, else WHATEVER IS IN
 * FRONT — which, while the user is typing to Bobble, is Bobble. The model
 * below stands in for it, so these tests say where a request would really go.
 */
import type { MacAgentMethod } from '@pi-desktop/mac-computer-use/protocol';
import { describe, expect, it, vi } from 'vitest';
import { aimAwayFromSelf, type FrontApp, refuseSelf, SELF_REFUSAL } from './self-target';

const BOBBLE = 4100;
const TEXTEDIT = 5200;
const NAMES: Record<string, number> = { Bobble: BOBBLE, Electron: BOBBLE, TextEdit: TEXTEDIT };

/** On-screen apps, front first: the user is typing to Bobble, TextEdit behind. */
const Z_ORDER = [BOBBLE, TEXTEDIT];

/** Where the helper sends a request. */
function landsOn(params: Record<string, unknown>): number | undefined {
  if (typeof params.pid === 'number') return params.pid;
  if (typeof params.app === 'string') return NAMES[params.app];
  return Z_ORDER[0];
}

/** The helper's `frontmost`: one that skips `excludePids`, or an older one that cannot. */
function frontmostOf(skips: boolean, zOrder: readonly number[] = Z_ORDER) {
  return vi.fn(async (exclude: readonly number[]): Promise<FrontApp> => {
    const pid = skips ? zOrder.find((p) => !exclude.includes(p)) : zOrder[0];
    if (pid === undefined) return { ok: false };
    const app = Object.keys(NAMES).find((n) => NAMES[n] === pid && n !== 'Electron');
    // Serve.swift names the app it skipped past — only when it skipped one.
    const skipped = pid === zOrder[0] ? {} : { behind: 'Bobble' };
    return { ok: true, pid, ...(app === undefined ? {} : { app }), ...skipped };
  });
}

const deps = (skips = true) => ({ ownPids: [BOBBLE], frontmost: frontmostOf(skips) });

const AIMED: MacAgentMethod[] = [
  'snapshot',
  'click',
  'type',
  'key',
  'scroll',
  'menuClick',
  'tabs',
  'tabSelect',
  'tabNew',
  'tabClose',
  'windows',
  'bounds',
];

describe('the front-app path never lands on Bobble itself', () => {
  it('a look that names no app, with Bobble in front, is aimed at the app behind it', async () => {
    const aimed = await aimAwayFromSelf('snapshot', { cap: 60 }, deps());
    expect(landsOn(aimed)).toBe(TEXTEDIT);
    // Stamped, so the user switching apps between the two calls cannot move it.
    expect(aimed).toMatchObject({ cap: 60, pid: TEXTEDIT, app: 'TextEdit' });
  });

  it.each(AIMED)('%s with no app named goes to the app behind Bobble', async (method) => {
    const aimed = await aimAwayFromSelf(method, { text: 'hi', combo: 'return' }, deps());
    expect(landsOn(aimed)).toBe(TEXTEDIT);
  });

  it('an older helper that cannot skip Bobble: refused, never sent to it', async () => {
    await expect(aimAwayFromSelf('key', { combo: 'cmd+q' }, deps(false))).rejects.toThrow(
      SELF_REFUSAL,
    );
  });

  it('nothing on screen but Bobble: refused', async () => {
    const alone = {
      ownPids: [BOBBLE],
      frontmost: vi.fn(async (): Promise<FrontApp> => ({ ok: false })),
    };
    await expect(aimAwayFromSelf('type', { text: 'hello' }, alone)).rejects.toThrow(/Bobble/);
  });

  it('a pid that is Bobble’s own is refused, however it arrived', async () => {
    await expect(aimAwayFromSelf('click', { pid: BOBBLE, index: 3 }, deps())).rejects.toThrow(
      SELF_REFUSAL,
    );
  });

  it('the app under control and a named app pass untouched, with no extra round trip', async () => {
    const d = deps();
    const controlled = { pid: TEXTEDIT, app: 'TextEdit', index: 3 };
    expect(await aimAwayFromSelf('click', controlled, d)).toBe(controlled);
    const named = { app: 'Safari', cap: 60 };
    expect(await aimAwayFromSelf('snapshot', named, d)).toBe(named);
    expect(d.frontmost).not.toHaveBeenCalled();
  });

  it.each([
    'check',
    'policy',
    'brake',
    'setDriving',
    'launch',
    'frontmost',
    'wallpaper',
  ] as MacAgentMethod[])('%s aims at no app and passes untouched', async (method) => {
    const d = deps();
    const params = { driving: false };
    expect(await aimAwayFromSelf(method, params, d)).toBe(params);
    expect(d.frontmost).not.toHaveBeenCalled();
  });
});

describe('a look that resolved to Bobble by name is not kept', () => {
  it('refuses a result whose pid is Bobble’s own — a dev build is simply "Electron"', () => {
    expect(landsOn({ app: 'Electron' })).toBe(BOBBLE);
    expect(() => refuseSelf(BOBBLE, [BOBBLE])).toThrow(SELF_REFUSAL);
    expect(() => refuseSelf(TEXTEDIT, [BOBBLE])).not.toThrow();
    expect(() => refuseSelf(undefined, [BOBBLE])).not.toThrow();
  });
});

/*
 * The look's header says where a look that named no app landed. "The app the
 * USER has in front" is false once Bobble was in front and skipped, so the aim
 * marks it (mac-agent strips the mark and hands it back on the answer).
 */
describe('a look aimed past Bobble is marked, so its header can say so', () => {
  it('is marked when Bobble was in front and skipped', async () => {
    const aimed = await aimAwayFromSelf('snapshot', { cap: 60 }, deps());
    expect(aimed.behindBobble).toBe(true);
  });

  it('is not marked when the app in front was not Bobble', async () => {
    const d = { ownPids: [BOBBLE], frontmost: frontmostOf(true, [TEXTEDIT, BOBBLE]) };
    const aimed = await aimAwayFromSelf('snapshot', { cap: 60 }, d);
    expect(landsOn(aimed)).toBe(TEXTEDIT);
    expect(aimed.behindBobble).toBeUndefined();
  });
});
