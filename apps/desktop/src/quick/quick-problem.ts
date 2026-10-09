/**
 * EVERY WAY THE QUICK PANEL CAN BE TOLD NO — in words, with the way through.
 *
 * A capture without Screen Recording, a selection without Accessibility, a
 * browser that will not answer, computer use switched off: each becomes a small
 * card that says what happened in one plain sentence and carries the button
 * that fixes it. Never a raw error, never red — a permission is not an alarm.
 *
 * Pure: a problem in, the card's words and buttons out.
 */
import type { QuickProblem, QuickSystemPane } from '../../electron/quick/quick-contract';

/** A problem the panel itself finds, on top of the ones main reports. */
export type PanelProblem =
  | QuickProblem
  | { readonly kind: 'computer-use-off'; readonly app: string }
  | { readonly kind: 'computer-use-never'; readonly app: string };

export type ProblemFix =
  | { readonly kind: 'system-settings'; readonly pane: QuickSystemPane; readonly label: string }
  | { readonly kind: 'turn-on-computer-use'; readonly label: string }
  | { readonly kind: 'open-settings'; readonly section: string; readonly label: string }
  | { readonly kind: 'retry'; readonly label: string };

export interface ProblemCopy {
  readonly title: string;
  readonly body: string;
  readonly fixes: readonly ProblemFix[];
}

const where = (pane: string): string => `System Settings › Privacy & Security › ${pane}`;

export function problemCopy(p: PanelProblem): ProblemCopy {
  switch (p.kind) {
    case 'screen-recording':
      return {
        title: 'Bobble needs Screen Recording to see other apps',
        body: `Turn on Bobble in ${where('Screen Recording')}. macOS may ask you to reopen Bobble after.`,
        fixes: [
          { kind: 'system-settings', pane: 'screen-recording', label: 'Open Screen Recording' },
          { kind: 'retry', label: 'Try again' },
        ],
      };
    case 'accessibility':
      return {
        title: 'Bobble needs Accessibility to read your selection',
        body: `Turn on Bobble in ${where('Accessibility')} to use the text you select in other apps.`,
        fixes: [
          { kind: 'system-settings', pane: 'accessibility', label: 'Open Accessibility' },
          { kind: 'retry', label: 'Try again' },
        ],
      };
    case 'automation': {
      const app = p.app ?? 'that app';
      return {
        title: `Bobble is not allowed to talk to ${app}`,
        body: p.detail ?? `Turn on ${app} under Bobble in ${where('Automation')}, then try again.`,
        fixes:
          p.detail !== undefined
            ? []
            : [
                { kind: 'system-settings', pane: 'automation', label: 'Open Automation' },
                { kind: 'retry', label: 'Try again' },
              ],
      };
    }
    case 'secure':
      return {
        title: 'Your selection was not read',
        body: 'A password field has the keyboard, so Bobble left it alone.',
        fixes: [],
      };
    case 'nothing':
      return {
        title: 'Nothing to use there',
        body:
          p.detail ??
          (p.app !== undefined ? `${p.app} had nothing to give.` : 'There was nothing to use.'),
        fixes: [],
      };
    case 'unsupported':
      return {
        title: `${p.app ?? 'That app'} is not a browser Bobble can read`,
        body: 'Safari, Chrome, Edge, Brave, Arc and Vivaldi work. Pick a window instead to ask about anything else.',
        fixes: [],
      };
    case 'failed':
      return {
        title: 'That did not work this time',
        body: p.detail ?? 'Something got in the way. Trying again usually does it.',
        fixes: [{ kind: 'retry', label: 'Try again' }],
      };
    case 'computer-use-off':
      return {
        title: 'Computer use is off',
        body: `Turn it on to let Bobble click and type in ${p.app} for you. You choose which apps it may use without asking.`,
        fixes: [
          { kind: 'turn-on-computer-use', label: 'Turn on computer use' },
          { kind: 'open-settings', section: 'computer-use', label: 'Choose apps' },
        ],
      };
    case 'computer-use-never':
      return {
        title: `Bobble never uses ${p.app}`,
        body: 'Bobble itself, Keychain Access and System Settings are off limits for computer use. Ask a question about it instead.',
        fixes: [],
      };
  }
}
