import type { ExtensionContext } from '@mariozechner/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';
import { checkDenylist, consentCopy, createMacConsentGate, riskLabel } from './permissions';

/** Minimal ctx stub: only hasUI + ui.confirm are read by the gate. */
function ctxStub(hasUI: boolean, confirmResult: boolean): ExtensionContext {
  return {
    hasUI,
    ui: { confirm: vi.fn(async () => confirmResult) },
    // biome-ignore lint/suspicious/noExplicitAny: minimal stub for the gate.
  } as any as ExtensionContext;
}

describe('checkDenylist', () => {
  it('refuses Pi Desktop, keychain, and system settings (case-insensitive)', () => {
    expect(checkDenylist('Pi Desktop')).toContain('denylist');
    expect(checkDenylist('Keychain Access')).toContain('denylist');
    expect(checkDenylist('System Settings')).toContain('denylist');
    expect(checkDenylist('app.pidesktop.desktop')).toContain('denylist');
  });

  it('allows ordinary apps and empty/undefined targets', () => {
    expect(checkDenylist('TextEdit')).toBeNull();
    expect(checkDenylist('Safari')).toBeNull();
    expect(checkDenylist(undefined)).toBeNull();
    expect(checkDenylist('')).toBeNull();
  });
});

describe('createMacConsentGate', () => {
  it('blocks a denylisted target regardless of consent', async () => {
    const gate = createMacConsentGate({ preConsented: true });
    const d = await gate.ensure(ctxStub(true, true), 'Pi Desktop');
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.reason).toContain('denylist');
  });

  it('asks once, remembers the yes for the session', async () => {
    const gate = createMacConsentGate();
    const ctx = ctxStub(true, true);
    expect(gate.isConsented()).toBe(false);
    const first = await gate.ensure(ctx, 'TextEdit');
    expect(first.ok).toBe(true);
    expect(gate.isConsented()).toBe(true);
    const second = await gate.ensure(ctx, 'TextEdit');
    expect(second.ok).toBe(true);
    // confirm was called only once (first action) — remembered thereafter.
    expect((ctx.ui.confirm as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });

  it('blocks (fail-safe) when there is no UI to confirm', async () => {
    const gate = createMacConsentGate();
    const d = await gate.ensure(ctxStub(false, true), 'TextEdit');
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.reason).toContain('no UI');
  });

  it('blocks when the user declines', async () => {
    const gate = createMacConsentGate();
    const d = await gate.ensure(ctxStub(true, false), 'TextEdit');
    expect(d.ok).toBe(false);
    expect(gate.isConsented()).toBe(false);
  });
});

describe('consent is per app, with the stakes on the prompt', () => {
  /** A ctx whose confirm records what it was asked and answers `answer`. */
  function asking(answer: boolean) {
    const asked: Array<{ title: string; message: string }> = [];
    const ctx = {
      hasUI: true,
      ui: {
        confirm: async (title: string, message: string) => {
          asked.push({ title, message });
          return answer;
        },
      },
    } as unknown as ExtensionContext;
    return { ctx, asked };
  }

  it('asks again for a SECOND app — one yes was allowing the whole Mac', async () => {
    const gate = createMacConsentGate();
    const { ctx, asked } = asking(true);
    expect((await gate.ensure(ctx, 'TextEdit')).ok).toBe(true);
    expect((await gate.ensure(ctx, 'TextEdit')).ok).toBe(true);
    expect(asked).toHaveLength(1);
    expect((await gate.ensure(ctx, 'Terminal')).ok).toBe(true);
    expect(asked).toHaveLength(2);
    expect([...gate.allowedApps()].sort()).toEqual(['terminal', 'textedit']);
  });

  it('lets an act with no app named ride on a grant already given', async () => {
    // Acts are stamped with the controlled app's pid, not its name; the app was
    // asked about when control was taken.
    const gate = createMacConsentGate();
    const { ctx, asked } = asking(true);
    await gate.ensure(ctx, 'TextEdit');
    expect((await gate.ensure(ctx)).ok).toBe(true);
    expect(asked).toHaveLength(1);
  });

  it('names the app it was declined for', async () => {
    const gate = createMacConsentGate();
    const { ctx } = asking(false);
    const res = await gate.ensure(ctx, 'Terminal');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain('Terminal');
  });

  it('puts the stakes on the question for an app where they are real', () => {
    expect(riskLabel('Terminal')).toContain('shell command');
    expect(riskLabel('iTerm2')).toContain('shell command');
    expect(riskLabel('1Password 7')).toContain('credentials');
    expect(riskLabel('Mail')).toContain('send messages as you');
    // and stays quiet for an ordinary one, so the warning keeps its meaning
    expect(riskLabel('TextEdit')).toBeNull();
    expect(riskLabel('Preview')).toBeNull();
    expect(riskLabel(undefined)).toBeNull();
  });

  it('carries the risk sentence into the prompt the user reads', () => {
    expect(consentCopy('Terminal').message).toContain('shell command');
    expect(consentCopy('TextEdit').message).not.toContain('shell command');
    expect(consentCopy('TextEdit').title).toBe('Let Bobble use TextEdit?');
  });
});
