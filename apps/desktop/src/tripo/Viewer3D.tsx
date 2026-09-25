/**
 * The center 3D viewer — a raw three.js scene rendering the studio's pipeline
 * stages for the loaded asset (bundled sample OR an imported file), driven by
 * the zustand store. Loaded ONLY through React.lazy so three stays folded into
 * this chunk.
 *
 *   mesh    → the base mesh, solid.
 *   segment → the mesh split into colored parts (vertex-color bands — the
 *             CubePart stage's demo pass; part names land in the store).
 *   retopo  → sample: the bundled clean-quad remesh + quad wireframe;
 *             imported: the model's REAL edge wireframe.
 *   texture → a generated procedural texture applied (Textured render mode).
 *   rig     → the sample's real three.js Skeleton overlaid (bind pose).
 *   animate → the rigged SkinnedMesh playing a baked AnimationClip.
 *
 * Render modes (viewport strip): Clay · Textured · Normal, plus a WIREFRAME
 * overlay toggle that draws edges on top of the active mode (skinned-aware —
 * the overlay tracks animation). Clay is a fixed white/grey, never theme-dark.
 *
 * HONESTY: the sample stages are backed by two bundled GLBs (hero-glb.ts) and
 * real geometry passes (vertex-color segmentation, procedural texture) — NOT
 * live runs of the intended engines (Hunyuan/TRELLIS, CubePart, AutoRemesher,
 * SkinTokens, ARDY). Imported files are decoded with the real three loaders
 * (GLTF/OBJ/STL) and normalized into the scene.
 *
 * Also owns: REAL export (GLTF/OBJ/STL/USDZ exporters via the viewer-io bus)
 * and asset thumbnails (a downscaled capture of the first rendered frame —
 * the "quick preview" that replaces icon artwork in the Assets grid).
 */

import {
  GLTFExporter,
  GLTFLoader,
  OBJExporter,
  OBJLoader,
  OrbitControls,
  RoomEnvironment,
  STLExporter,
  STLLoader,
  THREE,
  USDZExporter,
} from '@pi-desktop/canvas/three';
import type { JSX } from 'react';
import { useEffect, useRef } from 'react';
import { ensureModelBytes } from './asset-registry';
import { HERO_MESH_GLB_B64, HERO_RIG_GLB_B64 } from './assets/hero-glb';
import { disableMipmaps, hasTextureMaps } from './generated-mesh';
import { buildPresetClip } from './preset-motions';
import { useTripoStore } from './store';
import {
  setPresetMotionHandler,
  setViewerExportHandler,
  type ViewerExportRequest,
} from './viewer-io';
import { coveredLeft, floatingPanel } from './viewport-cover';

/** Resolve an arbitrary CSS color expression (var()/color-mix()) to an sRGB
 * string three can parse, using a detached probe span's computed style. */
function resolveColor(expr: string): string {
  const probe = document.createElement('span');
  probe.style.display = 'none';
  probe.style.color = expr;
  document.body.appendChild(probe);
  const out = getComputedStyle(probe).color;
  probe.remove();
  return out === '' ? 'rgb(128,128,128)' : out;
}

/**
 * Segment-part palette — ONE list, mirrored by `.tp-part-swatch` in tripo.css
 * (the panel legend) and by PART_PALETTE in
 * packages/gen3d-engine/python/workers/cubepart_worker.py (the colours the
 * engine bakes into the exported GLB). All three used to disagree, and the
 * Python one shipped a purple. No hue here lands in 255-320deg.
 */
const PART_COLORS = [
  '#e8863a',
  '#4a90d9',
  '#58b368',
  '#d9b44a',
  '#d9605a',
  '#3fb3ac',
  '#9ac05f',
  '#97a3ad',
] as const;

// ── shared creature profile (mirrors build-hero-glb.mjs) — used to draw the
// clean QUAD wireframe that reveals the retopology topology. ─────────────────
const RINGS = 20;
const RADIAL = 16;
const Y_TAIL = -1.35;
const Y_NECK = 1.15;
const GROUND_Y = -1.42;
/** Asset-tile preview: rendered at 2x, stored at 1x (see captureThumb). */
const THUMB_SIDE = 144;
const THUMB_RENDER = 288;
const radiusAt = (t: number): number => 0.14 + 0.5 * Math.exp(-(((t - 0.4) / 0.34) ** 2));
const yAt = (t: number): number => Y_TAIL + (Y_NECK - Y_TAIL) * t;

/** LineSegments of only the quad grid edges (rings + spine, no triangle
 * diagonals) so the retopo stage reads as clean quads rather than tris. */
