/**
 * COMMANDS THAT NEVER RETURN.
 *
 * Lives in the SHARED package because both paths need it and only one had it:
 * this was wired into the corp role-agent and nowhere else, so an ordinary chat
 * was ungated. Measured minutes after that fix landed — the plain chat ran
 * `python3 app.py` on a tkinter app and sat on mainloop() for over five minutes
 * with nothing able to close the window. Registered is not reachable; a guard on
 * one door is not a guard.
 */
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function wouldHang(command: string, cwd?: string): string | null {
  const c = command.trim();
  /*
   * A GUI APP RUN IN THE FOREGROUND NEVER RETURNS — and it takes the agent with
   * it. MEASURED: asked to fix a tkinter app, the model ran
   * `python3 ~/bobble-testbed/buggyapp/app.py` to "see if it works". That calls
   * root.mainloop(); the turn blocked, memory climbed, and the run ended having
   * fixed nothing. Separately a tester's own GUI script sat 2m42s at 855MB.
   *
   * Not guessable from the command alone — `python3 app.py` looks like any other
   * script — so READ the file and look for the loop that blocks. Cheap, and it
   * only ever refuses a command that genuinely would not come back. Same shape
   * as the Godot rule below, generalised: tkinter, Qt, pygame, and anything
   * started as a foreground server.
   */
  const script = /(?:^|\s)(?:python3?|node)\s+(\S+\.(?:py|js|mjs))(?:\s|$)/.exec(c)?.[1];
  if (script !== undefined && !/(^|[\s;&|(])timeout\s+\d+/.test(c)) {
    try {
      const abs = script.startsWith('/')
        ? script
        : path.resolve(cwd ?? process.cwd(), script.replace(/^~\//, `${os.homedir()}/`));
      const body = readFileSync(abs.replace(/^~\//, `${os.homedir()}/`), 'utf8');
      const blocker = /\.mainloop\s*\(/.test(body)
        ? 'tkinter mainloop()'
        : /\.exec_?\s*\(\)/.test(body) && /Q(Application|Widget)/.test(body)
          ? "Qt's exec()"
          : /pygame\.(display|event)/.test(body) && /while\s+(True|running)/.test(body)
            ? 'a pygame event loop'
            : /app\.run\s*\(/.test(body)
              ? 'a foreground server (app.run)'
              : null;
      if (blocker !== null) {
        return (
          `that command never returns — ${script} opens ${blocker}, which blocks until the ` +
          'window is closed by a human, and nothing here can close it. It would hang this ' +
          'entire run, so it was not executed. To CHECK it works, drive it instead: import ' +
          'the module, construct the window, call update() (not mainloop()), invoke the real ' +
          'handlers with real arguments, screenshot it, then destroy it. Or run it under a ' +
          'timeout so a block is a failed test rather than a dead run.'
        );
      }
    } catch {
      // Unreadable / not a real path — fall through; a guard must never be the
      // thing that stops an ordinary command.
    }
  }
  /*
   * NO LIST OF LAUNCHER NAMES HERE, ON PURPOSE.
   *
   * `electron .` killed run 7, and the first fix was a blocklist — electron,
   * npm start, yarn dev, open -a. the user removed it: "the deterministic guard
   * here is again something we need to let go of, how can you make this general
   * and reliable."
   *
   * A blocklist catches only what somebody already thought of, and refuses
   * commands that might have been fine. The general answer is a default TIMEOUT
   * on every bash command (`withDefaultTimeout`, ../index.ts): a clock does not
   * care whether it is a GUI, a server, an infinite loop or something nobody
   * has seen — control comes back either way.
   *
   * What stays here is a refusal EARNED by evidence: the check above opens the
   * file the command names and finds the blocking loop in it. That is a fact
   * about this program, not a guess from its name.
   */

  if (!/(^|[\s;&|(])godot(\s|$)/.test(c)) return null;
  // These all terminate on their own.
  if (/--quit(\b|-after)/.test(c) || /--script\b/.test(c) || /--write-movie\b/.test(c)) return null;
  if (/--version\b|--help\b|-h\b/.test(c)) return null;
  // Wrapped in something that will kill it — the shim we install on PATH.
  if (/(^|[\s;&|(])timeout\s+\d+/.test(c)) return null;
  return (
    'that Godot command never returns — `-e` and a bare `--path` open the editor or ' +
    'the project manager and wait forever, and `--headless` alone still runs the ' +
    'game loop. It would hang this entire run, so it was not executed. Use a form ' +
    'that exits by itself: `godot --headless --quit --path .` to load and report ' +
    'every error, or `godot --headless --script build.gd` to run a script.'
  );
}
