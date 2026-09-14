/**
 * IS THIS CALL THE MODEL DRIVING AN APP ON THE MAC?
 *
 * the user (2026-09-13): "activity tab should be computer use page if the latest
 * command is something like 'mac snapshot'". Two spellings reach here: the
 * tool-CLI (`mac snapshot`, `chrome tabs` through the `bash` tool) and the
 * schema tools (`mac_click`, `chrome_snapshot`). A bare `mac` or `mac --help`
 * is the model reading the manual, not driving anything, and stays out.
 *
 * Chrome counts: the user's own Chrome is driven through the same phantom
 * cursor and shows on the same monitor.
 */
import {
  CHROME_TOOL_NAMES,
  MAC_COMPUTER_USE_TOOL_NAMES,
} from '@pi-desktop/mac-computer-use/tool-names';
import { firstCommandWord } from './activity-cli';

const COMPUTER_USE_TOOLS: ReadonlySet<string> = new Set<string>([
  ...MAC_COMPUTER_USE_TOOL_NAMES,
  ...CHROME_TOOL_NAMES,
]);
const COMPUTER_USE_COMMANDS: ReadonlySet<string> = new Set(['mac', 'chrome']);

/** The verb after `mac` / `chrome`, when there is one that is not a flag. */
function cliVerb(command: string): string | undefined {
  const words = command.trim().split(/\s+/);
  const verb = words[1];
  if (verb === undefined || verb === '' || verb.startsWith('-')) return undefined;
  return verb;
}

export function isComputerUseCall(toolName: string, command: string | undefined): boolean {
  if (COMPUTER_USE_TOOLS.has(toolName)) return true;
  if (command === undefined) return false;
  const word = firstCommandWord(command);
  return word !== undefined && COMPUTER_USE_COMMANDS.has(word) && cliVerb(command) !== undefined;
}

/** What the tab says under "Activity" until the session names the app. */
export function computerUseLabel(toolName: string, command: string | undefined): string {
  if (command !== undefined) {
    const word = firstCommandWord(command);
    const verb = cliVerb(command);
    if (word !== undefined && verb !== undefined) return `${word} ${verb}`;
  }
  return toolName.replace(/_/g, ' ');
}
