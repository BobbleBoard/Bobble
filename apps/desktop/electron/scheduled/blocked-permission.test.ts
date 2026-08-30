/**
 * c1: a scheduled run that macOS blocked must FAIL, not succeed emptily.
 *
 * The shape this prevents: a brief whose Calendar consent was never granted
 * records `ok` every morning with a summary that is an apology, and the user
 * sees a week of green.
 */
import { describe, expect, it } from 'vitest';
import { blockedPermission, blockedPermissionError } from './blocked-permission';

describe('blockedPermission', () => {
  it('catches the connectors’ own automation wording', () => {
    // This is the exact text friendlyScriptError() produces (osascript.ts).
    const real =
      'calendar_list_events needs permission to control the app. Grant it under ' +
      'System Settings › Privacy & Security › Automation (approve the prompt), then retry.';
    expect(blockedPermission(real)).toContain('Automation');
  });

  it('catches the raw AppleScript code too, in case the wording changes', () => {
    expect(
      blockedPermission('execution error: Not authorized to send Apple events (-1743)'),
    ).toContain('Automation');
  });

  it('catches the Full Disk Access shape messages_recent hits', () => {
    expect(blockedPermission('unable to open database file')).toContain('Full Disk Access');
    expect(blockedPermission('SQLITE_AUTH: not authorized')).toContain('Full Disk Access');
  });

  it('does NOT call every failure a permission problem', () => {
    // Sending someone to System Settings to fix something else is worse than
    // saying nothing.
    expect(blockedPermission('mail_search failed: unknown osascript error')).toBeNull();
    expect(blockedPermission('could not find a referenced item')).toBeNull();
    expect(blockedPermission('the network is unreachable')).toBeNull();
    expect(blockedPermission('')).toBeNull();
  });
});

describe('blockedPermissionError', () => {
  it('names the tool, the permission, and that one grant fixes it', () => {
    const msg = blockedPermissionError('calendar_list_events', 'Automation (…)');
    expect(msg).toContain('calendar_list_events');
    expect(msg).toContain('Automation');
    expect(msg).toMatch(/next run/);
  });
});
