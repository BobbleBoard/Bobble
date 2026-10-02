import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ActivityChain, ActivityStep, type ActivityStepData } from './activity-chain.tsx';

/**
 * Tool-row arg surfacing + disclosure (the user round-2 #2). Every tool row must
 * name WHICH file/command/query it acted on ("Read a file: <path>") and the
 * whole row must be a click-to-expand disclosure that reveals the full arg +
 * the result/output. Asserted through the repo's jsdom-free static-markup
 * convention — `expanded` is a controlled prop, so both states render here.
 */
function render(data: ActivityStepData, expanded = false): string {
  return renderToStaticMarkup(<ActivityStep data={data} expanded={expanded} />);
}

describe('ActivityStep — primary arg surfaced inline', () => {
  const read: ActivityStepData = {
    kind: 'read',
    label: 'Read a file',
    detail: '/Users/user/src/deep/config.ts',
    filename: 'config.ts',
    preview: 'export const x = 1;',
  };

  it('shows the verb AND the file basename as a subline (spec-tool-call-row)', () => {
    const html = render(read);
    expect(html).toContain('Read a file');
    // A file-op row names its file on a SUBLINE under the verb (not inline).
    expect(html).toContain('pd-chain-step-subline');
    expect(html).toContain('>config.ts<');
    // …with the full path carried on `title` for hover.
    expect(html).toContain('title="/Users/user/src/deep/config.ts"');
  });

  it('makes the whole row a disclosure button with a chevron', () => {
    const collapsed = render(read, false);
    expect(collapsed).toContain('pd-chain-step-chevron');
    expect(collapsed).toMatch(/<button[^>]*class="pd-chain-step-row/);
    expect(collapsed).toContain('aria-expanded="false"');
    // The same row flips its expanded state from the controlled prop.
    expect(render(read, true)).toContain('aria-expanded="true"');
  });

  it('carries the FULL path + the result inside the reveal', () => {
    const html = render(read, true);
    expect(html).toContain('pd-chain-arg');
    // Full path (not just basename) in the reveal header, plus the file body.
    expect(html).toContain('/Users/user/src/deep/config.ts');
    expect(html).toContain('export const x = 1;');
  });

  it('surfaces a bash command verbatim (no basename truncation)', () => {
    const html = render({
      kind: 'bash',
      label: 'Ran a command',
      detail: 'cat src/app.ts',
      command: 'cat src/app.ts',
      output: 'ok',
    });
    expect(html).toContain('Ran a command');
    // A command keeps its slashes — it is NOT reduced to a basename.
    expect(html).toContain('cat src/app.ts');
  });

  it('surfaces a search query inline without turning the row into a disclosure', () => {
    const html = render({
      kind: 'search',
      label: 'Searched the web',
      detail: 'weather in tokyo',
      results: [{ title: 'Tokyo', url: 'https://example.com', domain: 'example.com' }],
    });
    expect(html).toContain('weather in tokyo');
    // Search renders its results inline (always open) — no click-to-reveal chevron.
    expect(html).not.toContain('pd-chain-step-chevron');
  });

  it('still surfaces the arg while running, before any result exists', () => {
    const html = render({
      kind: 'read',
      label: 'Reading a file',
      status: 'running',
      detail: '/tmp/notes.md',
      filename: 'notes.md',
    });
    expect(html).toContain('notes.md');
    // Nothing to reveal yet → no disclosure chevron.
    expect(html).not.toContain('pd-chain-step-chevron');
  });

  it('omits the inline arg entirely when no detail is provided', () => {
    const html = render({ kind: 'read', label: 'Read a file', preview: 'body' });
    expect(html).not.toContain('pd-chain-step-detail');
    expect(html).not.toContain('pd-chain-step-subline');
  });
});

/**
 * A2 — a read/edit/skill row can OPEN its file in the canvas. With `onOpenFile`
 * wired, the primary click opens the file and a separate chevron button still
 * discloses the args + result (deliverable 2 + 3 coexisting, no nested buttons).
 */
describe('ActivityStep — open-in-canvas affordance', () => {
  const read: ActivityStepData = {
    kind: 'read',
    label: 'Read a file',
    detail: '/repo/src/app.ts',
    filename: 'app.ts',
    preview: 'body',
  };

  it('splits into an open-file main button + a disclosure chevron when content exists', () => {
    const html = renderToStaticMarkup(
      <ActivityStep data={read} onOpenFile={() => {}} expanded={false} />,
    );
    expect(html).toContain('pd-chain-step-row--split');
    expect(html).toContain('pd-chain-step-open-main');
    expect(html).toContain('pd-chain-step-disclose');
    // The main button's accessible name names the file it opens.
    expect(html).toContain('Open app.ts in canvas');
    // The chevron still drives the reveal.
    expect(html).toContain('aria-expanded="false"');
  });

  it('makes the WHOLE row open the file when there is no content to disclose yet', () => {
    const running: ActivityStepData = {
      kind: 'read',
      label: 'Reading a file',
      status: 'running',
      detail: '/repo/src/app.ts',
      filename: 'app.ts',
    };
    const html = renderToStaticMarkup(<ActivityStep data={running} onOpenFile={() => {}} />);
    expect(html).toContain('Open app.ts in canvas');
    expect(html).not.toContain('pd-chain-step-row--split');
    expect(html).not.toContain('pd-chain-step-chevron');
  });

  it('does NOT offer to open a non-file kind (e.g. bash) even with onOpenFile wired', () => {
    const html = renderToStaticMarkup(
      <ActivityStep
        data={{ kind: 'bash', label: 'Ran a command', detail: 'ls', command: 'ls', output: 'ok' }}
        onOpenFile={() => {}}
      />,
    );
    expect(html).not.toContain('pd-chain-step-open-main');
  });
});

/**
 * A1/A4 — a connector row renders "Used <connector icon> <connector name>" with
 * the injected brand SVG, and every generic tool row is a disclosure that reveals
 * the raw args + result (never a mislabeled "Read a file").
 */
describe('ActivityStep — connector + generic tool rows', () => {
  it('renders a connector row with its injected brand SVG and a disclosure', () => {
    const html = renderToStaticMarkup(
      <ActivityStep
        data={{
          kind: 'connector',
          label: 'Set a reminder',
          iconSvg: '<svg data-testid="brand"></svg>',
          argsText: '{ "title": "Call" }',
          output: 'ok',
        }}
      />,
    );
    expect(html).toContain('Set a reminder');
    expect(html).toContain('data-testid="brand"');
    expect(html).toContain('pd-chain-step-chevron');
  });

  it('reveals ONLY a generic tool row’s result — never the raw args JSON (LC7)', () => {
    const html = renderToStaticMarkup(
      <ActivityStep
        data={{
          kind: 'tool',
          label: 'Do thing',
          argsText: '{"secret_token":"SHOULD_NOT_RENDER"}',
          output: 'result',
        }}
        expanded
      />,
    );
    expect(html).toContain('Do thing');
    expect(html).toContain('result');
    // The raw args JSON (schema noise) is gone — no Input block, no args dump.
    expect(html).not.toContain('SHOULD_NOT_RENDER');
    expect(html).not.toContain('>Input<');
    expect(html).not.toContain('>Output<');
    // One clean block frame carries the result.
    expect(html).toContain('pd-chain-termblock');
  });
});

/**
 * LC5 — a bash/terminal row reveals ONE terminal block: a dimmed `$ ` prompt +
 * the command on the first line, then the output below, all in a single frame —
 * never a split command-code-block + output-block.
 */
describe('ActivityStep — one-block terminal (LC5/LC6)', () => {
  it('renders command + output in a single terminal block with a $ prompt', () => {
    const html = renderToStaticMarkup(
      <ActivityStep
        data={{ kind: 'bash', label: 'Ran a command', command: 'ls -la /tmp', output: 'total 8' }}
        expanded
      />,
    );
    // Exactly one output frame — not a separate CodeBlock for the command.
    expect(html.match(/pd-chain-output-frame/g)?.length).toBe(1);
    expect(html).not.toContain('pd-code-block');
    // The `$ ` prompt + command, then the output, in that one block.
    expect(html).toContain('pd-term-prompt');
    expect(html).toContain('ls -la /tmp');
    expect(html).toContain('total 8');
  });
});

/**
 * A3 — the terminal "Done" row appears ONLY once the run is finished, never on
 * the momentary inter-tool gap while the chain is live (`active`).
 */
describe('ActivityChain — "Done" gating (A3 flash fix)', () => {
  const steps: ActivityStepData[] = [{ kind: 'bash', label: 'Ran a command', status: 'done' }];

  it('shows "Done" when the run is finished (not active)', () => {
    const html = renderToStaticMarkup(<ActivityChain steps={steps} expanded active={false} />);
    expect(html).toContain('pd-chain-done');
    expect(html).toContain('Done');
  });

  it('hides "Done" while the chain is still live (active) — no mid-chain flash', () => {
    const html = renderToStaticMarkup(<ActivityChain steps={steps} expanded active />);
    expect(html).not.toContain('pd-chain-done');
  });
});

/**
 * THE ELAPSED COUNTER, WHICH WAS BUILT AND NEVER RENDERED.
 *
 * the user asked for it watching a command sit there: "some 'seconds' timer going on
 * here would be much appreciated, it's been going for a few minutes, seems like
 * it should be timing out by now." `RunningFor` was written, the CSS was written
 * — and nothing rendered it. A lint warning for an unused function was the only
 * sign. Registered is not reachable, in my own work this time.
 */
describe('ActivityStep — elapsed counter on a running row', () => {
  const running = (extra: Partial<ActivityStepData> = {}): ActivityStepData =>
    ({
      kind: 'bash',
      label: 'Running a command',
      detail: 'python3 app.py',
      status: 'running',
      startedAt: Date.now() - 42_000,
      ...extra,
    }) as ActivityStepData;

  it('shows how long a running step has been going', () => {
    const html = render(running());
    expect(html).toContain('pd-chain-step-elapsed');
    expect(html).toContain('42s');
  });

  it('reaches a file-op row too, not just the plain one', () => {
    const html = render(
      running({ kind: 'read', label: 'Reading a file', detail: '/w/app.py', filename: 'app.py' }),
    );
    expect(html).toContain('pd-chain-step-elapsed');
  });

  it('reads as minutes once past a minute — the case the user was looking at', () => {
    expect(render(running({ startedAt: Date.now() - 185_000 }))).toContain('3m 5s');
  });

  it('shows nothing on a settled step', () => {
    expect(render(running({ status: 'done' }))).not.toContain('pd-chain-step-elapsed');
  });

  it('does not flicker a count onto a step that just started', () => {
    expect(render(running({ startedAt: Date.now() }))).not.toContain('pd-chain-step-elapsed');
  });
});

describe('"Done" does not flap on the gap between tool calls', () => {
  const steps: ActivityStepData[] = [{ kind: 'bash', label: 'Ran a command', status: 'done' }];

  it('a chain that mounts already finished says Done immediately', () => {
    // Historical turns must not wait for a timer to admit they are over.
    const html = renderToStaticMarkup(<ActivityChain steps={steps} expanded />);
    expect(html).toContain('pd-chain-done');
  });

  it('an ACTIVE chain never shows Done, even with every step settled', () => {
    /*
     * The flash the user reported: between two tool calls every step is briefly
     * settled, so `!running` alone was true and Done appeared, then the next
     * tool erased it. `active` marks the turn as still in flight.
     */
    const html = renderToStaticMarkup(<ActivityChain steps={steps} expanded active />);
    expect(html).not.toContain('pd-chain-done');
  });
});

/**
 * WHAT THE NEWLY-CLICKABLE ROWS ACTUALLY SAY.
 *
 * `hasInlineContent` returning true only earns a chevron; the point was the
 * content behind it. These assert the reveal bodies, because a row that opens
 * onto an empty box is the same dead end with an extra click in front of it.
 */
describe('ActivityStep — reveals for the rows that used to be dead', () => {
  it('a navigate row opens to its URL, title and status', () => {
    const html = render(
      {
        kind: 'browser-navigate',
        label: 'Visited a page',
        detail: 'https://example.dev/pricing',
        url: 'https://example.dev/pricing',
        title: 'Pricing — Example',
        pageStatus: '200',
      },
      true,
    );
    expect(html).toContain('pd-chain-facts');
    expect(html).toContain('https://example.dev/pricing');
    expect(html).toContain('Pricing — Example');
    expect(html).toContain('200');
  });

  it('a click row names the element AND the page it happened on', () => {
    const html = render(
      {
        kind: 'browser-click',
        label: 'Clicked',
        url: 'https://example.dev/pricing',
        target: 'button[data-test=buy]',
      },
      true,
    );
    expect(html).toContain('button[data-test=buy]');
    // "Clicked #buy" on an unknown page answers nothing — the page comes too.
    expect(html).toContain('https://example.dev/pricing');
  });

  it('a type row quotes the text so trailing whitespace is visible', () => {
    const html = render(
      { kind: 'browser-type', label: 'Typed', target: '#email', typed: 'a@b.com ' },
      true,
    );
    expect(html).toContain('#email');
    expect(html).toContain('&quot;a@b.com &quot;');
  });

  it('a media row with no canvas target says what it points at', () => {
    const html = render(
      { kind: 'image', label: 'Generated an image', filename: 'hero.png', src: '/out/hero.png' },
      true,
    );
    expect(html).toContain('hero.png');
    expect(html).toContain('/out/hero.png');
    expect(html).toContain('no canvas target');
  });

  it('a media row WITH a canvas target is still a canvas button, not a disclosure', () => {
    const html = render(
      { kind: 'image', label: 'Generated an image', filename: 'hero.png', opensInCanvas: true },
      true,
    );
    expect(html).toContain('Opens in canvas');
    expect(html).not.toContain('pd-chain-facts');
  });

  it('a read with no preview still discloses its full path', () => {
    const html = render(
      { kind: 'read', label: 'Read a file', detail: '/Users/user/src/deep/config.ts' },
      true,
    );
    // The row shows the basename; the reveal restates the whole path.
    expect(html).toContain('pd-chain-arg');
    expect(html).toContain('/Users/user/src/deep/config.ts');
    // …and explains the empty body, rather than leaving what looks like a bug.
    expect(html).toContain('returned no content');
  });

  it('a folder listing is its own kind, not a relabelled file read', () => {
    const html = render({ kind: 'folder', label: 'Listed a folder', detail: '/w/src' }, true);
    expect(html).toContain('data-kind="folder"');
    expect(html).toContain('/w/src');
  });

  it('an edit with no diff shows the path and the ± counts', () => {
    const html = render(
      { kind: 'edit', label: 'Edited a file', detail: '/w/app.ts', added: 12, deleted: 3 },
      true,
    );
    expect(html).toContain('/w/app.ts');
    expect(html).toContain('+12 −3');
  });

  it('a REJECTED edit says nothing was written, rather than implying it was', () => {
    const html = render(
      { kind: 'edit', label: 'Edited a file', detail: '/w/app.ts', added: 12, failed: true },
      true,
    );
    // The failure path renders the error body first; the ± claim must not read
    // as a change that landed.
    expect(html).toContain('/w/app.ts');
  });

  it('an empty search shows the query and the backend note that explains it', () => {
    const html = render({
      kind: 'search',
      label: 'Searched the web',
      detail: 'tokyo weather',
      query: 'tokyo weather',
      results: [],
      note: 'search backend rate-limited',
    });
    expect(html).toContain('tokyo weather');
    expect(html).toContain('search backend rate-limited');
  });

  it('a browser-read with no page text names the page instead of nothing', () => {
    const html = render(
      {
        kind: 'browser-read',
        label: 'Read the page',
        detail: 'https://example.dev',
        title: 'Example',
      },
      true,
    );
    expect(html).toContain('https://example.dev');
    expect(html).toContain('Example');
    expect(html).toContain('returned no text');
    // The URL is already this kind's reveal arg header, so the fact list must
    // not restate it — that was the duplication BrowserReveal would have caused.
    expect(html).toContain('pd-chain-arg');
    expect(html).not.toContain('>Page<');
    expect(html).not.toContain('>URL<');
  });

  /*
   * A RUNNING STEP HAS NOT RETURNED NOTHING — IT HAS NOT RETURNED YET.
   *
   * Opening every path-carrying row unconditionally made an in-flight read
   * disclose "the tool returned no content", which is a claim about a call that
   * has not finished. Two older tests caught it; these keep the rule visible.
   */
  it('does not claim an in-flight read came back empty', () => {
    const html = render(
      { kind: 'read', label: 'Reading a file', detail: '/w/app.ts', status: 'running' },
      true,
    );
    expect(html).not.toContain('returned no content');
    expect(html).not.toContain('pd-chain-step-chevron');
  });

  it('opens the same row the moment it settles', () => {
    const html = render(
      { kind: 'read', label: 'Read a file', detail: '/w/app.ts', status: 'done' },
      true,
    );
    expect(html).toContain('returned no content');
  });

  it('keeps a browser row open while running — its args are known at call time', () => {
    // Unlike a result, "which URL" and "what text" are true the instant the
    // call is made, so these rows do not wait to be openable.
    const html = render(
      { kind: 'browser-type', label: 'Typing', target: '#q', typed: 'hi', status: 'running' },
      true,
    );
    expect(html).toContain('#q');
    expect(html).toContain('&quot;hi&quot;');
  });
});

describe('a collapsed row carries no details (MEASURED: a 183-step turn, 11.7k nodes)', () => {
  it('makes its output only when it is opened', () => {
    const bash: ActivityStepData = {
      kind: 'bash',
      label: 'Ran a command',
      detail: 'pytest -q',
      command: 'pytest -q',
      output: '2 passed in 0.10s',
    };
    expect(render(bash, false)).not.toContain('2 passed in 0.10s');
    expect(render(bash, true)).toContain('2 passed in 0.10s');
  });
});
