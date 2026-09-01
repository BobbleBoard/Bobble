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
 */
import { GLTFLoader, OrbitControls, THREE } from '@pi-desktop/canvas/three';
import { type JSX, useEffect, useRef, useState } from 'react';

export interface ModelSurfaceProps {
  /** `pd-file://` URL of the .glb / .gltf. */
  readonly src: string;
  readonly testid?: string;
}

export function ModelSurface({ src, testid }: ModelSurfaceProps): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    let stopped = false;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    host.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
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

    scene.add(new THREE.HemisphereLight(0xffffff, 0x202020, 1.1));
    const key = new THREE.DirectionalLight(0xffffff, 1.9);
    key.position.set(3, 5, 3);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0xbfd4ff, 0.5);
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
        // A probe seam: framing is arithmetic on numbers only this closure has,
        // and reading them back beats inferring them from a screenshot.
        host.dataset.pdFraming = JSON.stringify({
          size: [size.x, size.y, size.z].map((n) => Math.round(n * 1000) / 1000),
          centre: [centre.x, centre.y, centre.z].map((n) => Math.round(n * 1000) / 1000),
          k: Math.round(k * 1000) / 1000,
          pos: [model.position.x, model.position.y, model.position.z].map(
            (n) => Math.round(n * 1000) / 1000,
          ),
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
      renderer.render(scene, camera);
      raf = requestAnimationFrame(tick);
    };
    tick();

    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      controls.dispose();
      renderer.dispose();
      renderer.domElement.remove();
      scene.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.geometry !== undefined) mesh.geometry.dispose?.();
        const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(mat)) for (const m of mat) m.dispose();
        else mat?.dispose();
      });
    };
  }, [src]);

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
