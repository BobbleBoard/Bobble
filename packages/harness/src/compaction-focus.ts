/**
 * What the app's Compact button sends as the summary's focus. Its presence is
 * how the harness's compaction gate knows a person asked (pi's auto-compaction
 * sends none). A file of its own, with no imports: the app's main process
 * reads it, and must not load pi to do so.
 */
export const MANUAL_COMPACTION_FOCUS =
  'The user asked for this compaction: keep what they asked for, the files made, and what is still to do.';
