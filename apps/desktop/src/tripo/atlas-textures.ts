/**
 * Turn OFF mipmapping on a baked material's maps — for the studio's viewer AND
 * the chat's card, which is why it lives on its own.
 *
 * A TRELLIS surface is stair-stepped voxel faces, so xatlas splits the atlas at
 * nearly every edge: MEASURED on a 199,999-face helicopter, the exported GLB has
 * 197,309 vertices — i.e. a chart per triangle. The atlas itself is correct
 * (extracted and inspected; the charts are cleanly coloured, and sampling the
 * voxel volume at each vertex agrees with the texture at its UV). But charts
 * that small are destroyed by mip generation: each triangle is around a pixel
 * on screen, the GPU drops to a high mip level, and every mip texel is an
 * average of hundreds of UNRELATED charts. That is the coloured static the user saw
 * — "texturing is completely messed up" — and it is why raising the atlas from
 * 1024 to 4096 did not help: a bigger base level still collapses the same way.
 *
 * Linear filtering with no mip chain samples the base level, which is the one
 * that actually corresponds to the surface.
 *
 * SEEN AGAIN 2026-09-18 in the chat card ("what's with this artifacting"): the
 * card mounted the file's own materials with three.js's default mip chain, at
 * 330px — a higher mip level still than the studio's viewport — while the same
 * file in the studio was clean. One helper for both rooms, so the card can
 * never drift from the viewer again.
 */
import { THREE } from '@pi-desktop/canvas/three';

export type AnyMaterial = InstanceType<typeof THREE.Material>;

const MAP_KEYS = ['map', 'metalnessMap', 'roughnessMap', 'emissiveMap', 'aoMap'] as const;

export function disableMipmaps(mat: AnyMaterial): void {
  const m = mat as unknown as Record<string, unknown>;
  for (const key of MAP_KEYS) {
    const tex = m[key] as InstanceType<typeof THREE.Texture> | null | undefined;
    if (tex == null) continue;
    tex.generateMipmaps = false;
    tex.minFilter = THREE.LinearFilter;
    tex.needsUpdate = true;
  }
}

/** Does this material carry real baked maps (rather than a flat colour)? */
export function hasTextureMaps(mat: AnyMaterial): boolean {
  const m = mat as {
    map?: unknown;
    metalnessMap?: unknown;
    roughnessMap?: unknown;
    emissiveMap?: unknown;
  };
  return m.map != null || m.metalnessMap != null || m.roughnessMap != null || m.emissiveMap != null;
}
