/**
 * AN ERROR, SAID SO A PERSON CAN ACT ON IT.
 *
 * the user (2026-10-08): "red text that's just a real unknown error or something
 * that doesn't have handling attached to it or can be easily done something
 * about just can't exist anymore." The audit found some sixty places that put
 * an exception's own words on screen — "fetch failed", "ENOENT: no such file
 * or directory, open …", "HTTP 429: {…}", a Python traceback's last line.
 *
 * What a person can do about a failure is short: get back online, make room,
 * allow access, find the file, wait, or try again. This reads the raw words
 * for which of those applies and says it; the context ("download", "open", …)
 * picks the sentence for anything it does not recognise, so even the unknown
 * case reads as what happened rather than as a stack. The raw words belong in
 * a log or behind Details, never as the message. Pure.
 */

export type ErrorContext =
  | 'download'
  | 'install'
  | 'search'
  | 'open'
  | 'read'
  | 'save'
  | 'move'
  | 'generate'
  | 'connect'
  | 'run'
  | 'engine'
  | 'generic';

/** The raw words of anything thrown or returned as an error. */
export function errorText(raw: unknown): string {
  if (raw === null || raw === undefined) return '';
  if (typeof raw === 'string') return raw;
  if (raw instanceof Error) {
    const cause = (raw as { cause?: unknown }).cause;
    return cause !== undefined ? `${raw.message} (${errorText(cause)})` : raw.message;
  }
  if (typeof raw === 'object' && 'message' in raw)
    return String((raw as { message: unknown }).message);
  return String(raw);
}

const FALLBACK: Readonly<Record<ErrorContext, string>> = {
  download: 'The download stopped. Try again — it carries on from where it got to.',
  install: 'The install stopped part-way. Try again.',
  search: 'The search did not go through. Try again.',
  open: 'It could not be opened.',
  read: 'It could not be read.',
  save: 'It could not be saved. Try again.',
  move: 'It could not be moved. Try again.',
  generate: 'It did not finish. Try again.',
  connect: 'It could not connect. Try again.',
  run: 'It stopped before it finished. Try again.',
  engine: 'The engine stopped. Try again.',
  generic: 'That did not work. Try again.',
};

const NET =
  /ENOTFOUND|EAI_AGAIN|getaddrinfo|ECONNRESET|ENETUNREACH|EHOSTUNREACH|fetch failed|failed to fetch|network ?(error|request failed)|socket hang up|other side closed|UND_ERR_(SOCKET|CONNECT)|certificate|self.signed|ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|offline|could not reach|name ?resolution|max retries/i;

/**
 * The plain sentence for an error. `context` says what was being done, which
 * decides the words for a cause it cannot name.
 */
export function plainError(raw: unknown, context: ErrorContext = 'generic'): string {
  const s = errorText(raw);
  if (s.trim() === '') return FALLBACK[context];
  if (/ENOSPC|no space left|disk (is )?full|not enough (disk|storage) space/i.test(s)) {
    return 'The disk is full. Free some space (Models › Storage), then try again.';
  }
  if (
    /\bOOM\b|out of memory|not enough memory|insufficient memory|failed to allocate|compute error/i.test(
      s,
    )
  ) {
    return 'There is not enough free memory for that right now. Closing other apps frees some.';
  }
  if (/\b429\b|too many requests|rate.?limit/i.test(s)) {
    return 'The server is busy right now (too many requests). Wait a minute, then try again.';
  }
  if (
    /\b(401|403)\b|unauthori[sz]ed|forbidden|gated|access (to .* )?(is )?(denied|restricted)/i.test(
      s,
    )
  ) {
    return 'The server refused it — it may need a sign-in or permission.';
  }
  if (/ECONNREFUSED|connection refused/i.test(s)) {
    return context === 'engine' || context === 'run'
      ? 'The engine is not running. Try again starts it.'
      : 'Nothing answered at that address. Check that it is running, then try again.';
  }
  if (NET.test(s)) {
    return context === 'connect'
      ? 'Could not reach the server. Check the connection, then try again.'
      : 'Could not reach the internet. Check the connection, then try again.';
  }
  if (/ETIMEDOUT|timed? ?out|deadline exceeded|took too long|did not answer in time/i.test(s)) {
    return 'It took too long and was stopped. Try again.';
  }
  if (
    /\b404\b|not found on (the )?server|RepositoryNotFound|EntryNotFound|does not exist on/i.test(s)
  ) {
    return 'It was not found on the server — it may have been moved or renamed.';
  }
  if (
    /\b5\d\d\b.*(error|status|server)|internal server error|bad gateway|service unavailable/i.test(
      s,
    )
  ) {
    return 'The server had a problem. Try again in a moment.';
  }
  if (/ENOENT|no such file|not there any more|no longer there|does not exist/i.test(s)) {
    return 'The file is not there any more — it may have been moved or deleted.';
  }
  if (
    /EACCES|EPERM|permission denied|operation not permitted|not allowed|read-only file system/i.test(
      s,
    )
  ) {
    return 'macOS did not allow Bobble to use that file or folder.';
  }
  if (/EISDIR|is a directory/i.test(s)) return 'That is a folder, not a file.';
  const missing = /(?:^|\b)([\w .+-]{2,40}?) is not installed/i.exec(s);
  if (missing !== null) return `${missing[1]?.trim()} is not installed on this Mac.`;
  if (/checksum|sha256|hash mismatch|size mismatch|corrupt/i.test(s)) {
    return 'The file arrived damaged. Try again — it downloads it afresh.';
  }
  if (/unexpected token|JSON|parse error|could not parse|invalid syntax/i.test(s)) {
    return context === 'read' || context === 'open'
      ? 'Its contents could not be read — it may be damaged or in a format Bobble does not know.'
      : 'The answer that came back could not be read. Try again.';
  }
  if (/already running|already in progress|busy/i.test(s)) {
    return 'Another one is already running. It starts when that one finishes.';
  }
  if (/abort|cancel/i.test(s)) return 'It was stopped.';
  return FALLBACK[context];
}
