/**
 * A reference image for OmniSVG, decoded and encoded by Electron: the pixels
 * go through gen-service's `omniSvgPicture` (on white, square, 448 × 448 — the
 * authors' `preprocess_image_for_svg`) and come back as a PNG for llama-server.
 * A file `nativeImage` cannot read goes as it is. With it, where the picture
 * has ink — what the candidates are measured against (gen-service pickScore).
 */
import { contentBox, type Extent, omniSvgPicture } from '@pi-desktop/gen-service';
import { nativeImage } from 'electron';

export function omniSvgPictureBase64(file: Buffer): { base64: string; box: Extent | null } {
  const image = nativeImage.createFromBuffer(file);
  if (image.isEmpty()) return { base64: file.toString('base64'), box: null };
  const { width, height } = image.getSize();
  // toBitmap is BGRA with alpha premultiplied; omniSvgPicture takes straight RGBA.
  const bgra = image.toBitmap();
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < rgba.length; i += 4) {
    const a = bgra[i + 3] ?? 255;
    const straight = (v: number): number =>
      a === 0 ? 0 : Math.min(255, Math.round((v * 255) / a));
    rgba[i] = straight(bgra[i + 2] ?? 0);
    rgba[i + 1] = straight(bgra[i + 1] ?? 0);
    rgba[i + 2] = straight(bgra[i] ?? 0);
    rgba[i + 3] = a;
  }
  const ready = omniSvgPicture({ width, height, data: rgba });
  const out = Buffer.alloc(ready.data.length);
  for (let i = 0; i < out.length; i += 4) {
    out[i] = ready.data[i + 2] ?? 255;
    out[i + 1] = ready.data[i + 1] ?? 255;
    out[i + 2] = ready.data[i] ?? 255;
    out[i + 3] = 255;
  }
  const base64 = nativeImage
    .createFromBitmap(out, { width: ready.width, height: ready.height })
    .toPNG()
    .toString('base64');
  return { base64, box: contentBox(ready) };
}
