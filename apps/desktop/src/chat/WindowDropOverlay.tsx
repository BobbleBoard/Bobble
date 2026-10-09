/**
 * DRAGGING A FILE IN — a blue edge, not a modal.
 *
 * The user: "I don't like the drag and drop modal, it should just highlight the
 * border of the chat area in blue with a little inward going blue glow, if
 * hovering over any button on the left sidebar, act as if they were clicked on
 * and then the drag and drop occurred."
 *
 * The user is right about the modal and for the reason this app keeps relearning: a
 * covering card ANSWERS a question nobody asked ("where can I drop this?" — the
 * answer is "anywhere") while HIDING the one thing you were looking at, which is
 * the chat you are about to drop into. An edge glow says the same thing without
 * taking the screen.
 *
 * THE SIDEBAR HOVER is the better half of the idea. Holding a file over a chat
 * row opens that chat, so the drop lands where you are pointing — the file goes
 * to the conversation you meant rather than the one you happened to leave open.
 * The activation is the row's OWN click handler, so a row that opens a project,
 * a studio or a new chat all behave the way they already do.
 */
import { useEffect, useRef, useState } from 'react';
import { useDropStore } from './composer/drop-store';

/** True when the drag carries files (vs. text/element drags we should ignore). */
function dragHasFiles(e: DragEvent): boolean {
  const types = e.dataTransfer?.types;
  if (types === undefined) return false;
  return Array.from(types).includes('Files');
}

/** How long a file has to hover a sidebar row before it opens. Long enough that
 * crossing the sidebar on the way to the chat does not open four chats; short
 * enough that deliberately pointing at one feels immediate. */
const SPRING_MS = 650;

export function WindowDropOverlay() {
  const [active, setActive] = useState(false);
  const depth = useRef(0);
  /** The sidebar row currently being hovered, and when the hover started. */
  const spring = useRef<{ el: HTMLElement; timer: number } | null>(null);

  useEffect(() => {
    const clearSpring = () => {
      if (spring.current === null) return;
      window.clearTimeout(spring.current.timer);
      spring.current.el.removeAttribute('data-drag-over');
      spring.current = null;
    };

    const onEnter = (e: DragEvent) => {
      if (!dragHasFiles(e)) return;
      e.preventDefault();
      depth.current += 1;
      setActive(true);
    };

    const onOver = (e: DragEvent) => {
      if (!dragHasFiles(e)) return;
      e.preventDefault();
      /*
       * SPRING-LOADED SIDEBAR ROWS. `elementFromPoint` rather than the event
       * target, because the drop overlay's own edge sits above the sidebar and
       * would otherwise be the target for every move.
       */
      /*
       * ...EXCEPT WHILE A MESSAGE IS BEING EDITED. Springing to another chat
       * mid-edit would throw the edit away to deliver the file somewhere the
       * user was not looking. The claim that redirects the drop (drop-store) is
       * also the signal that leaving would cost something.
       */
      if (useDropStore.getState().claim !== null) {
        clearSpring();
        return;
      }
      const under = document.elementFromPoint(e.clientX, e.clientY);
      const row =
        under instanceof HTMLElement
          ? (under.closest(
              '.pd-sidebar [role="button"], .pd-sidebar button, .pd-sidebar-row',
            ) as HTMLElement | null)
          : null;
      if (row === null) {
        clearSpring();
        return;
      }
      if (spring.current?.el === row) return;
      clearSpring();
      row.setAttribute('data-drag-over', '');
      const timer = window.setTimeout(() => {
        // Act as if it were clicked, then let the drop land in whatever that
        // opened. The row keeps its highlight until the drag leaves it.
        row.click();
      }, SPRING_MS);
      spring.current = { el: row, timer };
    };

    const onLeave = (e: DragEvent) => {
      if (!dragHasFiles(e)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) {
        clearSpring();
        setActive(false);
      }
    };

    const onDrop = (e: DragEvent) => {
      depth.current = 0;
      clearSpring();
      setActive(false);
      if (!dragHasFiles(e)) return;
      e.preventDefault();
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (files.length > 0) useDropStore.getState().push(files);
    };

    window.addEventListener('dragenter', onEnter);
    window.addEventListener('dragover', onOver);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      clearSpring();
      window.removeEventListener('dragenter', onEnter);
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('dragleave', onLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, []);

  if (!active) return null;

  /* Nothing but an edge. `pointer-events: none` so the drag still reaches the
   * sidebar underneath — the glow must not become the thing you are dropping on. */
  return <div className="pd-drop-glow" data-testid="window-drop-overlay" aria-hidden />;
}
