import { describe, expect, it, vi } from 'vitest';
import { usePiStore } from '../../state/pi-slice';
import { openFailureMessage, reportOpen } from './open-outcome';

describe('openFailureMessage — a refused open says so', () => {
  it('says nothing when it worked', () => {
    expect(openFailureMessage({ verb: 'open', path: '/w/report.md' }, { ok: true })).toBeNull();
  });

  it('names the file, then gives main’s reason', () => {
    expect(
      openFailureMessage(
        { verb: 'open', path: '/w/level.gd' },
        {
          ok: false,
          error: 'No app on this Mac is set to open .gd files — choose one from Open with.',
        },
      ),
    ).toBe(
      "Couldn't open level.gd. No app on this Mac is set to open .gd files — choose one from Open with.",
    );
  });

  it('names the app that was picked', () => {
    expect(
      openFailureMessage(
        { verb: 'open', path: '/w/pic.png', appName: 'Photos' },
        { ok: false, error: 'That app is not installed on this Mac any more.' },
      ),
    ).toBe("Couldn't open pic.png in Photos. That app is not installed on this Mac any more.");
  });

  it('a reveal is a Finder sentence', () => {
    expect(
      openFailureMessage(
        { verb: 'reveal', path: '/w/pic.png' },
        { ok: false, error: 'It is not there any more — it may have been moved or deleted.' },
      ),
    ).toBe(
      "Couldn't show pic.png in Finder. It is not there any more — it may have been moved or deleted.",
    );
  });

  it('never shows an empty reason', () => {
    expect(openFailureMessage({ verb: 'open', path: '/w/a.txt' }, { ok: false })).toBe(
      "Couldn't open a.txt. The Mac did not say why.",
    );
  });
});

describe('reportOpen — every Open reads its answer', () => {
  it('reports a refusal and hands the outcome back', async () => {
    const report = vi.fn();
    const outcome = await reportOpen(
      async () => ({ ok: false, error: 'It is not there any more.' }),
      { verb: 'open', path: '/w/gone.md' },
      report,
    );
    expect(outcome.ok).toBe(false);
    expect(report).toHaveBeenCalledWith("Couldn't open gone.md. It is not there any more.");
  });

  it('by default the refusal is an error toast (ToastHost shows level "error")', async () => {
    usePiStore.setState({ notifications: [] });
    await reportOpen(
      async () => ({ ok: false, error: 'That app is not installed on this Mac any more.' }),
      {
        verb: 'open',
        path: '/w/pic.png',
        appName: 'Photos',
      },
    );
    const [n] = usePiStore.getState().notifications;
    expect(n?.level).toBe('error');
    expect(n?.message).toBe(
      "Couldn't open pic.png in Photos. That app is not installed on this Mac any more.",
    );
  });

  it('stays quiet when it worked', async () => {
    const report = vi.fn();
    await reportOpen(async () => ({ ok: true }), { verb: 'open', path: '/w/a.md' }, report);
    expect(report).not.toHaveBeenCalled();
  });

  /* A handler that throws (an untrusted sender, say) rejects the invoke — that
     used to vanish into `void`. */
  it('turns a rejected invoke into a report, without Electron’s wrapper text', async () => {
    const report = vi.fn();
    const outcome = await reportOpen(
      async () => {
        throw new Error(
          'Error invoking remote method \'canvas:open-with\': Error: [canvas] rejected "canvas:open-with": untrusted sender',
        );
      },
      { verb: 'open', path: '/w/a.md' },
      report,
    );
    expect(outcome.ok).toBe(false);
    expect(report).toHaveBeenCalledWith(
      'Couldn\'t open a.md. [canvas] rejected "canvas:open-with": untrusted sender',
    );
  });
});
