/**
 * The browsers whose open page the quick panel can read, by the name macOS
 * shows. Fixed strings only: a name is spliced into an AppleScript, and nothing
 * outside this list ever is. Pure — the renderer offers "the page open in …"
 * from the same list.
 */
export const SAFARI_LIKE: ReadonlySet<string> = new Set(['Safari', 'Safari Technology Preview']);

export const CHROME_LIKE: ReadonlySet<string> = new Set([
  'Google Chrome',
  'Google Chrome Canary',
  'Chromium',
  'Brave Browser',
  'Microsoft Edge',
  'Arc',
  'Vivaldi',
]);

export function isReadableBrowser(appName: string): boolean {
  return SAFARI_LIKE.has(appName) || CHROME_LIKE.has(appName);
}
