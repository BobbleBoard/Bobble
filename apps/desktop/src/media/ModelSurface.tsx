/**
 * A GENERATED MESH, TURNABLE WHERE IT WAS MADE.
 *
 * WHY NOT `Viewer3D`. The studio's viewer is 1400 lines and is the studio: it
 * owns the retopo overlays, the skeleton, the export menu, the segment picker
 * and a good deal of workspace state. Mounting it inside a chat bubble would
 * drag all of that in, and none of it is what a card needs. A card needs the
 * mesh, a ground you can read the orientation against, and a way to turn it.
 *
 * So this is deliberately small and self-contained — load, frame, grid, orbit —
 * and the button in the corner hands you off to the real thing when the card is
 * not enough. That is also why the button exists: an inline preview that cannot
 * escalate is a dead end.
 *
 * THE FEW CONTROLS. the user (2026-09-17): "not all the controls but below the
 * card itself show some basic controls eg. coloring/normals/grey, if rig,
 * skeleton and if segment, then explode." They live in a {@link ModelView}
 * the card owns (model-view.ts): the strip under the card writes it, this
 * viewport applies it — the file's own materials, a normal material or the
 * studio's clay; the rig drawn through the surface; the engine's parts pushed
 * apart from the centre — and reports back what the file actually has, so the
 * strip never offers a Skeleton for a model without one.
 */
import { GLTFLoader, OrbitControls, RoomEnvironment, THREE } from '@pi-desktop/canvas/three';
import { type JSX, useEffect, useMemo, useRef, useState } from 'react';
import { disableMipmaps } from '../tripo/atlas-textures';
import { countParts, createModelView, fileFacts, type ModelView } from './model-view';

export interface ModelSurfaceProps {
  /** `pd-file://` URL of the .glb / .gltf. */
  readonly src: string;
  readonly testid?: string;
  /** The controls' state, when the card draws a strip for them. */
  readonly view?: ModelView;
}

type Mesh = InstanceType<typeof THREE.Mesh>;
type Material = InstanceType<typeof THREE.Material>;

/** How far apart Explode pushes the parts, as a fraction of the model's span. */
const EXPLODE_SPREAD = 0.24;

