/**
 * WHAT A GENERATED MESH NEEDS FROM A VIEWER — for the studio's viewer AND the
 * chat's card, which is why it lives on its own: the same file must look the
 * same in both rooms. Its baked atlas must not be mipmapped
 * ({@link disableMipmaps}); its normals are fine as they are (the note at the
 * foot says why, with numbers).
 *
 * ── Mipmaps ──────────────────────────────────────────────────────────────
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

/*
 * ── Normals ──────────────────────────────────────────────────────────────
 *
 * the user (2026-09-18): "recalculate / smooth normals help?" MEASURED, no. A
 * bake is split at every chart edge — 52% of the mannequin's vertices and 49%
 * of the astronaut's are duplicates of a seam position — so per-index normals
 * (three's computeVertexNormals; trimesh's vertex_normals, which the engine
 * exports) only ever see the faces on one side of a seam. Recomputing them per
 * POSITION was tried in both rooms: mean pixel difference in the Grey render,
 * card size, 0.12/255 on a 30k-face retopo and 0.18/255 on the 300k-face
 * astronaut — invisible, because a half-neighbourhood of a dense smooth surface
 * gives the same normal as the whole one. And the naive version HURT: flipped
 * triangles cluster by chart, so averaging across a seam mixed an outward
 * normal with an inward one and the astronaut came out grainy; the winding-
 * safe version merely matched per-index at a cost of a Map over every vertex.
 * So a file with no normals gets computeVertexNormals and a file with them
 * keeps them — in both rooms.
 */
