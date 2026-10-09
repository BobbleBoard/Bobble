import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { wouldHang } from './hang-guard.js';

describe('the launcher blocklist is deliberately NOT here', () => {
  /*
   * A list of names — electron, npm start, yarn dev — lived here for one commit
   * (82082d1) after `electron .` killed run 7. The user removed it: "the
   * deterministic guard here is again something we need to let go of, how can
   * you make this general and reliable."
   *
   * The user is right. A blocklist catches only what somebody already thought of, and
   * refuses commands that might have been fine. The general answer is a default
   * TIMEOUT on every bash command (withDefaultTimeout in ../index.ts): a clock
   * does not care what the command is, and control comes back either way.
   *
   * This test exists so the list does not grow back by reflex.
   */
  it('does not refuse a launcher on its name — the timeout handles it', () => {
    expect(wouldHang('electron .')).toBeNull();
    expect(wouldHang('npm start')).toBeNull();
    expect(wouldHang('yarn dev')).toBeNull();
  });

  /* What DOES stay: a refusal earned by reading the file and finding the loop.
     That is evidence, not a name. */
  it('still refuses a script it has read and found a blocking loop in', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'hang-'));
    try {
      const f = path.join(dir, 'app.py');
      writeFileSync(f, 'import tkinter\nroot = tkinter.Tk()\nroot.mainloop()\n');
      expect(wouldHang(`python3 ${f}`)).toMatch(/never returns/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
