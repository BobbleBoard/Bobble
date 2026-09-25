/**
 * WHERE A `File` IS ON DISK.
 *
 * A File the OS handed over — a drop, a paste of files copied in Finder, the
 * file picker — knows its path, and the preload exposes it
 * (`webUtils.getPathForFile`, '' when there is none). A File the app made
 * itself from something it already had on disk (Send to chat fetches a
 * generated picture into one) does not: `new File([blob], name)` is bytes with a
 * name. Those remember their path here, so the composer attaches the picture
 * the viewer was showing rather than saving a second copy of its pixels.
 */

const madeFrom = new WeakMap<File, string>();

/** Mark a File the app built as the file at `path`. Returns the File. */
export function withPath(file: File, path: string): File {
  madeFrom.set(file, path);
  return file;
}

/** The absolute path behind a File, or '' when it has none. */
export function pathOfFile(file: File): string {
  const known = madeFrom.get(file);
  if (known !== undefined) return known;
  try {
    return window.piDesktop?.pathForFile(file) ?? '';
  } catch {
    return '';
  }
}
