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
   * A GUI LAUNCHER WITH NO SCRIPT TO READ. The check above only fires when the
   * command names a .py/.js file it can open and inspect. `electron .`,
   * `npm start`, `npm run dev` name no file at all — nothing to read, so nothing
   * refused.
   *
   * MEASURED, run 7. At 20:38 an engineer ran a globally-installed `electron .`
   * in the project. That opens a window and never returns. Bobble's own window
   * went away 4 minutes later, the runner logged "window went away — stopping",
   * and the run died at 66 minutes having never reached the CEO's verification
   * turn. The engineer's process was STILL running afterwards.
   *
   * One engineer's foreground window can end the whole run, so this is refused
   * on the command shape alone.
   */
  const launcher =
    /(^|[\s;&|(])electron(\s|$)/.test(c) ||
    /(^|[\s;&|(])npm\s+(start|run\s+(dev|start|serve|electron))(\s|$)/.test(c) ||
    /(^|[\s;&|(])(pnpm|yarn)\s+(dev|start|serve)(\s|$)/.test(c) ||
    /(^|[\s;&|(])open\s+-a(\s|$)/.test(c);
  if (launcher && !/(^|[\s;&|(])timeout\s+\d+/.test(c) && !/&\s*$/.test(c)) {
    return (
      'that command opens a window and never returns — it would hang this entire ' +
      'run, so it was not executed. A GUI you launch in the foreground blocks your ' +
      'turn until a human closes it, and nothing here can. To CHECK the app works, ' +
      'drive it headlessly instead: run the code that does the work directly, or ' +
      'launch it with a `timeout N` in front so a block is a failed test rather ' +
      'than a dead run. To leave something running, background it with `&`.'
    );
  }

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
