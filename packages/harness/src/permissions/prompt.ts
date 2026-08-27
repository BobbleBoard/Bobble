/**
 * The permission prompt's wire contract — three answers, not two.
 *
 * ## Why a sentinel rather than `confirm`
 *
 * pi's extension-UI protocol is frozen at four dialog methods, and `confirm`
 * returns `Promise<boolean>`: two outcomes, when the useful set is three. "Allow
 * once" and "allow for this chat" are different decisions, and collapsing them
 * means either re-asking about the same command every single turn or granting
 * something permanently on a single click.
 *
 * So this borrows the pattern `ask_user` already proved: encode a rich spec
 * behind a sentinel in the one open-ended blocking method pi does emit
 * (`input`, which returns an arbitrary string), and decode it renderer-side.
 * In a plain TUI pi with no decoder it degrades to a text prompt showing the
 * command — still answerable, and still safe, because anything that is not an
 * explicit allow is treated as a refusal.
 *
 * ## What crosses
 *
 * The harness cannot import `@pi-desktop/ui` (no dependency, and it must keep
 * working outside the app), so it ships the RAW arguments and lets the renderer
 * build the diff with the components it already has.
 */

/** Sentinel prefixing the encoded spec. MUST match the decoder in the app. */
export const PERMISSION_SENTINEL = 'PI_DESKTOP_PERMISSION::v1::';

/** What the user is being asked to allow. */
export interface PermissionSpec {
  readonly v: 1;
  readonly toolName: string;
  /** Why it is being asked — the policy's own words. */
  readonly reason: string;
  /** The call's arguments, for the renderer to preview (a diff, a command). */
  readonly args: Record<string, unknown>;
  /** Correlates the prompt with the call, for a renderer that wants to. */
  readonly toolCallId?: string;
}

/**
 * The three answers.
 *
 * `session` means this chat, and only until it ends — see the note in
 * modes.ts about why that scope has to be re-derived rather than remembered.
 */
export type PermissionAnswer = 'once' | 'session' | 'deny';

export function encodePermission(spec: PermissionSpec): string {
  return PERMISSION_SENTINEL + JSON.stringify(spec);
}

/** Decode a prompt spec, or null when this is not one. */
export function decodePermission(placeholder: string): PermissionSpec | null {
  if (!placeholder.startsWith(PERMISSION_SENTINEL)) return null;
  try {
    const spec = JSON.parse(placeholder.slice(PERMISSION_SENTINEL.length)) as PermissionSpec;
    return spec.v === 1 && typeof spec.toolName === 'string' ? spec : null;
  } catch {
    return null;
  }
}

/**
 * Read an answer from whatever came back.
 *
 * ANYTHING UNRECOGNISED IS A REFUSAL. A dismissed dialog, an empty string from
 * a TUI, a decoder that does not know this sentinel — none of those are
 * permission, and defaulting the other way would turn every unknown into a yes.
 */
export function parsePermissionAnswer(raw: string | null | undefined): PermissionAnswer {
  const v = (raw ?? '').trim().toLowerCase();
  if (v === 'once' || v === 'allow' || v === 'y' || v === 'yes') return 'once';
  if (v === 'session' || v === 'always') return 'session';
  return 'deny';
}

/**
 * A stable key for "the user already allowed this in this chat".
 *
 * The TOOL plus its salient argument, not the whole argument blob: allowing
 * `rm -rf build` once should not also allow `rm -rf /`, and keying on the
 * entire JSON would make every call unique and the grant worthless.
 */
export function permissionKey(toolName: string, args: Record<string, unknown>): string {
  const salient =
    typeof args.command === 'string'
      ? args.command
      : typeof args.path === 'string'
        ? args.path
        : typeof args.file_path === 'string'
          ? args.file_path
          : '';
  return `${toolName}::${salient}`;
}
