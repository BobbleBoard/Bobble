/**
 * WHY A PREVIEW DID NOT LOAD, IN WORDS.
 *
 * The media, document and 3D surfaces used to say "Failed to load file
 * content" / "Failed to load model" for every failure — a moved file, a file
 * outside the folders the preview scheme serves, and a file the decoder could
 * not read all looked the same (2026-10-08 audit, after the user: "red text that's
 * just a real unknown error … just can't exist anymore"). The pd-file server
 * answers 404 for missing and 403 for outside its folders; asking it once (a
 * HEAD) tells the cases apart, and each says what the person can do.
 */

/** The server's status for `src`, or null when it cannot be asked. */
export async function previewStatus(src: string | undefined): Promise<number | null> {
  if (src === undefined || src === '') return null;
  try {
    const res = await fetch(src, { method: 'HEAD' });
    return res.status;
  } catch {
    return null;
  }
}

/** The sentence for a preview that did not load. */
export function previewFailure(status: number | null, what = 'file'): string {
  if (status === 404)
    return `This ${what} is not there any more — it may have been moved or deleted.`;
  if (status === 403) {
    return `Bobble only previews files in its own folders. Use Open above to see this ${what} in its app.`;
  }
  if (status !== null && status >= 200 && status < 300) {
    return `This ${what} could not be shown here — it may be damaged or in a format the preview does not read. Use Open above to see it in its app.`;
  }
  return `This ${what} could not be loaded just now.`;
}