function buildQuadWire(): InstanceType<typeof THREE.LineSegments> {
  const pts: number[] = [];
  const at = (i: number, j: number): [number, number, number] => {
    const t = i / RINGS;
    const r = radiusAt(t);
    const a = ((j % RADIAL) / RADIAL) * Math.PI * 2;
    return [Math.cos(a) * r, yAt(t), Math.sin(a) * r];
  };
  const push = (p: [number, number, number]) => pts.push(p[0], p[1], p[2]);
  for (let i = 0; i <= RINGS; i++) {
    for (let j = 0; j < RADIAL; j++) {
      push(at(i, j));
      push(at(i, j + 1)); // ring edge
    }
  }
  for (let j = 0; j < RADIAL; j++) {
    for (let i = 0; i < RINGS; i++) {
      push(at(i, j));
      push(at(i + 1, j)); // spine edge
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  const mat = new THREE.LineBasicMaterial({ transparent: true, opacity: 0.9 });
  return new THREE.LineSegments(geo, mat);
}

function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

/** Paint per-vertex part colors by height band; returns the part count used. */
function paintSegmentColors(geo: InstanceType<typeof THREE.BufferGeometry>): number {
  const pos = geo.getAttribute('position') as InstanceType<typeof THREE.BufferAttribute>;
  geo.computeBoundingBox();
  const bb = geo.boundingBox;
  if (bb === null) return 0;
  const minY = bb.min.y;
  const span = Math.max(bb.max.y - bb.min.y, 1e-6);
  const parts = 3;
  const colors = new Float32Array(pos.count * 3);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const t = (pos.getY(i) - minY) / span;
    // Top-down band order so part 0 (the list's first row, e.g. "Head") is the
    // TOP of the model — the panel swatches then match the painted regions.
    const band = parts - 1 - Math.min(parts - 1, Math.floor(t * parts));
    c.set(PART_COLORS[band] ?? PART_COLORS[0]);
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return parts;
}

// disableMipmaps / hasTextureMaps live in generated-mesh.ts — shared with the
// chat's card (media/ModelSurface.tsx), which showed the same static until it
// treated a baked atlas the way this viewer does.

/** Generate the procedural "generated texture": muted painterly bands +
 * speckle. Returns an sRGB CanvasTexture (the Hunyuan-Paint stage's demo). */
function buildGeneratedTexture(): InstanceType<typeof THREE.CanvasTexture> {
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx !== null) {
    const bands = ['#c8a06a', '#a8784a', '#8a5c38', '#c8a06a', '#e0c090'];
    const bandH = size / bands.length;
    bands.forEach((color, i) => {
      ctx.fillStyle = color;
      ctx.fillRect(0, i * bandH, size, bandH + 1);
    });
    // Speckle for a hand-painted read (deterministic LCG, no Math.random).
    let seed = 12345;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let i = 0; i < 2600; i++) {
      const a = 0.05 + rand() * 0.1;
      ctx.fillStyle = rand() > 0.5 ? `rgba(255,240,210,${a})` : `rgba(60,35,20,${a})`;
      const r = 1 + rand() * 3;
      ctx.beginPath();
      ctx.arc(rand() * size, rand() * size, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

/** Trigger a browser download for exported bytes/text. */
/*
 * THROUGH MAIN, NOT AN `<a download>`. In Electron a download link lands in
 * ~/Downloads with no panel and no word — the studio's Export "did nothing"
 * (the user, 2026-09-14: "send to and export buttons should be functional and
 * work"). Export goes through the save panel; Send To writes the file under
 * ~/Bobble/generated/3d and opens it in the chosen app. Either way the person
 * is told where it went, in the studio's own status line.
 */
async function deliverBytes(
  data: BlobPart,
  fileName: string,
  deliver: ViewerExportRequest['deliver'],
): Promise<void> {
  const blob = new Blob([data]);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  const base64 = btoa(binary);
  const note = useTripoStore.getState().setDeliveryNote;
  try {
    if (deliver?.kind === 'sendTo') {
      const res = await window.piDesktop.invoke('canvas:send-bytes-to', {
        base64,
        fileName,
        app: deliver.app,
      });
      note(
        res.ok
          ? `Opened in ${deliver.app} — ${res.savedTo ?? fileName}`
          : (res.error ?? `${deliver.app} could not open it`),
      );
    } else {
      const res = await window.piDesktop.invoke('canvas:save-bytes', {
        base64,
        suggestedName: fileName,
      });
      if (res.ok) note(`Saved ${res.savedTo ?? fileName}`);
      else if (res.error !== undefined) note(res.error);
    }
  } catch (err) {
    note(err instanceof Error ? err.message : String(err));
  }
}

/**
 * Quad topology recorded by the retopo worker in `meshes[].extras.pd_topology`.
 * glTF stores triangles ONLY, so a retopologised mesh would otherwise read as
 * "Triangle" in the viewer even though AutoRemesher produced quads. The worker
 * ships the real polygon counts plus the polygon-boundary edge list, which is
 * what a quad wireframe must draw (triangulation adds diagonals that are not
 * real topology).
 */
export interface PdTopology {
  /** `tri` is the quick low-poly: the input's own triangles, thinned. */
  readonly kind: 'quad' | 'mixed' | 'tri';
  readonly quads: number;
  readonly tris: number;
  readonly ngons: number;
  readonly polygons: number;
  readonly vertices: number;
  readonly watertight?: boolean;
  readonly wireEdges?: readonly number[];
}

function readPdTopology(root: InstanceType<typeof THREE.Object3D>): PdTopology | null {
  let found: PdTopology | null = null;
  root.traverse((obj) => {
    if (found !== null) return;
    const raw = (obj.userData as { pd_topology?: unknown }).pd_topology;
    if (raw !== undefined && raw !== null && typeof raw === 'object') {
      const t = raw as PdTopology;
      if (typeof t.quads === 'number' && typeof t.polygons === 'number') found = t;
    }
  });
  return found;
}

/** Minimal shape of the GLTFLoader.parse result we consume. */
interface LoadedGLTF {
  readonly scene: InstanceType<typeof THREE.Group>;
  readonly animations: InstanceType<typeof THREE.AnimationClip>[];
}

export interface Viewer3DProps {
  /** The axis-gizmo DOM to keep in sync (elements tagged data-ax / data-axline). */
  readonly gizmoRef: React.RefObject<HTMLDivElement | null>;
}

/** The stat line's word for a remeshed topology: quads, a mix, or — the quick
 * low-poly's case — triangles again. `kind` comes from the engine's record. */
function topologyLabel(kind: string): string {
  if (kind === 'quad') return 'Quad';
  if (kind === 'tri') return 'Triangle';
  return 'Quad + tri';
}

export default function Viewer3D({ gizmoRef }: Viewer3DProps): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;

    // ── renderer (Metal / WebGL quality pass) ───────────────────────────────
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    host.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
    camera.position.set(2.9, 1.35, 4.6);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.target.set(0, 0.0, 0);

    const pmrem = new THREE.PMREMGenerator(renderer);
    const envTexture = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

    // Studio rig: hemisphere fill + shadow-casting warm key + cool rim.
    const hemi = new THREE.HemisphereLight(0xffffff, 0x222222, 0.5);
    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(3.2, 5.2, 3);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.near = 0.5;
    key.shadow.camera.far = 22;
    key.shadow.camera.left = -3.2;
    key.shadow.camera.right = 3.2;
    key.shadow.camera.top = 3.2;
    key.shadow.camera.bottom = -3.2;
    key.shadow.bias = -0.0006;
    key.shadow.radius = 3;
    const rim = new THREE.DirectionalLight(0xffffff, 1.1);
    rim.position.set(-3.5, 2.5, -3);
    scene.add(hemi, key, rim);

    // Ground: a shadow-catcher disc + a toggleable grid.
    const ground = new THREE.Mesh(
      new THREE.CircleGeometry(7, 64),
      new THREE.ShadowMaterial({ opacity: 0.3 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = GROUND_Y;
    ground.receiveShadow = true;
    scene.add(ground);

    const grid = new THREE.GridHelper(10, 20);
    grid.position.y = GROUND_Y;
    scene.add(grid);

    // Off-screen rig for asset-tile previews — see captureThumb.
    const thumbTarget = new THREE.WebGLRenderTarget(THUMB_RENDER, THUMB_RENDER);
    const thumbCam = new THREE.PerspectiveCamera(32, 1, 0.1, 100);

    // Retopo quad-wire overlay for the SAMPLE (bind pose).
    const quadWire = buildQuadWire();
    quadWire.visible = false;
    scene.add(quadWire);

    // ── shared materials for the render modes ───────────────────────────────
    // EVERY studio material is DOUBLE-SIDED.
    //
    // three.js culls back faces by default, and generated meshes always carry
    // some inconsistently-wound triangles (marching cubes emits them, and
    // quadric decimation flips more). Each one then renders as a hole onto the
    // dark background, so the model looks shot through with black specks — what
    // the user has been calling the debris issue. It is NOT debris: the same preview
    // file measured 99.7% one connected component and renders perfectly clean in
    // an offline double-sided renderer. Showing the back of a triangle is the
    // right call for a modelling viewport anyway; showing the void is not.
    const normalMat = new THREE.MeshNormalMaterial({ side: THREE.DoubleSide });
    // Clay is a FIXED warm white/grey (the user) — never theme-resolved, so it can't
    // go dark in dark mode.
    const clayMat = new THREE.MeshStandardMaterial({
      color: '#d9d9de',
      metalness: 0.02,
      roughness: 0.85,
      side: THREE.DoubleSide,
    });
    // The wireframe TOGGLE overlay: edge lines drawn ON TOP of the active mode
    // (a second skinned/static pass per mesh — see ensureWireOverlay).
    const wireOverlayMat = new THREE.MeshBasicMaterial({
      wireframe: true,
      transparent: true,
      opacity: 0.4,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    });
    const segMat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.6,
      side: THREE.DoubleSide,
    });
    const generatedTexture = buildGeneratedTexture();
    const texMat = new THREE.MeshStandardMaterial({
      roughness: 0.55,
      metalness: 0.05,
      side: THREE.DoubleSide,
    });
    // Assets whose texture stage has run — Textured mode maps only those.
    const texturedAssets = new Set<string>();
    // Geometries already painted with segment colors.
    const segPainted = new WeakSet<object>();

    // Wireframe overlay clones: a second mesh sharing geometry (and, for
    // skinned bodies, the SAME skeleton — so the overlay tracks animation)
    // rendered with the wire material on top of the base surface.
    const wireOverlays = new Map<
      InstanceType<typeof THREE.Mesh>,
      InstanceType<typeof THREE.Mesh>
    >();
    const ensureWireOverlay = (
      mesh: InstanceType<typeof THREE.Mesh>,
    ): InstanceType<typeof THREE.Mesh> => {
      const existing = wireOverlays.get(mesh);
      if (existing !== undefined) return existing;
      const skinned = mesh as InstanceType<typeof THREE.SkinnedMesh>;
      let overlay: InstanceType<typeof THREE.Mesh>;
      if (skinned.isSkinnedMesh === true) {
        const so = new THREE.SkinnedMesh(mesh.geometry, wireOverlayMat);
        so.bind(skinned.skeleton, skinned.bindMatrix);
        overlay = so;
      } else {
        overlay = new THREE.Mesh(mesh.geometry, wireOverlayMat);
      }
      overlay.frustumCulled = false;
      overlay.renderOrder = 5;
      overlay.visible = false;
      mesh.add(overlay);
      wireOverlays.set(mesh, overlay);
      return overlay;
    };

    // ── pipeline models ─────────────────────────────────────────────────────
    interface BodyRef {
      readonly mesh: InstanceType<typeof THREE.Mesh>;
    }
    /**
     * The material a loaded file brought with it, per mesh.
     *
     * TRELLIS bakes real PBR — baseColorTexture, metallicRoughnessTexture (with
     * roughness in G and metallic in B) and alphaMode BLEND, i.e. the user's four
     * channels: "Base Color, Roughness, Metallic, and Opacity". Textured mode
     * used to throw all of that away and paint a procedural stand-in left over
     * from the demo build, so the bake was invisible no matter how well it ran.
     * Keep the originals so Textured mode can show what was actually baked, and
     * fall back to the stand-in only for models that carry no maps at all.
     */
    const originalMaterials = new WeakMap<
      InstanceType<typeof THREE.Mesh>,
      InstanceType<typeof THREE.Material>
    >();
    let meshModel: InstanceType<typeof THREE.Group> | null = null;
    let rigModel: InstanceType<typeof THREE.Group> | null = null;
    let skinned: InstanceType<typeof THREE.SkinnedMesh> | null = null;
    let skeletonHelper: InstanceType<typeof THREE.SkeletonHelper> | null = null;
    let mixer: InstanceType<typeof THREE.AnimationMixer> | null = null;
    const actions = new Map<string, InstanceType<typeof THREE.AnimationAction>>();
    const meshBodies: BodyRef[] = [];
    const rigBodies: BodyRef[] = [];
    const boneJoints: InstanceType<typeof THREE.Mesh>[] = [];
    let heroLoaded = false;
    let disposed = false;

    // Imported (drag-and-drop / upload) model currently in the scene.
    let importedGroup: InstanceType<typeof THREE.Group> | null = null;
    let importedWire: InstanceType<typeof THREE.LineSegments> | null = null;
    /** Bones of the USER's model. The SkeletonHelper further up is bound to the
     * bundled sample rig and never showed anything for an imported or generated
     * one — so a real rig was invisible in the app that produced it. */
    let importedSkeleton: InstanceType<typeof THREE.SkeletonHelper> | null = null;
    /** Drives clips that arrived with the USER's model. Separate from `mixer`,
     * which belongs to the bundled sample rig. */
    let importedMixer: InstanceType<typeof THREE.AnimationMixer> | null = null;
    let importedId: string | null = null;
    /** Quad topology of the loaded asset (retopo results only). */
    let importedTopology: PdTopology | null = null;
    /** Which asset the current wireframe belongs to (null = not built yet). */
    let wireBuiltFor: string | null = null;
    /**
     * The asset whose load is IN FLIGHT.
     *
     * applyState runs on every store change and kicks off loadImported whenever
     * `assetId !== importedId` — but importedId is only assigned after the
     * await completes, so every store write during a slow parse started ANOTHER
     * parse of the same file. On a large mesh that turns one slow load into an
     * unbounded pile-up of them, which is what wedged the window.
     */
    let loadingId: string | null = null;
    const importedBodies: BodyRef[] = [];

    /**
     * Release everything an object tree owns on the GPU.
     *
     * Swapping models only ever did scene.remove(), so every asset and every
     * version switch leaked its geometries, materials and textures for the life
     * of the session — unbounded growth in both the renderer heap and GPU
     * memory, and a dead renderer looks exactly like the blank window the user
     * hit. three.js never does this for you.
     */
    const disposeTree = (root: InstanceType<typeof THREE.Object3D> | null): void => {
      if (root === null) return;
      root.traverse((obj) => {
        const mesh = obj as InstanceType<typeof THREE.Mesh>;
        mesh.geometry?.dispose?.();
        const mat = mesh.material;
        // Shared studio materials (clay/normal/seg/tex) are disposed at unmount
        // — only dispose the ones that came in with the file.
        const owned = (m: InstanceType<typeof THREE.Material>) => {
          if (m === clayMat || m === normalMat || m === segMat || m === texMat) return;
          if (m === wireOverlayMat) return;
          for (const key of Object.keys(m) as (keyof typeof m)[]) {
            const value = m[key] as unknown;
            if (value !== null && typeof value === 'object' && 'isTexture' in value) {
              (value as InstanceType<typeof THREE.Texture>).dispose();
            }
          }
          m.dispose();
        };
        if (Array.isArray(mat)) for (const m of mat) owned(m);
        else if (mat != null) owned(mat as InstanceType<typeof THREE.Material>);
        // The file's own material is only ON the mesh in Textured mode; in every
        // other mode a shared studio material has replaced it and the original —
        // which owns the baked texture images — would go unreleased.
        const original = originalMaterials.get(mesh);
        if (original !== undefined && original !== mat) owned(original);
      });
    };

    /**
     * Build the model's REAL edge wireframe, on first need only.
     *
     * When the asset carries quad topology we draw the POLYGON edges the
     * remesher produced (a cheap buffer fill); otherwise three's
     * WireframeGeometry, which de-duplicates every triangle edge and is the
     * expensive path — hence "on demand", not "on load".
     */
    const buildWireOverlay = (id: string): void => {
      if (wireBuiltFor === id || importedBodies.length === 0) return;
      wireBuiltFor = id;
      const wires = new THREE.Group();
      const quadEdges = importedTopology?.wireEdges;
      for (const { mesh } of importedBodies) {
        const wireMat = new THREE.LineBasicMaterial({ transparent: true, opacity: 0.85 });
        let seg: InstanceType<typeof THREE.LineSegments>;
        if (quadEdges !== undefined && quadEdges.length > 0 && importedBodies.length === 1) {
          const pos = mesh.geometry.getAttribute('position');
          const pts = new Float32Array(quadEdges.length * 3);
          for (let i = 0; i < quadEdges.length; i++) {
            const v = quadEdges[i] ?? 0;
            if (v >= pos.count) continue;
            pts[i * 3] = pos.getX(v);
            pts[i * 3 + 1] = pos.getY(v);
            pts[i * 3 + 2] = pos.getZ(v);
          }
          const geo = new THREE.BufferGeometry();
          geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
          seg = new THREE.LineSegments(geo, wireMat);
        } else {
          seg = new THREE.LineSegments(new THREE.WireframeGeometry(mesh.geometry), wireMat);
        }
        mesh.updateWorldMatrix(true, false);
        seg.applyMatrix4(mesh.matrixWorld);
        wires.add(seg);
      }
      importedWire = wires as unknown as InstanceType<typeof THREE.LineSegments>;
      scene.add(importedWire);
      applyPalette();
    };

    // Thumbnail capture queue: asset ids whose real preview is still pending.
    let pendingThumb: string | null = null;

    const collectBodies = (
      root: InstanceType<typeof THREE.Group>,
      into: BodyRef[],
      filter?: (m: InstanceType<typeof THREE.Mesh>) => boolean,
    ) => {
      root.traverse((o) => {
        const mesh = o as InstanceType<typeof THREE.Mesh>;
        if (mesh.isMesh === true) {
          mesh.castShadow = true;
          mesh.frustumCulled = false; // skinned bones can push verts past the bbox
          if (filter === undefined || filter(mesh)) into.push({ mesh });
        }
      });
    };

    const loader = new GLTFLoader();
    const parseGlb = (data: ArrayBuffer | string): Promise<LoadedGLTF> =>
      new Promise((resolve, reject) =>
        loader.parse(data, '', (g) => resolve(g as unknown as LoadedGLTF), reject),
      );

    void Promise.all([
      parseGlb(base64ToArrayBuffer(HERO_MESH_GLB_B64)),
      parseGlb(base64ToArrayBuffer(HERO_RIG_GLB_B64)),
    ]).then(([meshGltf, rigGltf]) => {
      if (disposed) return;
      meshModel = meshGltf.scene;
      collectBodies(meshModel, meshBodies, (m) => m.name.startsWith('wyrm'));
      meshModel.visible = false;
      scene.add(meshModel);

      rigModel = rigGltf.scene;
      collectBodies(rigModel, rigBodies, (m) => m.name.startsWith('wyrm'));
      rigModel.visible = false;
      rigModel.traverse((o) => {
        const sm = o as InstanceType<typeof THREE.SkinnedMesh>;
        if (sm.isSkinnedMesh === true) skinned = sm;
      });
      scene.add(rigModel);

      skeletonHelper = new THREE.SkeletonHelper(rigModel);
      skeletonHelper.visible = false;
      scene.add(skeletonHelper);

      mixer = new THREE.AnimationMixer(rigModel);
      for (const clip of rigGltf.animations) {
        actions.set(clip.name, mixer.clipAction(clip));
      }

      if (skinned !== null) {
        const jointGeo = new THREE.SphereGeometry(0.055, 14, 12);
        for (const bone of skinned.skeleton.bones) {
          const bead = new THREE.Mesh(
            jointGeo,
            new THREE.MeshBasicMaterial({ depthTest: false, transparent: true }),
          );
          bead.renderOrder = 10;
          bead.frustumCulled = false;
          bead.visible = false;
          bone.add(bead);
          boneJoints.push(bead);
        }
      }

      heroLoaded = true;
      applyState();
    });

    /** Load an imported (registry) asset into the scene, replacing the last. */
    const loadImported = async (id: string): Promise<void> => {
      if (loadingId === id) return; // already parsing this one — see loadingId
      loadingId = id;
      // May be a re-read: the registry is bounded, and a tree restored from a
      // previous session never had these bytes in the first place.
      const s0 = useTripoStore.getState();
      const meta = s0.assets.flatMap((a) => a.versions).find((v) => v.id === id);
      const entry = await ensureModelBytes(id, meta?.diskPath);
      if (entry === undefined || disposed) {
        loadingId = null;
        return;
      }
      let group: InstanceType<typeof THREE.Group> | null = null;
      /** Clips that came in WITH this model — a generated motion lives here. */
      let clips: InstanceType<typeof THREE.AnimationClip>[] = [];
      try {
        if (entry.format === 'glb' || entry.format === 'gltf') {
          const parsed = await parseGlb(entry.buffer);
          group = parsed.scene;
          // Previously only `.scene` was taken and the clips were dropped on the
          // floor, so a model the motion stage had just animated loaded as a
          // statue: the ONE mixer in this file is bound to the bundled sample
          // rig, and an imported or generated model never got one at all.
          clips = parsed.animations ?? [];
        } else if (entry.format === 'obj') {
          const text = new TextDecoder().decode(entry.buffer);
          group = new OBJLoader().parse(text) as InstanceType<typeof THREE.Group>;
        } else {
          const geo = new STLLoader().parse(entry.buffer);
          geo.computeVertexNormals();
          const mesh = new THREE.Mesh(geo, clayMat);
          group = new THREE.Group();
          group.add(mesh);
        }
      } catch {
        loadingId = null;
        return; // unreadable file — leave the current scene as-is
      }
      if (disposed || group === null) {
        loadingId = null;
        return;
      }
      if (importedGroup !== null) {
        scene.remove(importedGroup);
        disposeTree(importedGroup);
      }
      if (importedWire !== null) {
        scene.remove(importedWire);
        disposeTree(importedWire);
      }
      if (importedMixer !== null) {
        importedMixer.stopAllAction();
        importedMixer = null;
      }
      if (importedSkeleton !== null) {
        scene.remove(importedSkeleton);
        importedSkeleton.dispose();
        importedSkeleton = null;
      }
      // The wireframe-overlay clones share the outgoing geometry, so they must
      // go with it rather than linger pointing at disposed buffers.
      for (const [, overlay] of wireOverlays) scene.remove(overlay);
      wireOverlays.clear();
      importedBodies.length = 0;

      // Normalize: fit to a ~2.6-unit height, feet on the ground plane.
      const bb = new THREE.Box3().setFromObject(group);
      const size = bb.getSize(new THREE.Vector3());
      const scale = 2.6 / Math.max(size.x, size.y, size.z, 1e-6);
      group.scale.setScalar(scale);
      const bb2 = new THREE.Box3().setFromObject(group);
      const center = bb2.getCenter(new THREE.Vector3());
      group.position.x -= center.x;
      group.position.z -= center.z;
      group.position.y -= bb2.min.y - GROUND_Y;

      collectBodies(group, importedBodies);
      // A mesh with no NORMAL attribute renders BLACK under a standard material
      // — there is nothing to light. AutoRemesher's OBJ has none, and plenty of
      // user files don't either, so compute them rather than trusting the file.
      // Per index is enough — generated-mesh.ts says why per position was
      // tried and measured as no better (the user: "recalculate / smooth normals
      // help?").
      for (const { mesh } of importedBodies) {
        if (mesh.geometry.getAttribute('normal') === undefined) {
          mesh.geometry.computeVertexNormals();
        }
        // A SKINNED mesh is culled against its BIND pose's bounds, which the
        // clip's own pose can reach outside of — so a character standing at the
        // edge of the view pops out of existence while part of it is still on
        // screen. The bundled rig path already opts out for this reason; an
        // imported model is how a generated motion comes back in, so it needs
        // the same. (This is NOT why a travelling clip leaves the frame: a
        // typed prompt keeps its root motion by design, and a walk simply walks
        // away. Presets pin the root instead — see AnimatePanel.runMotion.)
        if ((mesh as { isSkinnedMesh?: boolean }).isSkinnedMesh === true) {
          mesh.frustumCulled = false;
        }
        // Stash the file's own material before the render mode overwrites it,
        // and make it double-sided for the same reason the studio materials are.
        const own = mesh.material;
        if (!Array.isArray(own)) {
          own.side = THREE.DoubleSide;
          disableMipmaps(own);
          originalMaterials.set(mesh, own);
        }
      }
      // Quad topology the retopo worker recorded on the GLB, if this asset is a
      // retopology result (glTF itself can only carry triangles).
      importedTopology = readPdTopology(group);

      // The edge wireframe is built LAZILY — see buildWireOverlay. Constructing
      // it here blocked the renderer for a MEASURED 1,558 ms on a 20 MB / 190k
      // triangle TRELLIS result, which is the freeze the user hits mid-run when
      // geometry lands while texturing continues. It is only ever visible in
      // the retopo view, so it must not sit between the model and the screen.
      importedWire = null;
      wireBuiltFor = null;

      importedGroup = group;
      importedId = id;
      scene.add(group);
      // The clear part of the canvas is what this model must fit — see resize().
      resize();

      // Play what it came with, on loop, straight away. A generated clip is the
      // whole point of the motion stage, and asking the user to find a play
      // control for it would be asking them to prove it worked.
      // (the previous model's mixer was already stopped in the teardown above)
      // `clips[0]` is only undefined if the array is empty, but the index
      // signature does not know that — and bailing out of the whole loader on it
      // would skip the thumbnail and leave `loadingId` latched forever.
      const first = clips[0];
      travelTracking = null;
      if (first !== undefined) {
        importedMixer = new THREE.AnimationMixer(group);
        const action = importedMixer.clipAction(first);
        action.setLoop(THREE.LoopRepeat, Number.POSITIVE_INFINITY);
        action.play();
        // Follow the node the clip actually translates — the root bone, whose
        // name is the rig's business, not this file's. Taking the first
        // translated node keeps this working for a skeleton we did not author.
        const moved = first.tracks.find((t) => t.name.endsWith('.position'));
        const rootName = moved?.name.slice(0, -'.position'.length);
        travelTracking = rootName === undefined ? null : (group.getObjectByName(rootName) ?? null);
        if (travelTracking !== null) travelTracking.getWorldPosition(travelPrev);
      }

      // Skeleton overlay, when this model actually carries one. SkeletonHelper
      // walks the object's bone hierarchy, so it follows the rig's real joint
      // positions rather than anything reconstructed here — and it tracks the
      // bind pose the same way the mesh does. depthTest off so the bones read
      // THROUGH the surface; a skeleton hidden inside an opaque body is the
      // same as no skeleton at all.
      const hasSkin = (() => {
        let found = false;
        group.traverse((o) => {
          if ((o as { isSkinnedMesh?: boolean }).isSkinnedMesh === true) found = true;
        });
        return found;
      })();
      if (hasSkin) {
        const helper = new THREE.SkeletonHelper(group);
        const mat = helper.material as InstanceType<typeof THREE.LineBasicMaterial>;
        mat.depthTest = false;
        mat.transparent = true;
        mat.linewidth = 2;
        helper.renderOrder = 999;
        helper.visible = useTripoStore.getState().showSkeleton;
        importedSkeleton = helper;
        scene.add(helper);
      }
      useTripoStore.getState().set('hasSkeleton', hasSkin);

      /*
       * A FILE THAT ARRIVES RIGGED IS RIGGED.
       *
       * `rigged` was only ever set by the rig STAGE, so importing a model that
       * already carries a skeleton — including one this studio exported five
       * minutes earlier — left the Animate panel offering to rig it and hiding
       * the whole motion library. The skeleton is right there in the file; not
       * believing it is the odd position.
       *
       * `humanoid` is decided by the joint NAMES rather than by re-measuring the
       * mesh: the preset motions and ARDY both address cskel27 by name, so a rig
       * that answers to those names is one they can drive, and a rig that does
       * not (the medial rigger's joint_00…joint_17) is honestly not humanoid for
       * this purpose whatever its shape.
       */
      if (hasSkin) {
        const named = new Set<string>();
        group.traverse((o) => {
          if (o.name !== '') named.add(o.name);
        });
        const CSKEL_MARKERS = ['Hips', 'Spine', 'Head', 'LeftArm', 'RightArm', 'LeftUpLeg'];
        const looksHumanoid = CSKEL_MARKERS.every(
          (n) => named.has(n) || named.has(`mixamorig${n}`),
        );
        useTripoStore.getState().markLoadedRigged(looksHumanoid);
      }

      // Real counts → asset row + (via applyState) the stats readout.
      let faces = 0;
      let verts = 0;
      for (const { mesh } of importedBodies) {
        const g = mesh.geometry;
        faces += Math.floor(
          (g.index !== null ? g.index.count : g.getAttribute('position').count) / 3,
        );
        verts += g.getAttribute('position').count;
      }
      useTripoStore
        .getState()
        .setAssetCounts(
          id,
          importedTopology !== null ? importedTopology.polygons : faces,
          importedTopology !== null ? importedTopology.vertices : verts,
          importedTopology !== null ? topologyLabel(importedTopology.kind) : 'Triangle',
        );
      pendingThumb = id;
      loadingId = null;
      applyState();
    };

    // ── real export (three exporters) ───────────────────────────────────────
    const exportRoot = (): InstanceType<typeof THREE.Object3D> | null => {
      // Every loaded asset is a real imported/generated model now.
      return importedGroup;
    };
    const onExport = (req: ViewerExportRequest): void => {
      const root = exportRoot();
      if (root === null) return;
      const base = req.fileName.replace(/\.[a-z0-9]+$/i, '');
      const deliver = req.deliver;
      if (req.format === 'GLB') {
        new GLTFExporter().parse(
          root,
          (out) => {
            if (out instanceof ArrayBuffer) void deliverBytes(out, `${base}.glb`, deliver);
            else void deliverBytes(JSON.stringify(out), `${base}.gltf`, deliver);
          },
          () => {},
          { binary: true },
        );
      } else if (req.format === 'OBJ') {
        void deliverBytes(new OBJExporter().parse(root), `${base}.obj`, deliver);
      } else if (req.format === 'STL') {
        const out = new STLExporter().parse(root, { binary: true });
        void deliverBytes(out as unknown as BlobPart, `${base}.stl`, deliver);
      } else {
        void (async () => {
          const out = await new USDZExporter().parseAsync(root);
          void deliverBytes(out as unknown as BlobPart, `${base}.usdz`, deliver);
        })();
      }
      host.dataset.tpExported = `${base}.${req.format.toLowerCase()}`;
    };
    setViewerExportHandler(onExport);

    /**
     * Play a bundled preset on the loaded model, immediately.
     *
     * The clip is built against THIS model's bones (see preset-motions), so it
     * is the rig in the viewport that gets animated rather than a generic one,
     * and it costs a clip construction rather than an ARDY run. Returns false
     * when there is nothing rigged to play it on, so the panel can say so
     * instead of appearing to have ignored the click.
     */
    const onPresetMotion = (presetId: string): boolean => {
      if (importedGroup === null) return false;
      const clip = buildPresetClip(presetId, importedGroup);
      if (clip === null) return false;
      // Replace whatever was playing — a generated clip and a preset are two
      // answers to the same question, so they must not blend into each other.
      if (importedMixer !== null) importedMixer.stopAllAction();
      importedMixer = new THREE.AnimationMixer(importedGroup);
      const action = importedMixer.clipAction(clip);
      action.setLoop(THREE.LoopRepeat, Number.POSITIVE_INFINITY);
      action.play();
      // A preset performs where it stands, so nothing for the camera to follow.
      travelTracking = null;
      return true;
    };
    setPresetMotionHandler(onPresetMotion);

    /** Re-resolve every themed color (mount, store change, theme flip). Clay
     * deliberately stays FIXED white/grey (set at construction). */
    const applyPalette = () => {
      wireOverlayMat.color.set(resolveColor('var(--pd-accent-primary)'));
      texMat.color.set('#ffffff');

      const gm = grid.material as InstanceType<typeof THREE.LineBasicMaterial>;
      gm.color.set(resolveColor('var(--pd-border-strong)'));
      gm.transparent = true;
      gm.opacity = 0.5;
      const qm = quadWire.material as InstanceType<typeof THREE.LineBasicMaterial>;
      qm.color.set(resolveColor('var(--pd-accent-primary)'));
      if (importedWire !== null) {
        importedWire.traverse((o) => {
          const line = o as InstanceType<typeof THREE.LineSegments>;
          if (
            line.isLine === true ||
            (line as { isLineSegments?: boolean }).isLineSegments === true
          ) {
            (line.material as InstanceType<typeof THREE.LineBasicMaterial>).color.set(
              resolveColor('var(--pd-accent-primary)'),
            );
          }
        });
      }
      if (skeletonHelper !== null) {
        (skeletonHelper.material as InstanceType<typeof THREE.LineBasicMaterial>).color.set(
          resolveColor('var(--pd-accent-primary)'),
        );
      }
      const accent = resolveColor('var(--pd-accent-primary)');
      for (const bead of boneJoints) {
        (bead.material as InstanceType<typeof THREE.MeshBasicMaterial>).color.set(accent);
      }
      hemi.color.set(resolveColor('var(--pd-text-primary)'));
      hemi.groundColor.set(resolveColor('var(--pd-bg-inset)'));
    };

    /** The render-mode material for non-segment stages. */
    const modeMaterial = (assetId: string): InstanceType<typeof THREE.Material> => {
      const s = useTripoStore.getState();
      switch (s.renderMode) {
        case 'normal':
          return normalMat;
        case 'textured':
          texMat.map = texturedAssets.has(assetId) ? generatedTexture : null;
          texMat.needsUpdate = true;
          return texMat;
        default:
          return clayMat;
      }
    };

    /** Push the store's viewer + pipeline state into the scene. There is no
     * bundled placeholder anymore — the viewer only ever shows the real loaded
     * asset (imported file or engine artifact); the procedural hero objects are
     * kept in the scene but never made visible. */
    const applyState = () => {
      const s = useTripoStore.getState();
      const stage = s.pipelineStage;
      // The user's own rig, drawn over the model when they ask for it.
      if (importedSkeleton !== null) importedSkeleton.visible = s.showSkeleton;
      // The viewer renders the ACTIVE VERSION: the asset's working version, or
      // an older node the user is inspecting from the history tree.
      const assetId = s.activeVersionId();
      if (assetId === null) return;

      // The loaded asset is loaded lazily on first selection.
      if (assetId !== importedId) {
        void loadImported(assetId);
      }

      // The texture stage marks this asset as textured (Textured mode maps it).
      if (stage === 'texture') texturedAssets.add(assetId);

      // Only the real model is ever on screen; the hero objects stay hidden.
      const showImported = importedId === assetId;
      if (importedGroup !== null) importedGroup.visible = showImported && s.meshVisible;
      // Only the retopo view shows the edge wireframe — build it the first time
      // it is actually asked for, never on the model's critical path.
      const wantWire = showImported && stage === 'retopo' && s.meshVisible;
      if (wantWire && importedId !== null) buildWireOverlay(importedId);
      if (importedWire !== null) importedWire.visible = wantWire;
      if (meshModel !== null) meshModel.visible = false;
      if (rigModel !== null) rigModel.visible = false;
      quadWire.visible = false;
      if (skeletonHelper !== null) skeletonHelper.visible = false;
      for (const bead of boneJoints) bead.visible = false;

      // Materials: segment stage paints vertex-color parts; other stages follow
      // the render mode. All on the real loaded bodies.
      const activeBodies = importedBodies;
      if (stage === 'segment') {
        /*
         * A REAL CubePart result is one named mesh per part, each carrying its
         * own COLOR_0 (verified on a run's parts.glb: nodes
         * part_00_main_body … part_04_right_part, every primitive
         * [POSITION, COLOR_0], no materials). Use those.
         *
         * The demo path below — three height bands and a hardcoded
         * ['Top','Middle','Base'] — is the bundled-sample behaviour, and
         * repainting it over a genuine five-part segmentation would throw the
         * engine's answer away and then mislabel it.
         */
        const engineParts = activeBodies
          .map(({ mesh }) => /^part_(\d+)_(.+)$/.exec(mesh.name))
          .filter((m): m is RegExpExecArray => m !== null);
        const fromEngine = engineParts.length > 0 && engineParts.length === activeBodies.length;
        for (const { mesh } of activeBodies) {
          if (!fromEngine && !segPainted.has(mesh.geometry)) {
            paintSegmentColors(mesh.geometry);
            segPainted.add(mesh.geometry);
          }
          mesh.material = segMat; // vertexColors: true — reads COLOR_0 as-is
        }
        const parts = fromEngine
          ? engineParts.map((m) =>
              (m[2] ?? '').replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()),
            )
          : ['Top', 'Middle', 'Base'];
        // Compared by VALUE: the old length check could not see one 3-part list
        // replaced by a different 3-part list.
        if (s.segmentParts.join('|') !== parts.join('|')) {
          useTripoStore.getState().set('segmentParts', parts);
        }
      } else if (s.renderMode === 'textured') {
        // Show the maps the file actually carries; only models with none fall
        // back to the procedural stand-in.
        const fallback = modeMaterial(assetId);
        for (const { mesh } of activeBodies) {
          const own = originalMaterials.get(mesh);
          if (own !== undefined && hasTextureMaps(own)) {
            mesh.material = own;
          } else if (mesh.geometry.getAttribute('color') != null) {
            // The file carries COLOR_0 — a segment run's parts.glb is the case
            // that matters. Painting the flat fallback over it renders the whole
            // thing white and throws away colour the file actually has, which
            // reads as "the stage produced one undifferentiated blob".
            mesh.material = segMat;
          } else {
            mesh.material = fallback;
          }
        }
      } else {
        const mat = modeMaterial(assetId);
        for (const { mesh } of activeBodies) mesh.material = mat;
      }

      // Wireframe TOGGLE: edge overlay on top of whatever mode is active, on
      // the currently-visible bodies only.
      for (const [, overlay] of wireOverlays) overlay.visible = false;
      if (s.wireframe) {
        for (const { mesh } of activeBodies) ensureWireOverlay(mesh).visible = true;
      }

      // Real topology stats for what is on screen. A retopology result carries
      // its true polygon counts on the GLB (glTF triangulates on the way in), so
      // report THOSE rather than the triangulated stand-in.
      let faces = 0;
      let verts = 0;
      for (const { mesh } of activeBodies) {
        const g = mesh.geometry;
        faces += Math.floor(
          (g.index !== null ? g.index.count : g.getAttribute('position').count) / 3,
        );
        verts += g.getAttribute('position').count;
      }
      const topo = importedId === assetId ? importedTopology : null;
      const stats =
        topo !== null
          ? {
              topology: topologyLabel(topo.kind),
              faces: topo.polygons,
              vertices: topo.vertices,
            }
          : { topology: 'Triangle', faces, vertices: verts };
      const prev = s.stats;
      if (prev === null || prev.faces !== stats.faces || prev.topology !== stats.topology) {
        useTripoStore.getState().set('stats', stats);
      }

      // No hero mixer runs anymore; keep the (hidden) skeleton at its bind pose.
      if (mixer !== null) mixer.stopAllAction();
      if (skinned !== null) skinned.skeleton.pose();

      grid.visible = s.showGrid;
      controls.autoRotate = s.autoRotate;
      controls.autoRotateSpeed = 2.4;
      const intensity = s.lightIntensity / 60; // slider 0..100, 60 = neutral
      key.intensity = 2.2 * intensity;
      rim.intensity = 1.1 * intensity;
      hemi.intensity = 0.5 * Math.max(intensity, 0.25);
      scene.environment = s.envLight ? envTexture : null;

      host.dataset.tpStage = stage;
      host.dataset.tpRenderMode = s.renderMode;
      host.dataset.tpWireframe = s.wireframe ? '1' : '0';
      host.dataset.tpSkeleton = skeletonHelper?.visible === true ? '1' : '0';
      host.dataset.tpAnim = 'none';
      applyPalette();
    };
    applyState();

    const unsubscribe = useTripoStore.subscribe(applyState);

    const themeObserver = new MutationObserver(applyPalette);
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-flavor', 'data-mode'],
    });

    const resize = () => {
      const w = host.clientWidth;
      const h = host.clientHeight;
      if (w === 0 || h === 0) return;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      /*
       * THE CARD IS OVER THE LEFT OF THIS CANVAS. The left panel floats on
       * the viewport (tripo.css .tp-genpanel), so the middle of the canvas is
       * not the middle of what can be seen. The view offset slides the
       * projection right by half the card, so the model sits in the centre
       * of the clear part — the same trick DCC apps use for docked panels.
       * LOOKED AT (2026-09-16): the offset had never applied — the card is
       * the viewport's sibling and was being looked for under the canvas's
       * parent; the mannequin sat centred with its left half behind the card.
       */
      const covered = coveredLeft(host);
      if (covered > 0 && w > covered * 2) camera.setViewOffset(w, h, -covered / 2, 0, w, h);
      else camera.clearViewOffset();
      /*
       * …AND ZOOMED OUT TO FIT IT. Sliding the projection centres the model
       * in the clear part but leaves it the size a full canvas would give
       * it: LOOKED AT (2026-09-16, the mug at 2.6 units), a 400 px model in
       * a 410 px clear strip, its handle under the floating view controls on
       * the right. The model's bounding sphere is projected at the camera's
       * current distance and the zoom brought down until it fits the strip
       * with room for the controls. Never zoomed in: a small model on a wide
       * canvas stays the size the camera gives it.
       */
      camera.zoom = zoomToClear(w, h, covered);
      camera.updateProjectionMatrix();
    };
    const CLEAR_MARGIN_PX = 80; // the floating view controls + the card's fade
    const corner = new THREE.Vector3();
    const zoomToClear = (w: number, _h: number, covered: number): number => {
      if (importedGroup === null || covered <= 0) return 1;
      const box = new THREE.Box3().setFromObject(importedGroup);
      if (box.isEmpty()) return 1;
      // The box's eight corners on screen at zoom 1 — the model's real
      // width, not its bounding sphere's (a mug's sphere is its height, and
      // fitting THAT left it at half the strip). The offset does not move
      // the extent, only where it sits, so it is not cleared for the measure.
      camera.zoom = 1;
      camera.updateProjectionMatrix();
      let left = Number.POSITIVE_INFINITY;
      let right = Number.NEGATIVE_INFINITY;
      for (let i = 0; i < 8; i += 1) {
        corner.set(
          (i & 1) === 0 ? box.min.x : box.max.x,
          (i & 2) === 0 ? box.min.y : box.max.y,
          (i & 4) === 0 ? box.min.z : box.max.z,
        );
        corner.project(camera);
        if (corner.z > 1) return 1; // behind the camera: no measure to take
        const px = ((corner.x + 1) / 2) * w;
        left = Math.min(left, px);
        right = Math.max(right, px);
      }
      const modelPx = right - left;
      const room = w - covered - 2 * CLEAR_MARGIN_PX;
      if (!(modelPx > 0) || room <= 0) return 1;
      return Math.min(1, room / modelPx);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(host);
    /*
     * …AND THE CARD IS WATCHED TOO. The host's ResizeObserver only fires when
     * the CANVAS changes size; the floating card mounts after it, and swaps
     * width with the stage (Segmentation's card is not Model's). LOOKED AT
     * (2026-09-16, the fresh-cache probe's motion screenshot): the mannequin
     * centred on the canvas with its left half behind the card — the offset
     * measured at mount had found no card yet. So the card is observed once
     * it exists, and every stage swap re-measures.
     */
    let panelRo: ResizeObserver | null = null;
    const watchPanel = () => {
      const panel = floatingPanel(host);
      panelRo?.disconnect();
      panelRo = null;
      if (panel !== null) {
        panelRo = new ResizeObserver(resize);
        panelRo.observe(panel);
      }
      resize();
    };
    watchPanel();
    const panelObserver = new MutationObserver(watchPanel);
    const panelRoot = host.closest<HTMLElement>('.tp-body') ?? host.parentElement;
    if (panelRoot !== null) panelObserver.observe(panelRoot, { childList: true, subtree: true });

    // ── camera-synced axis gizmo ────────────────────────────────────────────
    const AXES: readonly {
      readonly id: string;
      readonly v: InstanceType<typeof THREE.Vector3>;
    }[] = [
      { id: 'x', v: new THREE.Vector3(1, 0, 0) },
      { id: 'y', v: new THREE.Vector3(0, 1, 0) },
      { id: 'z', v: new THREE.Vector3(0, 0, 1) },
      { id: '-x', v: new THREE.Vector3(-1, 0, 0) },
      { id: '-y', v: new THREE.Vector3(0, -1, 0) },
      { id: '-z', v: new THREE.Vector3(0, 0, -1) },
    ];
    const tmp = new THREE.Vector3();
    const q = new THREE.Quaternion();
    const syncGizmo = () => {
      const gizmo = gizmoRef.current;
      if (gizmo === null) return;
      const r = 26;
      camera.getWorldQuaternion(q).invert();
      for (const axis of AXES) {
        tmp.copy(axis.v).applyQuaternion(q);
        const el = gizmo.querySelector<HTMLElement>(`[data-ax="${axis.id}"]`);
        if (el !== null) {
          el.style.transform = `translate(${tmp.x * r}px, ${-tmp.y * r}px)`;
          el.style.zIndex = String(100 + Math.round(tmp.z * 50));
          el.style.opacity = axis.id.startsWith('-') ? String(0.35 + 0.3 * (tmp.z + 1) * 0.5) : '1';
        }
        const line = gizmo.querySelector<SVGLineElement>(`[data-axline="${axis.id}"]`);
        if (line !== null) {
          line.setAttribute('x2', String(38 + tmp.x * r));
          line.setAttribute('y2', String(38 - tmp.y * r));
        }
      }
    };

    /**
     * The asset's preview: a framed three-quarter isometric of the model,
     * rendered off-screen with its own camera.
     *
     * It used to be a centre-crop of whatever the user's camera happened to be
     * pointing at when the model landed, so a tile could be a close-up of a
     * wingtip, or the model half out of frame, and two assets shot from
     * different angles were hard to tell apart. the user: "it would be nice if the
     * thumbnails were full in frame isometric views."
     *
     * Rendering to a target rather than reading the canvas keeps this off the
     * visible frame entirely — the user's view never flinches when a capture
     * happens. The ground disc and grid are hidden for the shot so the framing
     * is the MODEL's bounding sphere and not a 14-unit floor.
     */
    const captureThumb = (assetId: string) => {
      if (importedGroup === null) return;
      const box = new THREE.Box3().setFromObject(importedGroup);
      if (box.isEmpty()) return;
      const sphere = box.getBoundingSphere(new THREE.Sphere());
      if (!Number.isFinite(sphere.radius) || sphere.radius <= 0) return;

      const dir = new THREE.Vector3(1, 0.72, 1).normalize();
      const dist = (sphere.radius / Math.sin((thumbCam.fov * Math.PI) / 360)) * 1.05;
      thumbCam.position.copy(sphere.center).addScaledVector(dir, dist);
      thumbCam.lookAt(sphere.center);
      thumbCam.near = Math.max(0.01, dist - sphere.radius * 3);
      thumbCam.far = dist + sphere.radius * 3;
      thumbCam.updateProjectionMatrix();

      const groundWas = ground.visible;
      const gridWas = grid.visible;
      ground.visible = false;
      grid.visible = false;
      /*
       * Shoot the model's OWN texture, whatever mode the viewport is in.
       * `renderMode` starts at 'clay' and only flips to 'textured' while the
       * user is on the texture stage, so a textured model that landed on any
       * other stage got a grey clay tile — the user: "textures don't show up often
       * when available in the thumbnails". The mode is a viewing choice about
       * the big viewport; a tile's job is to identify the asset, and it cannot
       * do that in the one colour every asset shares.
       */
      const swapped: [InstanceType<typeof THREE.Mesh>, unknown][] = [];
      for (const { mesh } of importedBodies) {
        const own = originalMaterials.get(mesh);
        if (own !== undefined && own !== mesh.material && hasTextureMaps(own)) {
          swapped.push([mesh, mesh.material]);
          mesh.material = own;
        }
      }
      const prevTarget = renderer.getRenderTarget();
      renderer.setRenderTarget(thumbTarget);
      renderer.render(scene, thumbCam);
      const pixels = new Uint8Array(THUMB_RENDER * THUMB_RENDER * 4);
      renderer.readRenderTargetPixels(thumbTarget, 0, 0, THUMB_RENDER, THUMB_RENDER, pixels);
      renderer.setRenderTarget(prevTarget);
      ground.visible = groundWas;
      grid.visible = gridWas;
      for (const [mesh, was] of swapped) {
        mesh.material = was as InstanceType<typeof THREE.Material>;
      }

      const full = document.createElement('canvas');
      full.width = THUMB_RENDER;
      full.height = THUMB_RENDER;
      const fctx = full.getContext('2d');
      if (fctx === null) return;
      const img = fctx.createImageData(THUMB_RENDER, THUMB_RENDER);
      // readRenderTargetPixels returns bottom-up; ImageData is top-down.
      const rowBytes = THUMB_RENDER * 4;
      for (let y = 0; y < THUMB_RENDER; y += 1) {
        const from = (THUMB_RENDER - 1 - y) * rowBytes;
        img.data.set(pixels.subarray(from, from + rowBytes), y * rowBytes);
      }
      fctx.putImageData(img, 0, 0);

      const out = document.createElement('canvas');
      out.width = THUMB_SIDE;
      out.height = THUMB_SIDE;
      const octx = out.getContext('2d');
      if (octx === null) return;
      octx.drawImage(full, 0, 0, THUMB_SIDE, THUMB_SIDE);
      /*
       * PNG, not JPEG. The renderer is `alpha: true` with no clear colour, so
       * the capture's background is genuinely TRANSPARENT — but JPEG has no
       * alpha channel and Chromium flattens it onto BLACK. Every asset card in
       * the grid was therefore a black slab, which is invisible in dark mode
       * and glaring under bobble-light / codex-light (a black square in an
       * otherwise white panel). PNG keeps the alpha so the card's own surface
       * shows through and the thumbnail re-tints with the theme for free.
       * Size is not a concern: thumbnails are session-only — viewer-io writes
       * `thumb: null` into localStorage precisely because they are heavy.
       */
      useTripoStore.getState().setAssetThumb(assetId, out.toDataURL('image/png'));
    };

    /**
     * KEEP A TRAVELLING CLIP IN SHOT.
     *
     * A typed prompt keeps its root motion on purpose — "walking forward
     * confidently" should walk forward, and the exported GLB must carry that
     * or the clip is not the one that was asked for. MEASURED on the ARDY walk:
     * the hips travel 3.617 units over 5.95s on a 1-unit-tall model, so the
     * character clears the framed view in under two seconds and the viewport
     * goes empty while the asset row, thumbnail and face count all say it
     * loaded. the user's rule for the presets — "letting it wander off across the
     * grid is how you lose sight of the thing you asked to see" — is about
     * exactly that, and it is no less true of a walk the user typed.
     *
     * So the DATA is left alone and the CAMERA moves instead: both the orbit
     * target and the eye shift by the same delta, which keeps whatever angle
     * and distance the user chose while the subject stays centred.
     */
    const travelPrev = new THREE.Vector3();
    let travelTracking: InstanceType<typeof THREE.Object3D> | null = null;
    const travelNow = new THREE.Vector3();
    const travelDelta = new THREE.Vector3();
    const followTravel = () => {
      if (travelTracking === null) return;
      travelTracking.getWorldPosition(travelNow);
      travelDelta.subVectors(travelNow, travelPrev);
      travelDelta.y = 0; // a bob is not travel; following it would make the shot seasick
      if (travelDelta.lengthSq() < 1e-10) return;
      camera.position.add(travelDelta);
      controls.target.add(travelDelta);
      travelPrev.copy(travelNow);
    };

    // ── render loop + frame/fps instrumentation (probe hooks) ───────────────
    const clock = new THREE.Clock();
    let raf = 0;
    let frames = 0;
    let fpsFrames = 0;
    let fpsLast = performance.now();
    const loop = () => {
      const dt = clock.getDelta();
      if (mixer !== null && useTripoStore.getState().pipelineStage === 'animate') {
        mixer.update(dt);
      }
      // The user's own clip plays in EVERY panel, not just Animate: they asked
      // for a moving character, and it should still be moving when they switch
      // to look at something else.
      if (importedMixer !== null) {
        importedMixer.update(dt);
        followTravel();
      }
      controls.update();
      renderer.render(scene, camera);
      syncGizmo();
      // Preview capture rides the frame right after the model became visible.
      if (pendingThumb !== null && frames >= 2) {
        const id = pendingThumb;
        if (importedGroup?.visible === true && importedId === id) {
          pendingThumb = null;
          captureThumb(id);
        }
      }
      frames += 1;
      fpsFrames += 1;
      const now = performance.now();
      if (now - fpsLast >= 500) {
        host.dataset.tpFps = String(Math.round((fpsFrames * 1000) / (now - fpsLast)));
        fpsFrames = 0;
        fpsLast = now;
      }
      // Signal readiness only once a real model has rendered a couple of frames.
      if ((heroLoaded || importedId !== null) && frames >= 2) host.dataset.tpCanvasReady = '1';
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    return () => {
      disposed = true;
      setViewerExportHandler(null);
      setPresetMotionHandler(null);
      cancelAnimationFrame(raf);
      unsubscribe();
      themeObserver.disconnect();
      ro.disconnect();
      panelRo?.disconnect();
      panelObserver.disconnect();
      controls.dispose();
      if (mixer !== null) mixer.stopAllAction();
      scene.traverse((o) => {
        const mesh = o as InstanceType<typeof THREE.Mesh>;
        const line = o as InstanceType<typeof THREE.LineSegments>;
        if (mesh.isMesh === true || line.isLine === true) {
          mesh.geometry?.dispose();
          const m = mesh.material as InstanceType<typeof THREE.Material> | undefined;
          if (Array.isArray(m)) for (const mm of m) mm.dispose();
          else m?.dispose();
        }
      });
      normalMat.dispose();
      clayMat.dispose();
      wireOverlayMat.dispose();
      segMat.dispose();
      texMat.dispose();
      generatedTexture.dispose();
      envTexture.dispose();
      thumbTarget.dispose();
      pmrem.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [gizmoRef]);

  return <div ref={hostRef} className="tp-canvas-host" data-testid="tp-canvas-host" />;
}