export function ModelSurface({ src, testid, view: given }: ModelSurfaceProps): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // A surface with no strip (the expanded stage without one) still needs a
  // view to apply; a private one is the file's own defaults.
  const own = useMemo(() => createModelView(), []);
  const view = given ?? own;

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    let stopped = false;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    /*
     * LIT THE WAY THE STUDIO LIGHTS IT. the user (2026-09-18), on a card: "what's
     * with this artifacting" — the same file was clean in the 3D studio. The
     * flecks themselves were the culling (see the material note below);
     * what remained after that was a model that read dark and flat here and
     * bright there, because a baked PBR material under three lights and no
     * environment is a different picture from one under the studio's image-
     * based light and ACES. Same environment, same tone mapping, same
     * exposure, so a model looks like ITSELF in both rooms.
     */
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    host.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const pmrem = new THREE.PMREMGenerator(renderer);
    const envTexture = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environment = envTexture;
    const camera = new THREE.PerspectiveCamera(38, 1, 0.05, 100);
    camera.position.set(2.4, 1.5, 3.4);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    // No panning and no zooming past the model: a card is a turntable, not a
    // workspace, and a viewer you can lose the subject in is worse than a still.
    controls.enablePan = false;
    controls.minDistance = 1.2;
    controls.maxDistance = 9;

    // The studio's rig, minus its shadows: hemisphere fill, warm key, cool rim.
    scene.add(new THREE.HemisphereLight(0xffffff, 0x222222, 0.5));
    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(3, 5, 3);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0xffffff, 1.1);
    rim.position.set(-3, 2, -3);
    scene.add(rim);

    /*
     * THE GRID IS NOT DECORATION. the user asked for it, and the reason it matters
     * on a small canvas is that a mesh floating in void has no scale and no
     * horizon — you cannot tell a turn from a tilt. The grid gives the eye a
     * ground plane to read the rotation against.
     */
    const grid = new THREE.GridHelper(8, 16, 0x8a8a8a, 0x4a4a4a);
    const gm = grid.material as THREE.Material & { opacity: number; transparent: boolean };
    gm.transparent = true;
    gm.opacity = 0.28;
    scene.add(grid);

    /*
     * THE THREE SHADINGS. "Color" is the file's own materials — the bake, or
     * the vertex colours a segmentation paints (the loader sets vertexColors
     * for COLOR_0 itself). Normals and Grey are one shared material each;
     * Grey is the studio's clay, the same fixed warm white so the two rooms
     * agree on what "grey" looks like.
     */
    const normalMat = new THREE.MeshNormalMaterial({ side: THREE.DoubleSide });
    const clayMat = new THREE.MeshStandardMaterial({
      color: '#d9d9de',
      metalness: 0.02,
      roughness: 0.85,
      side: THREE.DoubleSide,
    });
    const bodies: { mesh: Mesh; own: Material | Material[] }[] = [];
    let skeleton: InstanceType<typeof THREE.SkeletonHelper> | null = null;
    /** A bead on every joint, beside the helper's 1px bones (WebGL draws
     * lines one pixel wide whatever is asked; on a 330px card a rig drawn as
     * hairlines is a rig you have to take on trust). */
    const joints: Mesh[] = [];
    /** Each engine part with where it sits and which way Explode sends it. */
    const parts: { mesh: Mesh; base: THREE.Vector3; offset: THREE.Vector3 }[] = [];
    let explodeNow = 0;
    let explodeTarget = 0;

    const applyView = (): void => {
      const s = view.get();
      for (const { mesh, own } of bodies) {
        mesh.material = s.shading === 'normals' ? normalMat : s.shading === 'grey' ? clayMat : own;
      }
      if (skeleton !== null) skeleton.visible = s.skeleton;
      for (const bead of joints) bead.visible = s.skeleton;
      explodeTarget = s.explode ? 1 : 0;
      host.dataset.pdShading = s.shading;
      host.dataset.pdSkeleton = String(s.skeleton && skeleton !== null);
      host.dataset.pdExplode = String(s.explode && parts.length > 0);
    };
    const unsubscribe = view.subscribe(applyView);

    const resize = (): void => {
      const w = host.clientWidth;
      const h = host.clientHeight;
      if (w === 0 || h === 0) return;
      /*
       * `updateStyle` LEFT ON, and that is the whole bug this line once had.
       *
       * With `setSize(w, h, false)` three.js sizes the drawing buffer and leaves
       * the canvas's CSS size alone — which means the canvas takes its width and
       * height ATTRIBUTES as its CSS size. At devicePixelRatio 2 those are twice
       * the host, so the canvas rendered at 804×636 inside a 402×318 card and we
       * were looking at its top-left quarter: the grid ran off the bottom-right
       * and the model sat outside the frame entirely. The framing arithmetic was
       * right the whole time, which is why it survived two readings.
       */
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(host);

    new GLTFLoader().load(
      src,
      (gltf) => {
        if (stopped) return;
        const model = gltf.scene;
        /*
         * FRAME IT, rather than trusting the file's own scale. A TRELLIS mesh
         * arrives around unit size and a scanned OBJ can arrive in millimetres;
         * a fixed camera shows the first and misses the second entirely.
         */
        const box = new THREE.Box3().setFromObject(model);
        const size = box.getSize(new THREE.Vector3());
        const centre = box.getCenter(new THREE.Vector3());
        const span = Math.max(size.x, size.y, size.z) || 1;
        const k = 1.6 / span;
        model.scale.setScalar(k);
        model.position.sub(centre.multiplyScalar(k));
        // Sit it ON the grid rather than through it.
        const half = (size.y * k) / 2;
        model.position.y += half;
        scene.add(model);
        /*
         * AND LOOK AT IT. Lifting the mesh onto the grid moves its middle above
         * the origin, so a camera still aimed at (0,0,0) frames the floor with
         * the subject riding the top edge — which is exactly what it did.
         * Orbiting around the model's own centre is also what makes the drag
         * feel like turning an object rather than swinging past one.
         */
        controls.target.set(0, half, 0);
        /*
         * Distance chosen from the frustum rather than by eye: at fov 38° the
         * visible height is 2·d·tan(19°) ≈ 0.69·d, so d ≈ 3.5 puts a 1.6-unit
         * subject across about two thirds of a card this shape. Further out and
         * the mesh is a detail in a field of grid.
         */
        camera.position.set(1.95, half + 0.9, 2.77);
        controls.update();

        /*
         * WHAT THE FILE HAS. Every body keeps its own material (Color); a
         * skinned body means a rig, drawn with a SkeletonHelper that reads
         * THROUGH the surface (depthTest off — a skeleton hidden inside an
         * opaque body is the same as no skeleton); the engine's `part_NN_*`
         * bodies are what Explode moves.
         */
        model.updateMatrixWorld(true);
        const names: string[] = [];
        let skinned = false;
        model.traverse((o) => {
          const mesh = o as Mesh;
          if ((mesh as { isMesh?: boolean }).isMesh !== true) return;
          const own = mesh.material as Material | Material[];
          /* THE FILE'S MATERIAL, TREATED AS THE STUDIO TREATS IT (Viewer3D):
             DOUBLE-SIDED — a generated mesh always carries some inconsistently
             wound triangles (marching cubes emits them, decimation flips more),
             and each one culled is a hole onto the dark ground, or onto the lit
             inside of the surface behind it: the black and white specks.
             MEASURED by ablation 2026-09-18: this line alone took every fleck
             off a clean-atlas bake (385fa85ad18b); the environment above only
             changed the brightness. And NO MIP CHAIN (atlas-textures.ts): a
             TRELLIS atlas is a chart per triangle, and at a size where each
             triangle is a pixel the GPU sits on a mip level where every texel
             averages hundreds of unrelated charts — the studio's measured case. */
          for (const mat of Array.isArray(own) ? own : [own]) {
            mat.side = THREE.DoubleSide;
            disableMipmaps(mat);
          }
          bodies.push({ mesh, own });
          names.push(mesh.name);
          if ((mesh as { isSkinnedMesh?: boolean }).isSkinnedMesh === true) skinned = true;
          /* A mesh with no NORMAL attribute is BLACK under Normals and Grey —
             there is nothing to light — while the file's own unlit material
             hid it. SEEN on an engine bake: a black silhouette the moment the
             strip left Color. The studio computes them too (Viewer3D). */
          if (mesh.geometry.getAttribute('normal') === undefined) {
            mesh.geometry.computeVertexNormals();
          }
          /* A skinned body is culled against its bind pose's bounds; the rig
             drawn through it is the point of the card, so never cull it away. */
          if ((mesh as { isSkinnedMesh?: boolean }).isSkinnedMesh === true) {
            mesh.frustumCulled = false;
          }
        });
        if (skinned) {
          const helper = new THREE.SkeletonHelper(model);
          const mat = helper.material as InstanceType<typeof THREE.LineBasicMaterial>;
          mat.depthTest = false;
          mat.transparent = true;
          // One solid colour, not the helper's per-bone blue→green gradient,
          // which reads as two faint hues over a grey body.
          mat.vertexColors = false;
          mat.color.set(0x4ade80);
          mat.needsUpdate = true;
          helper.renderOrder = 999;
          helper.visible = false;
          scene.add(helper);
          skeleton = helper;
          // Sized in WORLD units: a child of a bone inherits the model's
          // framing scale, so a bead of fixed radius would be a boulder on a
          // model that arrived in millimetres and a speck on one in metres.
          const beadGeo = new THREE.SphereGeometry(0.022 / k, 10, 8);
          const beadMat = new THREE.MeshBasicMaterial({
            color: 0x4ade80,
            depthTest: false,
            transparent: true,
          });
          for (const bone of helper.bones) {
            const bead = new THREE.Mesh(beadGeo, beadMat);
            bead.renderOrder = 1000;
            bead.frustumCulled = false;
            bead.visible = false;
            bone.add(bead);
            joints.push(bead);
          }
        }
        const partCount = countParts(names);
        if (partCount >= 2) {
          const modelCentre = new THREE.Vector3(0, half, 0);
          for (const { mesh } of bodies) {
            if (!/^part_\d+/i.test(mesh.name)) continue;
            const pc = new THREE.Box3().setFromObject(mesh).getCenter(new THREE.Vector3());
            const dir = pc.clone().sub(modelCentre);
            if (dir.lengthSq() < 1e-8) dir.set(0, 1, 0);
            dir.normalize();
            const parent = mesh.parent ?? model;
            const localBase = parent.worldToLocal(modelCentre.clone());
            const localTarget = parent.worldToLocal(
              modelCentre.clone().add(dir.multiplyScalar(1.6 * EXPLODE_SPREAD)),
            );
            parts.push({
              mesh,
              base: mesh.position.clone(),
              offset: localTarget.sub(localBase),
            });
          }
        }
        fileFacts(view, { hasSkeleton: skinned, parts: partCount });
        applyView();
        // A probe seam: framing is arithmetic on numbers only this closure has,
        // and reading them back beats inferring them from a screenshot.
        host.dataset.pdFraming = JSON.stringify({
          size: [size.x, size.y, size.z].map((n) => Math.round(n * 1000) / 1000),
          centre: [centre.x, centre.y, centre.z].map((n) => Math.round(n * 1000) / 1000),
          k: Math.round(k * 1000) / 1000,
          pos: [model.position.x, model.position.y, model.position.z].map(
            (n) => Math.round(n * 1000) / 1000,
          ),
          bodies: bodies.length,
          skinned,
          parts: partCount,
        });
        setLoading(false);
      },
      undefined,
      () => {
        if (!stopped) {
          setError('could not read this model');
          setLoading(false);
        }
      },
    );

    let raf = 0;
    const tick = (): void => {
      controls.update();
      // Explode eases rather than snaps: the parts are seen to come apart, so
      // what moved from where is legible.
      if (explodeNow !== explodeTarget) {
        explodeNow += (explodeTarget - explodeNow) * 0.14;
        if (Math.abs(explodeTarget - explodeNow) < 0.004) explodeNow = explodeTarget;
        for (const p of parts) {
          p.mesh.position.copy(p.base).addScaledVector(p.offset, explodeNow);
        }
      }
      renderer.render(scene, camera);
      raf = requestAnimationFrame(tick);
    };
    tick();

    return () => {
      stopped = true;
      unsubscribe();
      cancelAnimationFrame(raf);
      ro.disconnect();
      controls.dispose();
      renderer.dispose();
      renderer.domElement.remove();
      normalMat.dispose();
      clayMat.dispose();
      envTexture.dispose();
      pmrem.dispose();
      scene.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.geometry !== undefined) mesh.geometry.dispose?.();
        const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(mat)) for (const m of mat) m.dispose();
        else mat?.dispose();
      });
      for (const { own } of bodies) {
        if (Array.isArray(own)) for (const m of own) m.dispose();
        else own.dispose();
      }
    };
  }, [src, view]);

  return (
    <div className="pd-media-model" data-testid={testid}>
      <div ref={hostRef} className="pd-media-model-host" />
      {loading && error === null ? <span className="pd-media-model-note">Loading…</span> : null}
      {error !== null ? (
        <span className="pd-media-model-note" data-error="true">
          {error}
        </span>
      ) : null}
    </div>
  );
}
