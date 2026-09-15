/**
 * Bobble 3D workspace — the full-app view mounted from the sidebar Modalities
 * entry (or `?tripo=1` / PI_DESKTOP_TRIPO=1 in dev).
 *
 * Layout: top bar / left tool rail / stage panel / 3D viewport / right panel.
 * Dropping a 3D model file (.glb/.gltf/.obj/.stl) ANYWHERE in the workspace
 * imports it: it lands in the viewport immediately and its rendered preview
 * appears in the Assets grid (captured by the viewer on its first frame).
 */

import type { JSX } from 'react';
import { useEffect, useState } from 'react';
import { exitModality } from '../state/modality-store';
import { useStudioHandoff } from '../state/studio-handoff';
import { GenPanel } from './GenPanel';
import { ensureGen3dWired, useGen3dStore } from './gen3d-client';
import { IcUpload } from './icons';
import { ModuleGate } from './ModuleGate';
import { moduleState } from './module-state';
import { Rail } from './Rail';
import { RightPanel } from './RightPanel';
import { useTripoStore } from './store';
import { Viewport } from './Viewport';
import {
  addInputImages,
  importModelFile,
  importModelPath,
  isImageFile,
  isModelFile,
} from './viewer-io';
import './tripo.css';

export function TripoWorkspace(): JSX.Element {
  const closeMenus = useTripoStore((s) => s.closeMenus);
  const [dropActive, setDropActive] = useState(false);
  /*
   * THE MODULE GATE. Without the 3D module the studio still MOUNTS and renders —
   * it is blurred behind a panel offering the download, and "View" lifts the
   * blur so the UI can be inspected. the user: not "gatekeeping the UI from being
   * seen at all as if it's a paid service".
   */
  const engineReady = useGen3dStore((s) => s.engineReady);
  const catalogLoaded = useGen3dStore((s) => s.loaded);
  const models = useGen3dStore((s) => s.models);
  const [viewing, setViewing] = useState(false);
  const engineBooting = useGen3dStore((s) => s.engineBooting);
  const comfy3d = useGen3dStore((s) => s.comfy);
  const module3d = moduleState(engineReady, models, engineBooting, comfy3d);
  /*
   * Gate only once the catalog has actually answered — flashing a download wall
   * during the sidecar's boot would be a lie that corrects itself a second
   * later. It ANSWERS immediately, though (the honest degraded catalog read off
   * the install stamps), which is why `catalogLoaded` alone was not enough: the
   * answer says "the engine is not up YET", and the studio read that as "not
   * available" on every launch. A boot in flight still holds the studio — it
   * genuinely cannot run anything yet — but the panel says it is starting rather
   * than offering to set up something already installed. See ModuleGate.
   */
  const gated = catalogLoaded && !module3d.usable && !viewing;

  // Engine catalog + event wiring (idempotent).
  useEffect(() => {
    ensureGen3dWired();
  }, []);

  /*
   * A MESH HANDED OVER FROM CHAT LOADS ITSELF.
   *
   * "Open in studio" on a 3D result switched the view and stopped there, which
   * is the emptiest possible version of the gesture. The import path is the one
   * a drop already uses, so the model lands in the viewport and its card
   * appears in Assets exactly as a dragged file's would — no second, parallel
   * "opened from chat" state to keep in step.
   *
   * Taken (not peeked) so it fires once: coming back to the studio later should
   * show what you left, not re-import the last thing you ever sent.
   */
  useEffect(() => {
    const handed = useStudioHandoff.getState().take('3d');
    if (handed === null) return;
    void importModelPath(handed.path, handed.name);
  }, []);

  // One global dismiss layer for every popover/dropdown: any pointerdown
  // outside a menu anchor closes the open menu; Escape peels the layers back
  // in stacking order — menu, then modal, then the full-viewport state-machine
  // editor.
  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target;
      if (target instanceof Element && target.closest('[data-tp-menu-root]') !== null) return;
      closeMenus();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const s = useTripoStore.getState();
      if (s.openMenu !== null) {
        s.closeMenus();
      } else if (s.modal !== null) {
        s.set('modal', null);
      } else if (s.graphOpen) {
        // The state-machine editor is an opaque, full-viewport overlay
        // (.tp-graph: position absolute, inset 0, z-index 100) but it lives in
        // its own `graphOpen` flag rather than in `modal`, so it was the one
        // dismissable layer in the studio that Escape did not reach — you had
        // to find the ✕. Every other overlay in the app closes on Escape.
        s.set('graphOpen', false);
      } else {
        /*
         * NOTHING LEFT TO DISMISS ⇒ LEAVE THE ROOM, like every other studio.
         *
         * The three StudioShell rooms have returned to the chat on Escape since
         * they stopped taking the window; this one peeled its own layers and
         * then stopped, so the 3D workspace was the one modality you could only
         * leave with the mouse. Found driving the round-2 handoff probe, which
         * pressed Escape to get back to the transcript and waited ten seconds
         * for a composer that was never coming.
         */
        exitModality();
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [closeMenus]);

  // OS file drops, hardened at the DOCUMENT level (capture phase): without the
  // dragover preventDefault Chromium/Electron NAVIGATES the window to the
  // dropped file (the "drag and drop doesn't work" failure — the React handler
  // on the root div can be bypassed when a child swallows the event). The
  // capture listeners always see the drag, always cancel navigation, and route
  // any model file through the same import path.
  useEffect(() => {
    const onDragOver = (e: DragEvent) => {
      if (e.dataTransfer !== null && Array.from(e.dataTransfer.types).includes('Files')) {
        e.preventDefault();
        setDropActive(true);
      }
    };
    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      setDropActive(false);
      const files = e.dataTransfer === null ? [] : Array.from(e.dataTransfer.files);
      // A dropped model goes to the viewport; dropped images become image→3D
      // inputs (shown in the input card). Model wins if both are present.
      const model = files.find(isModelFile);
      if (model !== undefined) {
        void importModelFile(model);
        return;
      }
      const images = files.filter(isImageFile);
      if (images.length > 0) addInputImages(images);
    };
    const onDragLeave = (e: DragEvent) => {
      // Leaving the window entirely (relatedTarget null) clears the overlay.
      if (e.relatedTarget === null) setDropActive(false);
    };
    document.addEventListener('dragover', onDragOver, true);
    document.addEventListener('drop', onDrop, true);
    document.addEventListener('dragleave', onDragLeave, true);
    return () => {
      document.removeEventListener('dragover', onDragOver, true);
      document.removeEventListener('drop', onDrop, true);
      document.removeEventListener('dragleave', onDragLeave, true);
    };
  }, []);

  return (
    // Drops are handled by the document-level capture listeners above; the
    // root only carries the drop-overlay state attribute.
    <div
      className="tp"
      data-testid="tp-root"
      data-drop-active={dropActive}
      data-module={module3d.status}
    >
      {/* The studio itself, blurred (and inert) while gated — never unmounted,
          so "View" is an instant unblur rather than a second load. */}
      <div
        className="tp-shell"
        data-testid="tp-shell"
        data-gated={gated}
        {...(gated ? { inert: true } : {})}
      >
        {/* No top bar of its own any more — the studio renders inside the app's
            chat surface now, and its two controls (Send To, Export) live in the
            app's top-right cluster. See TopBar.tsx. */}
        <div className="tp-body">
          <Rail />
          <GenPanel />
          <Viewport />
          <RightPanel />
        </div>
      </div>
      {gated ? <ModuleGate state={module3d} onView={() => setViewing(true)} /> : null}
      {/* Once someone chooses View, the studio is fully usable to look at, and a
          quiet strip keeps the download one click away rather than lost. */}
      {catalogLoaded && !module3d.usable && viewing ? (
        <button
          type="button"
          className="tp-gate-restore"
          data-testid="tp-gate-restore"
          onClick={() => setViewing(false)}
        >
          Viewing only. Download the 3D module
        </button>
      ) : null}
      {dropActive ? (
        <div className="tp-drop-overlay" data-testid="tp-drop-overlay">
          <div className="tp-drop-card">
            <IcUpload size={26} />
            Drop a model (.glb · .obj · .stl) or an image (.png · .jpg)
          </div>
        </div>
      ) : null}
    </div>
  );
}
