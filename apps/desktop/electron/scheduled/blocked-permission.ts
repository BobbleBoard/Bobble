/**
 * "It ran fine" is the wrong answer when macOS said no.
 *
 * A scheduled brief reads Calendar, Mail and Reminders. If the automation
 * consent for one of them has not been granted — or was revoked, or the app was
 * re-signed and TCC forgot it — the connector returns a permission error, the
 * model writes "I wasn't able to access your calendar", and the run records
 * `ok` with a summary that is an apology.
 *
 * That is the worst possible shape: the user sees a task that has been running
 * every morning for a week, "successfully", producing nothing. A failure that
 * says so once is worth more than seven successes that do not.
 *
 * So a permission refusal in any tool result FAILS the run, and the error names
 * the permission to grant. Detected from the connectors' own friendly-error
 * wording (`mac-connectors/osascript.ts`, `messages.ts`), which is stable
 * because it is what the user is meant to read.
 */

/**
 * The permission a tool result is complaining about, or null.
 *
 * Deliberately narrow. An "unknown osascript error" is a failure but not a
 * permission failure, and calling everything a permission problem would send
 * people to System Settings to fix something else.
 */
export function blockedPermission(text: string): string | null {
  const s = text.toLowerCase();
  if (/privacy & security\s*›\s*automation|not authorized to send apple events|-1743/.test(s)) {
    return 'Automation (System Settings › Privacy & Security › Automation)';
  }
  if (/needs permission to control the app/.test(s)) {
    return 'Automation (System Settings › Privacy & Security › Automation)';
  }
  if (/full disk access/.test(s)) {
    return 'Full Disk Access (System Settings › Privacy & Security › Full Disk Access)';
  }
  // The sqlite shape `messages_recent` hits without Full Disk Access.
  if (/unable to open|not authorized|authorization denied|operation not permitted/.test(s)) {
    return 'Full Disk Access (System Settings › Privacy & Security › Full Disk Access)';
  }
  return null;
}

/** The run error a blocked permission produces — what is missing, and where. */
export function blockedPermissionError(toolName: string, permission: string): string {
  return `${toolName} was blocked: this Mac has not granted ${permission}. Grant it once and the task will work from the next run.`;
}
